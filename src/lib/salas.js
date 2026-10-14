'use strict';

/**
 * Salas temporárias: bloco de notas e drive compartilhados.
 *
 * As salas vivem na memória do processo e somem junto com ele — são
 * descartáveis por definição. O texto da nota é pequeno e fica junto da sala.
 * Já os arquivos do drive vão para o disco: o upload chega em fluxo e nunca
 * passa pela RAM inteira, então o limite por arquivo não vira pressão de
 * memória, e gravar direto no disco deixa a limpeza trivial (remover a
 * referência e apagar o arquivo). Se o processo cair no meio, o diretório
 * é varrido na subida.
 *
 * Regras de vida:
 *  - a sala de notas expira `ttlNotaMs` depois da criação ou da última
 *    edição — entrar na sala e só olhar NÃO renova o relógio;
 *  - o arquivo expira `ttlArquivoMs` contados A PARTIR DO FIM do upload;
 *  - enquanto houver download em andamento, a exclusão do arquivo espera —
 *    a resposta aberta é a única referência que o servidor não pode tirar
 *    do ar no meio do caminho. Se a conexão travar, um temporizador de
 *    segurança (outro prazo cheio) força a exclusão.
 *
 * Senhas nunca são guardadas: só o hash com o suco da própria sala, e a
 * comparação usa `timingSafeEqual`.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIPOS = { NOTAS: 'notas', DRIVE: 'drive' };

/** Erro com status HTTP: o tratador de erros do Express devolve `err.status`. */
function erroDe(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function hashSenha(senha, id) {
  return crypto.createHash('sha256').update(String(senha) + '\u0000' + id).digest('hex');
}

function senhaConfere(senha, hash, id) {
  const calculado = Buffer.from(hashSenha(senha, id), 'utf8');
  const guardado = Buffer.from(hash, 'utf8');
  return calculado.length === guardado.length && crypto.timingSafeEqual(calculado, guardado);
}

/** Id curto, URL-safe e sem chance de colidir com a sala vizinha. */
function novoId() {
  return crypto.randomBytes(6).toString('base64url');
}

/** "25 MB", "0,4 MB"… para as mensagens de limite. */
function formatarTamanho(bytes) {
  const mb = bytes / (1024 * 1024);
  const texto = mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  return texto.replace('.', ',') + ' MB';
}

/** Nome de arquivo só para exibição: sem controle, sem caminho, sem exagero. */
function nomeLimpo(nome) {
  const base = path.basename(String(nome || '')).replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (base || 'arquivo').slice(0, 180);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlNotaMs]      vida da sala de notas sem atividade
 * @param {number} [opts.ttlArquivoMs]    vida do arquivo a partir do fim do upload
 * @param {number} [opts.tamMaxBytes]     limite por arquivo
 * @param {number} [opts.ttlDownloadMs]   trava de segurança de um download preso
 * @param {number} [opts.maxSalas]        teto de salas abertas ao mesmo tempo
 * @param {number} [opts.maxArquivos]     teto de arquivos por sala
 * @param {number} [opts.maxTexto]        teto de caracteres da nota
 * @param {string} [opts.dirBase]         pasta dos arquivos do drive
 */
function criarSalas(opts = {}) {
  const cfg = {
    ttlNotaMs: opts.ttlNotaMs || 10 * 60000,
    ttlArquivoMs: opts.ttlArquivoMs || 10 * 60000,
    tamMaxBytes: opts.tamMaxBytes || 25 * 1024 * 1024,
    ttlDownloadMs: opts.ttlDownloadMs || 10 * 60000,
    maxSalas: opts.maxSalas || 200,
    maxArquivos: opts.maxArquivos || 50,
    maxTexto: opts.maxTexto || 500000,
    /* Cadência do "estou vivo" de cada conexão SSE — e a cada volta o
       servidor reenvia o prazo atual para todas as abas. */
    pingMs: opts.pingMs || 25000,
    dirBase: opts.dirBase || path.join(os.tmpdir(), 'markdown-studio-drive'),
  };

  /* Subida: o diretório é só nosso, então apagar tudo o que sobrou de uma
     execução anterior é seguro e resolve crash no meio de um upload. */
  try {
    fs.rmSync(cfg.dirBase, { recursive: true, force: true });
    fs.mkdirSync(cfg.dirBase, { recursive: true });
  } catch (err) {
    console.warn('[salas] não consegui preparar a pasta dos arquivos:', err.message);
  }

  /** `${tipo}:${id}` -> sala */
  const salas = new Map();

  const chaveDe = (tipo, id) => tipo + ':' + id;
  const ttlDaSala = (sala) => (sala.tipo === TIPOS.NOTAS ? cfg.ttlNotaMs : cfg.ttlArquivoMs);

  /* ---------------------------------------------------------- *
     Relógio da sala: prazo rolando, recomeçando a cada atividade
     ---------------------------------------------------------- */
  function remarcar(sala) {
    clearTimeout(sala.temporizador);
    sala.expiraEm = Date.now() + ttlDaSala(sala);
    sala.temporizador = setTimeout(() => apagar(sala), ttlDaSala(sala));
    if (sala.temporizador.unref) sala.temporizador.unref();
  }

  function apagar(sala) {
    if (!salas.has(chaveDe(sala.tipo, sala.id))) return;
    salas.delete(chaveDe(sala.tipo, sala.id));
    clearTimeout(sala.temporizador);

    for (const ouvinte of sala.ouvintes) {
      try { ouvinte.fn({ tipo: 'encerrada', id: sala.id }); } catch (err) { /* conexão já morreu */ }
    }
    sala.ouvintes.clear();

    if (sala.tipo === TIPOS.DRIVE) {
      for (const arq of Array.from(sala.dados.arquivos.values())) {
        removerArquivo(arq, { avisar: false });
      }
    }
  }

  /* ---------------------------------------------------------- *
     Salas
     ---------------------------------------------------------- */
  function criar(tipo, senha) {
    if (salas.size >= cfg.maxSalas) {
      throw erroDe(429, 'Muitas salas abertas agora; tente de novo em instantes.');
    }
    let id = novoId();
    while (salas.has(chaveDe(tipo, id))) id = novoId();

    const sala = {
      id,
      tipo,
      senhaHash: senha ? hashSenha(senha, id) : null,
      criadaEm: Date.now(),
      expiraEm: 0,
      temporizador: null,
      ouvintes: new Set(),
      dados: tipo === TIPOS.NOTAS
        ? { texto: '', versao: 0 }
        : { arquivos: new Map() },
    };
    remarcar(sala);
    salas.set(chaveDe(tipo, id), sala);
    return sala;
  }

  function obter(tipo, id) {
    const sala = salas.get(chaveDe(tipo, id)) || null;
    if (sala && sala.expiraEm <= Date.now()) {
      apagar(sala);
      return null;
    }
    return sala;
  }

  function autenticado(sala, senha) {
    if (!sala.senhaHash) return true;
    return senhaConfere(senha == null ? '' : senha, sala.senhaHash, sala.id);
  }

  /** Marca uso e faz o prazo da sala recomeçar. */
  function ativar(sala) {
    remarcar(sala);
  }

  function online(sala) {
    return sala.ouvintes.size;
  }

  /** Assina a sala. Devolve a função que cancela. Os dois lados avisam o
      restante de que o contador de gente mudou. Assistir não renova o
      prazo — só edição (e upload no drive) segura o relógio. */
  function ouvir(sala, cliente, fn) {
    const par = { cliente: cliente || '', fn };
    sala.ouvintes.add(par);
    avisar(sala, { tipo: 'online', online: sala.ouvintes.size });
    return () => {
      if (!sala.ouvintes.delete(par)) return;
      avisar(sala, { tipo: 'online', online: sala.ouvintes.size });
    };
  }

  function avisar(sala, evento) {
    for (const ouvinte of sala.ouvintes) {
      try { ouvinte.fn(evento); } catch (err) { /* a rota fecha sozinha no close */ }
    }
  }

  /* ---------------------------------------------------------- *
     Notas
     ---------------------------------------------------------- */
  function ler(sala) {
    if (sala.tipo !== TIPOS.NOTAS) throw erroDe(400, 'Essa sala não é de notas.');
    return {
      texto: sala.dados.texto,
      versao: sala.dados.versao,
      expiraEm: sala.expiraEm,
      /* O relógio é do servidor: quem lê conta a partir daqui e não do
         relógio da própria máquina. */
      agora: Date.now(),
      maxTexto: cfg.maxTexto,
    };
  }

  function escrever(sala, texto) {
    if (sala.tipo !== TIPOS.NOTAS) throw erroDe(400, 'Essa sala não é de notas.');
    const conteudo = String(texto == null ? '' : texto);
    if (conteudo.length > cfg.maxTexto) {
      throw erroDe(413, 'A nota atingiu o limite de ' + cfg.maxTexto + ' caracteres.');
    }
    sala.dados.texto = conteudo;
    sala.dados.versao += 1;
    ativar(sala);
    const estado = ler(sala);
    avisar(sala, Object.assign({ tipo: 'texto' }, estado));
    return estado;
  }

  /* ---------------------------------------------------------- *
     Drive
     ---------------------------------------------------------- */
  function lista(sala) {
    if (sala.tipo !== TIPOS.DRIVE) throw erroDe(400, 'Essa sala não é de arquivos.');
    return Array.from(sala.dados.arquivos.values())
      .filter((arq) => !arq.expirado)
      .map((arq) => ({ id: arq.id, nome: arq.nome, tamanho: arq.tamanho, expiraEm: arq.expiraEm }));
  }

  function removerArquivo(arq, { avisar: avisa = true, forcar = false } = {}) {
    clearTimeout(arq.temporizador);
    if (!forcar && arq.baixando > 0) {
      /* Alguém está baixando: tira da lista já (acabou o prazo), mas o
         arquivo só some do disco quando a última resposta terminar. */
      if (!arq.expirado) {
        arq.expirado = true;
        if (arq.temporizadorDownload) clearTimeout(arq.temporizadorDownload);
        arq.temporizadorDownload = setTimeout(() => finalizarDownloadForcado(arq), cfg.ttlDownloadMs);
        if (arq.temporizadorDownload.unref) arq.temporizadorDownload.unref();
      }
      return;
    }
    arq.expirado = true;
    if (arq.salaRef && arq.salaRef.dados.arquivos) {
      arq.salaRef.dados.arquivos.delete(arq.id);
    }
    try { fs.unlinkSync(arq.caminho); } catch (err) { /* já foi */ }
    if (avisa && arq.salaRef && salas.has(chaveDe(arq.salaRef.tipo, arq.salaRef.id))) {
      avisar(arq.salaRef, { tipo: 'arquivo-expirou', id: arq.id });
    }
  }

  /**
   * Recebe o arquivo em fluxo: `origem` é qualquer Readable (no servidor, a
   * própria requisição). A contagem de vida só começa quando TODOS os bytes
   * chegaram e o arquivo fechou no disco — upload interrompido ou acima do
   * limite deixa o disco limpo.
   */
  function enviarArquivo(sala, nome, origem) {
    if (sala.tipo !== TIPOS.DRIVE) {
      return Promise.reject(erroDe(400, 'Essa sala não é de arquivos.'));
    }
    if (sala.dados.arquivos.size >= cfg.maxArquivos) {
      return Promise.reject(erroDe(429, 'A sala já tem ' + cfg.maxArquivos + ' arquivos; espere alguns expirarem.'));
    }

    const id = novoId();
    const caminho = path.join(cfg.dirBase, id);
    const apelido = nomeLimpo(nome);
    const escrita = fs.createWriteStream(caminho);

    return new Promise((resolve, reject) => {
      let bytes = 0;
      let fimChegou = false;
      let concluido = false;

      const falhar = (err) => {
        if (concluido) return;
        concluido = true;
        origem.removeListener('data', aoDados);
        origem.removeListener('end', aoFim);
        origem.removeListener('error', falhar);
        origem.removeListener('close', aoClose);
        try { origem.pause(); } catch (err2) { /* fonte já morreu */ }
        escrita.destroy();
        try { fs.unlinkSync(caminho); } catch (err2) { /* nada gravado */ }
        reject(err);
      };

      const aoDados = (chunk) => {
        /* Conta e grava em bytes de verdade: chunk de string tem comprimento
           de caractere, e um "olá" já não bate com o tamanho do arquivo. */
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > cfg.tamMaxBytes) {
          falhar(erroDe(413, 'Arquivo maior que o limite de ' + formatarTamanho(cfg.tamMaxBytes) + '.'));
          return;
        }
        if (!escrita.write(buf)) origem.pause();
      };

      const aoFim = () => {
        /* 'close' logo vem em seguida num fluxo normal: sinaliza aqui para
           ele não confundir o fim de arquivo com um aborto do cliente. */
        fimChegou = true;
        escrita.end(() => {
          if (concluido) return;
          concluido = true;
          registrar(bytes);
        });
      };

      const aoClose = () => {
        /* Fechou sem 'end': cliente desligou no meio do envio. */
        if (fimChegou) return;
        falhar(erroDe(499, 'Upload interrompido.'));
      };

      escrita.on('drain', () => origem.resume());
      escrita.on('error', (err) => falhar(erroDe(500, 'Não consegui gravar o arquivo: ' + err.message)));

      origem.on('data', aoDados);
      origem.on('end', aoFim);
      origem.on('error', falhar);
      origem.on('close', aoClose);

      const registrar = (tamanho) => {
        const arq = {
          id,
          nome: apelido,
          tamanho,
          caminho,
          criadoEm: Date.now(),
          expiraEm: Date.now() + cfg.ttlArquivoMs,
          baixando: 0,
          expirado: false,
          temporizador: null,
          temporizadorDownload: null,
          salaRef: sala,
        };
        sala.dados.arquivos.set(id, arq);
        arq.temporizador = setTimeout(() => removerArquivo(arq), cfg.ttlArquivoMs);
        if (arq.temporizador.unref) arq.temporizador.unref();

        ativar(sala);
        avisar(sala, {
          tipo: 'arquivo-novo',
          arquivo: { id: arq.id, nome: arq.nome, tamanho: arq.tamanho, expiraEm: arq.expiraEm },
          agora: Date.now(),
        });
        resolve({ id: arq.id, nome: arq.nome, tamanho: arq.tamanho, expiraEm: arq.expiraEm, agora: Date.now() });
      };
    });
  }

  function arquivo(sala, id) {
    const arq = sala.dados.arquivos.get(id) || null;
    if (!arq || arq.expirado) return null;
    return arq;
  }

  /** Abre a "janela" de download: a exclusão fica esperando o fecho. */
  function iniciarBaixando(arq) {
    arq.baixando += 1;
    return arq;
  }

  function finalizarBaixando(arq) {
    if (arq.baixando > 0) arq.baixando -= 1;
    /* Apaga quando a última resposta terminou. */
    if (arq.expirado && arq.baixando <= 0) {
      clearTimeout(arq.temporizadorDownload);
      removerArquivo(arq, { avisar: false });
    }
  }

  /** Trava de segurança: um download que nunca fechou não segura arquivo eterno. */
  function finalizarDownloadForcado(arq) {
    removerArquivo(arq, { avisar: false, forcar: true });
  }

  return {
    cfg,
    criar,
    obter,
    autenticado,
    ativar,
    online,
    ouvir,
    ler,
    escrever,
    lista,
    enviarArquivo,
    arquivo,
    iniciarBaixando,
    finalizarBaixando,
  };
}

/**
 * Instância única, lida do ambiente já com o `.env` carregado pela raiz do
 * servidor: `NOTES_TTL_MIN` (padrão 10), `DRIVE_TTL_MIN` (padrão 10) e
 * `DRIVE_MAX_MB` (padrão 25).
 */
function deAmbiente() {
  const minutos = (valor, padrao) => {
    const n = Number(valor);
    return Number.isFinite(n) && n > 0 ? n * 60000 : padrao * 60000;
  };
  const megas = (valor, padrao) => {
    const n = Number(valor);
    return Number.isFinite(n) && n > 0 ? n * 1024 * 1024 : padrao * 1024 * 1024;
  };
  return criarSalas({
    ttlNotaMs: minutos(process.env.NOTES_TTL_MIN, 10),
    ttlArquivoMs: minutos(process.env.DRIVE_TTL_MIN, 10),
    tamMaxBytes: megas(process.env.DRIVE_MAX_MB, 25),
  });
}

const salas = deAmbiente();

module.exports = { salas, criarSalas, TIPOS, formatarTamanho };
