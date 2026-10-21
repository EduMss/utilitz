/* =========================================================
   Núcleo de logs de linha (página /logs)

   Módulo puro: não toca no DOM, para que o mesmo código rode
   no navegador e nos testes de `scripts/test-log-core.js`.

   Lê arquivos de log em linhas e devolve um array de registros
   planos (objetos coluna → valor), na ordem do arquivo:

   - iis   IIS em formato W3C: diretivas #Software/#Date mais a
           lista #Fields (que pode se repetir entre segmentos,
           inclusive com campos diferentes). Um registro por
           linha de dado; "date" + "time" viram a coluna datahora
           (Date local) e "-" vira célula vazia;
   - pm2   Saída do pm2/Nest: cores ANSI são tiradas e a linha
           "[Nest] 22796   - 16/10/2026, 14:39:57   [Módulo]
           mensagem +2ms" vira colunas origem, pid, datahora,
           modulo, mensagem e delta_ms. O SQL do Sequelize
           ("Executing (default): …"), que vem na linha seguinte
           sem carimbo, é colado no registro anterior na coluna
           sql (ou vira registro próprio se não houver anterior);
   - nginx Linhas do nginx: acesso em formato combined ("ip - - [16/
           Oct/2026:19:43:38 +0000] \"GET /versao.json HTTP/1.1\" 200 21
           \"-\" \"axios/0.19.2\"") vira ip, usuario, datahora (com o
           fuso da linha descontado), metodo, rota, protocolo, status,
           bytes, referer e user_agent; e o log de erro do stderr
           ("2026/10/19 14:14:39 [warn] 34#34: *80662 an upstream …,
           client: …, server: …, request: \"POST …\"") vira datahora,
           severidade, pid/tid, conexao, mensagem, ip, servidor e pedido
           partido em metodo/rota/protocolo;
   - docker Embrulho do docker (logs em JSON): cada linha física é
           {"log":"…\n","stream":"stdout","time":"…"} — o conteúdo de
           "log" é classificado pelos formatos de cima e o registro
           ganha as colunas stream e time (Data);
   - genérico  Linha com carimbo no começo (ISO "2026-10-20
           13:37:12" ou brasileiro "16/10/2026, 14:39:57") vira
           datahora + modulo ("[contexto] ") + mensagem; linha
           sem carimbo é anexada à mensagem do registro anterior
           (rastro de pilha) ou abre um registro solto.

   A escolha vai por linha: arquivos mistos saem de uma vez.
   ========================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDLogCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const ANSI = /\u001B\[[0-9;]*[a-zA-Z]/g;

  function limparAnsi(linha) {
    return linha.replace(ANSI, '').replace(/\r$/, '');
  }

  /* pm2/Nest: cabeya = match de NEST_CABECA. */
  const NEST_CABECA = /^\[([^\[\]]+)\]\s+([^\s\[\]]+)\s*-\s*(?:(\d{1,2}\/\d{1,2}\/\d{4})[,;]?\s*)?(\d{1,2}:\d{2}:\d{2})\s*(.*)$/;
  const NEST_MODULO = /^\[([^\]\[]*)\]\s*(.*)$/s;
  const DESVIO = /\s\+(\d+(?:[.,]\d+)?)(ms|s)\s*$/;

  /* Carimbo sozinho no começo da linha: ISO ou brasileiro. */
  const TSP_ISO = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s*(.*)$/;
  const TSP_BR = /^(\d{1,2}\/\d{1,2}\/\d{4})[,]?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s+(.*)$/;

  /* SQL do Sequelize na saída do pm2. */
  const SQL_SEQUELIZE = /^Executing \(default\):\s*(.*\S)\s*$/;

  /* Abre a lista de campos do IIS. */
  const IIS_FIELDS = /^#Fields:\s*(\S.*)$/;
  const IIS_DIRETIVA = /^#/;

  /* ------------------------------------------------------------ */

  function dataHoraBrasileira(dataBruta, horaBruta) {
    const [d, m, a] = dataBruta.split('/');
    const [h, mi, s] = (horaBruta + ':00:00').split(':');
    return new Date(Number(a), Number(m) - 1, Number(d), Number(h) % 24, Number(mi), Number(s));
  }

  /* "date time" do IIS → um datahora só; "-" vira célula vazia. */
  function linhaIis(valores, campos) {
    const saida = {};
    if (valores.date !== undefined && valores.time !== undefined) {
      saida.datahora = new Date(valores.date + 'T' + (valores.time.length === 5 ? valores.time + ':00' : valores.time));
      delete valores.date;
      delete valores.time;
    }
    for (const campo of campos) {
      const valor = valores[campo];
      if (valor === undefined || valor === '-') continue;
      saida[campo] = valor;
    }
    return saida;
  }

  function linhaNest(match, resto) {
    const [, origem, pid, dataBruta, horaBruta] = match;
    const linha = { origem, pid: Number(pid) };
    const [d, m, a] = dataBruta ? dataBruta.split('/') : [1, 1, 1970];
    const [h, mi, s] = horaBruta.split(':').map(Number);
    linha.datahora = new Date(Number(a), Number(m) - 1, Number(d), h || 0, mi || 0, s || 0);

    const modulo = NEST_MODULO.exec(resto || '');
    let mensagem;
    if (modulo) {
      if (modulo[1]) linha.modulo = modulo[1];
      mensagem = modulo[2];
    } else {
      mensagem = resto;
    }
    const desvio = DESVIO.exec(mensagem || '');
    if (desvio) {
      linha.delta_ms = desvio[2] === 'ms' ? Number(desvio[1]) : Number(desvio[1]) * 1000;
      mensagem = mensagem.slice(0, desvio.index);
    }
    if (mensagem) linha.mensagem = mensagem;
    return linha;
  }

  /* ------------------------------------------------------------
     Nginx: acesso em formato combined e log de erro do container
     ------------------------------------------------------------ */

  /* "192.168.112.1 - - [16/Oct/2026:19:43:38 +0000] \"GET /versao.json
     HTTP/1.1\" 200 21 \"-\" \"axios/0.19.2\" \"-\"" (o par extra do fim,
     tipo X-Forwarded-For, é opcional). */
  const NGINX_ACESSO = /^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"(?:\s+"([^"]*)")?/;
  /* "2026/10/19 14:14:39 [warn] 34#34: *80662 an upstream response …,
     client: 10.0.8.4, server: frontend, request: \"POST /…\"" */
  const NGINX_ERRO = /^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[([a-z]+)\]\s+(?:(\d+#\d+):\s*)?(?:\*(\d+)\s*)?(.*)$/;
  const MESES = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

  /* "16/Oct/2026:19:43:38 +0000" — o instante certo, descontando o fuso. */
  function dataHoraNginx(timeLocal) {
    const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?/.exec(timeLocal);
    if (!m) return timeLocal;
    const instante = Date.UTC(
      Number(m[3]), MESES[m[2]] || 0, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])
    );
    const desvio = m[7]
      ? (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]))
      : 0;
    return new Date(instante - desvio * 60 * 1000);
  }

  /* "GET /versao.json HTTP/1.1" → metodo, rota e protocolo colunas. */
  function partirPedido(pedido) {
    const saida = {};
    const partes = pedido.split(/\s+/);
    if (partes.length >= 2 && partes[1]) {
      saida.metodo = partes[0];
      saida.rota = partes[1];
      if (partes[2]) saida.protocolo = partes[2];
    } else if (partes[0]) {
      saida.rota = partes[0];
    }
    return saida;
  }

  function linhaNginxAcesso(match) {
    const [, ip, ident, usuario, tempo, pedido, status, bytes, referer, agente] = match;
    const linha = {};
    if (ip !== '-') linha.ip = ip;
    if (ident !== '-') linha.ident = ident;
    if (usuario !== '-') linha.usuario = usuario;
    linha.datahora = dataHoraNginx(tempo);
    Object.assign(linha, partirPedido(pedido));
    linha.status = Number(status);
    if (bytes !== '-') linha.bytes = Number(bytes);
    if (referer !== '-') linha.referer = referer;
    if (agente !== '-') linha.user_agent = agente;
    return linha;
  }

  /* "2026/10/19 14:14:39" sem fuso — fica como hora local. */
  function dataHoraLocalDoArquivo(pedaco) {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(pedaco.trim());
    if (!m) return pedaco;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }

  function linhaNginxErro(match) {
    const [, tempo, severidade, worker, conexao, corpo] = match;
    const linha = { datahora: dataHoraLocalDoArquivo(tempo), severidade };
    if (worker) {
      const [pidBruto, tidBruta] = worker.split('#');
      linha.pid = Number(pidBruto);
      if (tidBruta) linha.tid = Number(tidBruta);
    }
    if (conexao) linha.conexao = Number(conexao);
    linha.mensagem = corpo;
    const cliente = /client:\s*(\S+?)(?=, |$)/.exec(corpo);
    if (cliente) linha.ip = cliente[1];
    const servidor = /server:\s*(\S+?)(?=, |$)/.exec(corpo);
    if (servidor) linha.servidor = servidor[1];
    const pedido = /request:\s*"([^"]*)"/.exec(corpo);
    if (pedido) Object.assign(linha, partirPedido(pedido[1]));
    return linha;
  }

  /* ------------------------------------------------------------
     Docker: cada linha é um JSON {"log":"…\n","stream":"stdout",
     "time":"2026-10-16T19:43:38.515002172Z"}; o conteúdo real do
     nginx (ou de qualquer app do container) vive dentro de "log".
     ------------------------------------------------------------ */

  /* Devolve { conteudo, stream, time } ou null quando não é do Docker. */
  function abrirDocker(linha) {
    if (linha.charAt(0) !== '{' || linha.indexOf('"log"') < 0) return null;
    let obj;
    try { obj = JSON.parse(linha); } catch (err) { return null; }
    if (!obj || typeof obj.log !== 'string') return null;
    if (typeof obj.stream !== 'string' && typeof obj.time !== 'string') return null;
    return {
      conteudo: obj.log.replace(/\n$/, ''),
      stream: typeof obj.stream === 'string' ? obj.stream : undefined,
      time: desserializarDockerTempo(obj.time),
    };
  }

  /* A "time" do Docker pode ter nanossegundos; Date nova corta o resto. */
  function desserializarDockerTempo(bruto) {
    if (typeof bruto !== 'string') return bruto;
    const data = new Date(bruto);
    return isNaN(data.getTime()) ? bruto : data;
  }

  /* Linha vinda com carimbo próprio (pm2 de erro e parentes). */  function linhaComCarimbo(match, brasileira) {
    const resto = brasileira ? match[3] : match[2];
    const saida = {
      datahora: brasileira
        ? dataHoraBrasileira(match[1], match[2])
        : new Date(match[1]),
    };
    const modulo = NEST_MODULO.exec(resto || '');
    if (modulo && modulo[1]) {
      saida.modulo = modulo[1];
      if (modulo[2]) saida.mensagem = modulo[2];
    } else if (resto) {
      saida.mensagem = resto;
    }
    return saida;
  }

  /* JSON cada vez que vem ({…}) e parseia como objeto — não é continuação. */
  function jsonSolto(linha) {
    if (linha.charAt(0) !== '{') return false;
    try { return JSON.parse(linha) != null; } catch (err) { return false; }
  }

  /* IIS: "#Fields:" presente, a cara do pm2/Nest, SQL do Sequelize, o JSON
     do Docker ou linhas do nginx (acesso combined ou log de erro). */
  function isTextoLinhasLog(texto) {
    const trinca = String(texto != null ? texto : '').slice(0, 5000);
    return (
      /^#(?:Software|Version|Date|Fields):/m.test(trinca) ||
      /\u001B\[[0-9;]*m/.test(trinca) ||
      /^Executing \(default\):/m.test(trinca) ||
      /\[[^\[\]]+\]\s+[\w.-]+\s+-\s+\d{1,2}\/\d{1,2}\/\d{4},?\s*\d{1,2}:\d{2}:\d{2}/.test(trinca) ||
      /^\s*\{"log":"/m.test(trinca) ||
      /,"stream":"(?:stdout|stderr)","time":"/.test(trinca) ||
      /^\d{1,3}(?:\.\d{1,3}){3}\s+\S+\s+\S+\s+\[[^\]]+\]\s+"[^"]*"/m.test(trinca) ||
      /^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[(?:emerg|alert|crit|crit|error|warn|notice|info|debug)\]/m.test(trinca)
    );
  }

  /* Do texto cru para registros planos. Lança quando nada bate. */
  function parsearLinhasLog(texto) {
    const limpas = String(texto != null ? texto : '').split('\n').map(limparAnsi);
    const saida = [];
    let camposIis = null;
    let anterior = null;
    let quadro = null; /* dados do embrulho Docker da linha física vigente */

    /* Empurra um registro novo casando o embrulho do Docker (stream/time),
       que vale para o primeiro registro nascido daquela linha física. */
    const empurrar = (registro) => {
      if (quadro) {
        if (typeof quadro.stream === 'string') registro.stream = quadro.stream;
        if (quadro.time !== undefined) registro.time = quadro.time;
      }
      saida.push(registro);
      anterior = registro;
      return registro;
    };

    for (let i = 0; i < limpas.length; i++) {
      const bruta = limpas[i].replace(/\s+$/, '');
      let linha = bruta.trim();
      if (!linha) continue;

      /* Embrulho do Docker JSON: destrincha e classifica o conteúdo de "log". */
      quadro = (linha.charAt(0) === '{') ? abrirDocker(linha) : null;
      if (quadro) {
        linha = quadro.conteudo;
        linha = linha.replace(/\s+$/, '').trim();
        if (!linha) { quadro = null; continue; }
      } else {
        /* JSON solto (NDJSON dentro de um .log, sem "log" do Docker):
           linha própria, não é continuação do rastro anterior. */
        if (jsonSolto(linha)) {
          empurrar({ mensagem: linha });
          continue;
        }
        quadro = null;
      }

      /* Diretivas do IIS: renova a lista de campos vigente. */
      if (IIS_DIRETIVA.test(linha)) {
        const fields = IIS_FIELDS.exec(linha);
        if (fields) camposIis = fields[1].trim().split(/\s+/);
        continue;
      }

      /* SQL do Sequelize: gruda no registro anterior. */
      const sql = SQL_SEQUELIZE.exec(linha);
      if (sql) {
        if (anterior) {
          anterior.sql = anterior.sql ? anterior.sql + ' ' + sql[1] : sql[1];
          continue;
        }
        /* Sem anterior (acordei no meio do log): registro próprio. */
        empurrar({ sql: sql[1] });
        continue;
      }

      /* Dado do IIS: nº de tokens casando com #Fields (±1 por paciência). */
      if (camposIis) {
        const pedacos = linha.split(/\s+/);
        if (pedacos.length >= camposIis.length - 1 && pedacos.length <= camposIis.length + 1) {
          const valores = {};
          for (let j = 0; j < camposIis.length; j++) {
            const valor = pedacos[j];
            valores[camposIis[j]] = valor === undefined ? null : valor;
          }
          empurrar(linhaIis(valores, camposIis));
          continue;
        }
      }

      /* Acesso do nginx (combined: ip, pedido, status, referer, agente...). */
      const acesso = NGINX_ACESSO.exec(linha);
      if (acesso) {
        empurrar(linhaNginxAcesso(acesso));
        continue;
      }

      /* Log de erro do nginx (stderr do container). */
      const erro = NGINX_ERRO.exec(linha);
      if (erro) {
        empurrar(linhaNginxErro(erro));
        continue;
      }

      /* pm2/Nest com pid. */
      const nest = NEST_CABECA.exec(linha);
      if (nest) {
        empurrar(linhaNest(nest, nest[5]));
        continue;
      }

      /* Carimbo sozinho no começo da linha. */
      const iso = TSP_ISO.exec(linha);
      if (iso) {
        empurrar(linhaComCarimbo(iso, false));
        continue;
      }
      const br = TSP_BR.exec(linha);
      if (br) {
        empurrar(linhaComCarimbo(br, true));
        continue;
      }

      /* Sem carimbo: rastro de pilha ou linha solta — anexa ao anterior,
         preservando o recuo (importante para ler "at ..."). */
      if (anterior) {
        anterior.mensagem = anterior.mensagem ? anterior.mensagem + '\n' + bruta : bruta;
      } else {
        empurrar({ mensagem: bruta });
      }
    }

    if (!saida.length) throw new Error('nenhuma linha de log reconhecível no conteúdo');
    return saida;
  }

  return {
    limparAnsi,
    linhaIis,
    linhaNest,
    linhaNginxAcesso,
    linhaNginxErro,
    abrirDocker,
    linhaComCarimbo,
    isTextoLinhasLog,
    parsearLinhasLog,
  };
});
