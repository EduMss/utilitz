'use strict';

/*
 * Peças das salas compartilhadas (notas e drive) que as duas páginas
 * dividem: painéis (criar/senha/expirou/sala), canal de atualizações (SSE),
 * contagem regressiva, status de conexão e a senha da sala guardada na aba.
 *
 * A senha vive no `sessionStorage`: sobrevive ao F5 e ao link do mesmo aba,
 * mas morre quando a aba fecha — nada de senha em link permanente.
 */
(function (global) {
  'use strict';

  const { $, toast } = global.MD;

  const urlDe = (tipo, id, mais) => '/api/' + tipo + '/' + id + (mais || '');

  function idNaUrl(inicio) {
    const m = new RegExp('^' + inicio + '/([A-Za-z0-9_-]{4,})').exec(location.pathname);
    return m ? m[1] : null;
  }

  /* ---------------------------------------------------------
     Senha da sala (sessionStorage + ?senha= da URL)
     --------------------------------------------------------- */
  const chave = (tipo, id) => 'md:sala:' + tipo + ':' + id;

  function senhaDe(tipo, id) {
    const q = new URLSearchParams(location.search).get('senha');
    if (q) {
      guardaSenha(tipo, id, q);
      return q;
    }
    try {
      return sessionStorage.getItem(chave(tipo, id)) || '';
    } catch (err) {
      return '';
    }
  }

  function guardaSenha(tipo, id, senha) {
    try {
      sessionStorage.setItem(chave(tipo, id), senha);
    } catch (err) {
      /* modo privado */
    }
  }

  function apagaSenha(tipo, id) {
    try {
      sessionStorage.removeItem(chave(tipo, id));
    } catch (err) {
      /* ignore */
    }
  }

  function cabecalho(senha) {
    return senha ? { 'x-sala-senha': senha } : {};
  }

  /* ---------------------------------------------------------
     Cabeçalho da sala aberta: status, gente online, copiar link
     --------------------------------------------------------- */
  function statusPara(prefixo, estado) {
    const el = $('#' + prefixo + '-status');
    const dot = $('#' + prefixo + '-dot');
    el.textContent = estado;
    dot.classList.remove('is-on', 'is-off');
    if (estado === 'conectado') dot.classList.add('is-on');
    if (estado === 'encerrada') dot.classList.add('is-off');
  }

  function onlinePara(prefixo, n) {
    $('#' + prefixo + '-online').textContent = String(Math.max(1, n));
  }

  function mmss(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? h + ':' + m + ':' + s : m + ':' + s;
  }

  /**
   * Contagem regressiva de um prazo. `novo(ms)` ajusta o alvo (a sala rolou
   * o prazo); `parar()` encerra o relógio.
   */
  function contagem(el, expiraEm) {
    const relogio = {
      parar() {
        clearInterval(relogio.temporizador);
      },
      novo(novoExpiraEm) {
        expiraEm = novoExpiraEm;
        relogio.tick();
      },
      tick() {
        const falta = expiraEm - Date.now();
        el.textContent = falta <= 0 ? 'expirando…' : 'some em ' + mmss(falta);
      },
      temporizador: null,
    };
    relogio.tick();
    relogio.temporizador = setInterval(relogio.tick, 1000);
    return relogio;
  }

  function copiarLink(botao) {
    const texto = location.href;
    const ok = () => toast('Link copiado — é só mandar.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(texto).then(ok, () => fallback());
    } else {
      fallback();
    }
    function fallback() {
      const caixa = document.createElement('textarea');
      caixa.value = texto;
      caixa.style.position = 'fixed';
      caixa.style.opacity = '0';
      document.body.appendChild(caixa);
      caixa.select();
      try {
        document.execCommand('copy');
        ok();
      } catch (err) {
        toast('Copie o link da barra de endereço.', 'error');
      }
      caixa.remove();
    }
    if (botao) {
      const antes = botao.textContent;
      botao.textContent = 'Copiado!';
      setTimeout(() => {
        botao.textContent = antes;
      }, 1600);
    }
  }

  /* ---------------------------------------------------------
     Canal de atualizações (SSE)
     --------------------------------------------------------- */
  const EVENTOS = ['estado', 'relogio', 'texto', 'online', 'encerrada', 'arquivo-novo', 'arquivo-expirou'];

  /**
   * Abre o EventSource da sala. O navegador reconecta sozinho em queda de
   * rede; quando a sala expira o servidor avisa `encerrada` e a gente fecha
   * o canal para não ficar martelando um 404.
   */
  function conectar({ tipo, id, senha, prefixo, aoEvento, aoFechar }) {
    const url = urlDe(tipo, id, '/eventos') + (senha ? '?senha=' + encodeURIComponent(senha) : '');
    const es = new EventSource(url);

    es.onopen = () => statusPara(prefixo, 'conectado');
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) {
        statusPara(prefixo, 'reconectando');
        return;
      }
      /* Fechou de vez — quase sempre 404 na reconexão: a sala morreu fora
         do aviso. A página re-pergunta ao servidor, e o 404 troca o painel
         para "expirou" no lugar de deixar a aba órfã. */
      statusPara(prefixo, 'encerrada');
      if (aoFechar) aoFechar();
    };
    for (const nome of EVENTOS) {
      es.addEventListener(nome, (e) => {
        let dados = null;
        try {
          dados = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        if (nome === 'encerrada') es.close();
        aoEvento(nome, dados);
      });
    }
    return es;
  }

  function fmtTamanho(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return String(Math.round(bytes / 102.4) / 10).replace('.', ',') + ' kB';
    return String(Math.round(bytes / 104857.6) / 10).replace('.', ',') + ' MB';
  }

  /**
   * Prazo do backend virado para o relógio LOCAL: `expiraEm - agora` é o
   * que resta segundo o servidor, e a aba conta a partir daqui. O relógio
   * do servidor manda — duas abas veem o mesmo número mesmo que a máquina
   * tenha relógio descasado do servidor.
   */
  function alvoLocal(ev) {
    if (!ev || !Number.isFinite(ev.expiraEm)) return Date.now();
    const agora = Number.isFinite(ev.agora) ? ev.agora : Date.now();
    return Date.now() + (ev.expiraEm - agora);
  }

  global.MD.sala = {
    urlDe,
    idNaUrl,
    senhaDe,
    guardaSenha,
    apagaSenha,
    cabecalho,
    statusPara,
    onlinePara,
    contagem,
    alvoLocal,
    copiarLink,
    conectar,
    fmtTamanho,
    mmss,
  };
})(window);
