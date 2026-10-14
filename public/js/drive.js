'use strict';

/*
 * Drive compartilhado.
 *
 * O envio vai no corpo cru da requisição (sem multipart): o navegador fala
 * com o servidor byte a byte, e a barra de progresso é a de verdade. A lista
 * da sala vive num mapa por id — evento de quem chegou, quem expirou e a
 * resposta do próprio envio caem no mesmo lugar, sem duplicar linha.
 */
(function (global) {
  'use strict';

  const { $, toast, api } = global.MD;
  const S = global.MD.sala;

  const TIPO = 'drive';
  const id = S.idNaUrl('/drive');

  const drop = $('#dv-drop');
  const input = $('#dv-input');
  const caixaUploads = $('#dv-uploads');
  const lista = $('#dv-lista');

  let senha = '';
  let tamMaxBytes = 25 * 1024 * 1024;
  let es = null;
  const arquivos = new Map();

  function mostrar(painel) {
    for (const nome of ['hero', 'criar', 'senha', 'expirou', 'sala']) {
      const el = $('#dv-' + nome);
      if (el) el.hidden = nome !== painel;
    }
  }

  /* ---------------------------------------------------------
     Criar sala / senha
     --------------------------------------------------------- */
  $('#dv-criar-btn').addEventListener('click', async () => {
    const senhaNova = $('#dv-nova-senha').value;
    try {
      const r = await api('/api/drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: senhaNova }),
      });
      const { id: novoId } = await r.json();
      if (senhaNova) S.guardaSenha(TIPO, novoId, senhaNova);
      location.href = '/drive/' + novoId;
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#dv-entrar-btn').addEventListener('click', () => {
    const digitada = $('#dv-entrada-senha').value;
    S.guardaSenha(TIPO, id, digitada);
    senha = digitada;
    carregar();
  });

  $('#dv-entrada-senha').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#dv-entrar-btn').click();
  });

  function mostrarSenha(mensagemErro) {
    mostrar('senha');
    const erro = $('#dv-senha-erro');
    erro.hidden = !mensagemErro;
    if (mensagemErro) erro.textContent = mensagemErro;
    $('#dv-entrada-senha').focus();
  }

  /* ---------------------------------------------------------
     Abrir a sala
     --------------------------------------------------------- */
  async function carregar() {
    try {
      const r = await api(S.urlDe(TIPO, id), { headers: S.cabecalho(senha) });
      abrir(await r.json());
    } catch (err) {
      if (err.status === 401) {
        mostrarSenha('');
      } else if (err.status === 403) {
        S.apagaSenha(TIPO, id);
        mostrarSenha(err.message);
      } else {
        mostrar('expirou');
      }
    }
  }

  function abrir(estado) {
    senha = S.senhaDe(TIPO, id);
    mostrar('sala');

    $('#dv-codigo').textContent = estado.id;
    $('#dv-privada').hidden = !estado.privada;
    tamMaxBytes = estado.tamMaxBytes || tamMaxBytes;
    S.onlinePara('dv', estado.online);
    substituir(estado.arquivos, estado.agora);

    es = S.conectar({
      tipo: TIPO,
      id,
      senha,
      prefixo: 'dv',
      aoEvento(nome, dados) {
        if (nome === 'estado') substituir(dados.arquivos, dados.agora);
        if (nome === 'arquivo-novo') {
          guardar([dados.arquivo], dados.agora);
          desenhar();
        }
        if (nome === 'arquivo-expirou') {
          arquivos.delete(dados.id);
          desenhar();
        }
        if (nome === 'online') S.onlinePara('dv', dados.online);
        if (nome === 'encerrada') encerrada();
      },
      /* Canal caiu e não voltou (sala morta fora do aviso): pergunta ao
         servidor de novo — o 404 troca para o painel de expirou. */
      aoFechar: () => carregar(),
    });
  }

  /** Guarda com o prazo já em relógio local: o backend manda `expiraEm`
      e `agora`, e a régua da linha é a diferença — nunca a subtração de
      dois relógios de máquinas diferentes. */
  function guardar(lista, agora) {
    for (const arq of lista || []) {
      arquivos.set(
        arq.id,
        Object.assign({}, arq, { expiraLocal: S.alvoLocal({ expiraEm: arq.expiraEm, agora }) })
      );
    }
  }

  function substituir(lista, agora) {
    arquivos.clear();
    guardar(lista, agora);
    desenhar();
  }

  function encerrada() {
    if (es) es.close();
    mostrar('expirou');
    S.statusPara('dv', 'encerrada');
  }

  /* ---------------------------------------------------------
     Lista
     --------------------------------------------------------- */
  function desenhar() {
    lista.textContent = '';
    if (arquivos.size === 0) {
      const vazio = document.createElement('p');
      vazio.className = 'empty';
      vazio.textContent = 'Nenhum arquivo ainda — envie o primeiro.';
      lista.appendChild(vazio);
      return;
    }
    for (const arq of arquivos.values()) {
      const linha = document.createElement('div');
      linha.className = 'dv-row';

      const nome = document.createElement('a');
      nome.className = 'dv-nome';
      nome.textContent = arq.nome;
      nome.href =
        S.urlDe(TIPO, id, '/arquivos/' + arq.id) +
        (senha ? '?senha=' + encodeURIComponent(senha) : '');
      nome.title = 'Baixar ' + arq.nome;

      const tam = document.createElement('span');
      tam.className = 'dv-tam';
      tam.textContent = S.fmtTamanho(arq.tamanho);

      const resta = document.createElement('span');
      resta.className = 'dv-resta';
      resta.dataset.expira = String(arq.expiraLocal);
      resta.textContent = S.mmss(arq.expiraEm - Date.now());

      linha.append(nome, tam, resta);
      lista.appendChild(linha);
    }
  }

  setInterval(() => {
    for (const el of lista.querySelectorAll('.dv-resta')) {
      const falta = Number(el.dataset.expira) - Date.now();
      el.textContent = falta <= 0 ? 'expirando…' : S.mmss(falta);
    }
  }, 1000);

  /* ---------------------------------------------------------
     Envio
     --------------------------------------------------------- */
  drop.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    enviarTodos(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((nome) =>
    drop.addEventListener(nome, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((nome) =>
    drop.addEventListener(nome, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    })
  );
  drop.addEventListener('drop', (e) => enviarTodos(e.dataTransfer.files));

  function enviarTodos(cadeia) {
    for (const file of Array.from(cadeia || [])) enviarArquivo(file);
  }

  function enviarArquivo(file) {
    if (file.size > tamMaxBytes) {
      toast(
        '"' + file.name + "' passa do limite de " + S.fmtTamanho(tamMaxBytes) + '.',
        'error'
      );
      return;
    }

    /* Linha de progresso própria, some quando o envio fecha. */
    const linha = document.createElement('div');
    linha.className = 'dv-prog';
    const topo = document.createElement('div');
    topo.className = 'dv-prog-top';
    const nomeEl = document.createElement('span');
    nomeEl.className = 'dv-prog-nome';
    nomeEl.textContent = file.name;
    const pctEl = document.createElement('span');
    pctEl.className = 'muted';
    pctEl.textContent = '0%';
    topo.append(nomeEl, pctEl);
    const barra = document.createElement('div');
    barra.className = 'dv-barra';
    const preenchido = document.createElement('span');
    barra.appendChild(preenchido);
    linha.append(topo, barra);
    caixaUploads.hidden = false;
    caixaUploads.appendChild(linha);

    const falhou = (mensagem) => {
      linha.remove();
      if (!caixaUploads.children.length) caixaUploads.hidden = true;
      toast(mensagem, 'error');
    };

    const xhr = new XMLHttpRequest();
    xhr.open('POST', S.urlDe(TIPO, id, '/arquivos') + '?nome=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (senha) xhr.setRequestHeader('x-sala-senha', senha);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      preenchido.style.width = pct + '%';
      pctEl.textContent = pct + '%';
    };
    xhr.onload = () => {
      if (xhr.status !== 201) {
        let mensagem = 'Falha no envio (' + xhr.status + ')';
        try {
          const dados = JSON.parse(xhr.responseText);
          if (dados && dados.error) mensagem = dados.error;
        } catch (err) {
          /* sem JSON */
        }
        falhou(mensagem);
        return;
      }
      linha.remove();
      if (!caixaUploads.children.length) caixaUploads.hidden = true;
      try {
        const { arquivo } = JSON.parse(xhr.responseText);
        guardar([arquivo], arquivo.agora);
        desenhar();
      } catch (err) {
        /* a lista se atualiza pelo canal mesmo assim */
      }
    };
    xhr.onerror = () => falhou('Caiu a conexão no meio do envio de "' + file.name + '".');
    xhr.send(file);
  }

  /* ---------------------------------------------------------
     Cabeçalho
     --------------------------------------------------------- */
  $('#dv-copiar').addEventListener('click', (e) => S.copiarLink(e.currentTarget));
  $('#dv-sair').addEventListener('click', () => {
    location.href = '/drive';
  });

  /* ---------------------------------------------------------
     Começo
     --------------------------------------------------------- */
  if (id) {
    senha = S.senhaDe(TIPO, id);
    carregar();
  } else {
    mostrar('criar');
    $('#dv-nova-senha').focus();
  }
})(window);
