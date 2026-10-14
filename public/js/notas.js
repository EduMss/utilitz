'use strict';

/*
 * Bloco de notas compartilhado.
 *
 * Sem sala na URL, a página é a de criar. Com sala, o cliente pergunta à API
 * (com a senha da aba, se houver) e abre a mesa de escrita: o texto salva
 * sozinho a cada pausa, e o que os outros digitam chega pelo canal de
 * atualizações.
 *
 * Regra do cursor: edição remota só pisca o texto quando ninguém está no
 * meio de uma frase — com edição local não salva, ela fica em espera e entra
 * quando a pessoa solta o foco.
 */
(function (global) {
  'use strict';

  const { $, toast, api, render, debounce } = global.MD;
  const S = global.MD.sala;

  const TIPO = 'notas';
  const id = S.idNaUrl('/notas');

  const texto = $('#nt-texto');
  const previa = $('#nt-previa');
  const aviso = $('#nt-pendente');

  let senha = '';
  let versao = 0;
  let ultimoEnviado = '';
  let pendente = null;
  let agendado = false;
  let es = null;
  let relogio = null;

  function mostrar(painel) {
    for (const nome of ['hero', 'criar', 'senha', 'expirou', 'sala']) {
      const el = $('#nt-' + nome);
      if (el) el.hidden = nome !== painel;
    }
  }

  /* ---------------------------------------------------------
     Criar sala
     --------------------------------------------------------- */
  $('#nt-criar-btn').addEventListener('click', async () => {
    const senhaNova = $('#nt-nova-senha').value;
    try {
      const r = await api('/api/notas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha: senhaNova }),
      });
      const { id: novoId } = await r.json();
      if (senhaNova) S.guardaSenha(TIPO, novoId, senhaNova);
      location.href = '/notas/' + novoId;
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  /* ---------------------------------------------------------
     Entrar com senha
     --------------------------------------------------------- */
  $('#nt-entrar-btn').addEventListener('click', () => {
    const digitada = $('#nt-entrada-senha').value;
    S.guardaSenha(TIPO, id, digitada);
    senha = digitada;
    carregar();
  });

  $('#nt-entrada-senha').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#nt-entrar-btn').click();
  });

  function mostrarSenha(mensagemErro) {
    mostrar('senha');
    const erro = $('#nt-senha-erro');
    erro.hidden = !mensagemErro;
    if (mensagemErro) erro.textContent = mensagemErro;
    $('#nt-entrada-senha').focus();
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
        console.error('[notas] não abriu a sala:', err && err.message, 'status=' + (err && err.status));
        mostrar('expirou');
      }
    }
  }

  function abrir(estado) {
    senha = S.senhaDe(TIPO, id);
    mostrar('sala');

    $('#nt-codigo').textContent = estado.id;
    $('#nt-privada').hidden = !estado.privada;
    texto.maxLength = estado.maxTexto || 500000;

    texto.value = estado.texto;
    versao = estado.versao;
    ultimoEnviado = estado.texto;

    S.onlinePara('nt', estado.online);
    relogio = S.contagem($('#nt-expira'), S.alvoLocal(estado));

    es = S.conectar({
      tipo: TIPO,
      id,
      senha,
      prefixo: 'nt',
      aoEvento(nome, dados) {
        if (nome === 'estado' || nome === 'texto') aplicar(dados);
        if (nome === 'relogio') {
          /* O backend acaba de confirmar o prazo: mesma régua para todas
             as abas, sem cada uma contar do seu último recado. */
          if (relogio) relogio.novo(S.alvoLocal(dados));
          S.onlinePara('nt', dados.online);
        }
        if (nome === 'online') S.onlinePara('nt', dados.online);
        if (nome === 'encerrada') encerrada();
      },
      /* Canal caiu e não voltou (sala morta fora do aviso): pergunta ao
         servidor de novo — o 404 troca para o painel de expirou. */
      aoFechar: () => carregar(),
    });
  }

  function aplicar(ev) {
    if (!ev) return;
    /* O relógio vem do backend e anda mesmo com a mesma versão: atualiza
       antes de qualquer guarda, senão a aba congela num prazo antigo. */
    if (relogio && ev.expiraEm != null) relogio.novo(S.alvoLocal(ev));
    if (ev.versao == null || ev.versao <= versao) return;
    versao = ev.versao;
    if (texto.value === ev.texto) return;

    const ocupado = document.activeElement === texto && texto.value !== ultimoEnviado;
    if (ocupado) {
      /* Tem frase sendo digitada: guarda a versão remota e avisa. */
      pendente = ev.texto;
      aviso.hidden = false;
      return;
    }
    texto.value = ev.texto;
    ultimoEnviado = ev.texto;
    atualizarPrevia();
  }

  texto.addEventListener('blur', () => {
    if (pendente == null) return;
    texto.value = pendente;
    pendente = null;
    aviso.hidden = true;
    atualizarPrevia();
  });

  function encerrada() {
    if (es) es.close();
    if (relogio) relogio.parar();
    mostrar('expirou');
    S.statusPara('nt', 'encerrada');
  }

  /* ---------------------------------------------------------
     Salvar (sozinho, a cada pausa de digitação)
     --------------------------------------------------------- */
  function enviar(keepalive) {
    agendado = false;
    const conteudo = texto.value;
    if (conteudo === ultimoEnviado) return Promise.resolve();

    /* No desligar da aba só cabe aviso best-effort, e corpo pequeno. */
    if (keepalive && conteudo.length > 60000) return Promise.resolve();

    return api(S.urlDe(TIPO, id), {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, S.cabecalho(senha)),
      body: JSON.stringify({ texto: conteudo }),
      keepalive: !!keepalive,
    })
      .then((r) => r.json())
      .then((salvo) => {
        ultimoEnviado = conteudo;
        versao = salvo.versao;
        if (relogio) relogio.novo(S.alvoLocal(salvo));
      })
      .catch((err) => toast(err.message, 'error'));
  }

  const enviarEmPausa = debounce(() => enviar(), 450);

  texto.addEventListener('input', () => {
    agendado = true;
    enviarEmPausa();
    atualizarPrevia();
  });

  window.addEventListener('beforeunload', () => {
    if (agendado) enviar(true);
  });

  /* ---------------------------------------------------------
     Prévia opcional de markdown
     --------------------------------------------------------- */
  const atualizarPrevia = debounce(async () => {
    if (previa.hidden) return;
    try {
      const r = await render(texto.value);
      previa.innerHTML = r.html || '';
    } catch (err) {
      /* prévia é conforto, não estrada */
    }
  }, 300);

  $('#nt-previa-btn').addEventListener('click', async (e) => {
    previa.hidden = !previa.hidden;
    e.currentTarget.textContent = previa.hidden ? 'Prévia' : 'Ocultar prévia';
    if (!previa.hidden) {
      try {
        const r = await render(texto.value);
        previa.innerHTML = r.html || '';
      } catch (err) {
        toast('Não consegui gerar a prévia agora.', 'error');
      }
    }
  });

  /* ---------------------------------------------------------
     Cabeçalho
     --------------------------------------------------------- */
  $('#nt-copiar').addEventListener('click', (e) => S.copiarLink(e.currentTarget));
  $('#nt-sair').addEventListener('click', () => {
    location.href = '/notas';
  });

  /* ---------------------------------------------------------
     Começo
     --------------------------------------------------------- */
  if (id) {
    senha = S.senhaDe(TIPO, id);
    carregar();
  } else {
    mostrar('criar');
    $('#nt-nova-senha').focus();
  }
})(window);
