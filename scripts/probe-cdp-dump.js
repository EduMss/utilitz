'use strict';
/**
 * Espera o render de uma página em tempo real e imprime o DOM pronto.
 *
 * O --dump-dom do Chrome headless não serve para esperar a paginação do
 * Paged.js: com tempo virtual o relógio queima antes de o navegador entregar
 * frames suficientes (fome de rAF) e o dump sai no meio da paginação; sem
 * orçamento nenhum o dump sai no load inicial, antes do redirect da página
 * de passagem. Aqui o Chrome roda em tempo real e este processo consulta o
 * DOM via DevTools Protocol a cada 250 ms até o predicado passar.
 *
 * Uso (chamado por probe-browser.js):
 *   node scripts/probe-cdp-dump.js <url> <esperaMs> <caminho-do-chrome>
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Predicados de "a página está pronta". São nomeados porque o Chrome roda em
 * tempo real e o pai (probe-browser.js) escolhe o que faz sentido para cada
 * alvo — um SSE aberto, por exemplo, viveria esperando para sempre dentro do
 * `--dump-dom` de orçamento virtual.
 */
const PREDICADOS = {
  /** Página paginou de verdade (Paged.js). */
  paginado: (dom) => /pagedjs_sheet/.test(dom) && !/id="pages-info"[^>]*>—/.test(dom),

  /** Sala de notas/drive conectada ao canal de atualizações. */
  conectado: (dom) =>
    /id="nt-status"[^>]*>conectado</.test(dom) || /id="dv-status"[^>]*>conectado</.test(dom),

  /** O quadro de teste gravou o laudo em JSON no <pre id="out">. */
  relatorio: (dom) => {
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
    if (!m) return false;
    const txt = m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
    return txt.startsWith('{') && txt.endsWith('}');
  },

  /** Página de sala privada parou no pedido de senha (painel aberto). */
  pedindoSenha: (dom) => {
    const alvo = /<section[^>]*id="(?:nt|dv)-senha"[^>]*>/.exec(dom);
    return !!alvo && !/\bhidden\b/.test(alvo[0]);
  },
};

/** Nome legível para fora (o pai importa este). */
const previewReady = PREDICADOS.paginado;

function predicadoDe(nome) {
  if (typeof nome === 'function') return nome;
  return PREDICADOS[nome || 'paginado'] || PREDICADOS.paginado;
}

/** Resumo do estado das salas, para o erro de timeout apontar o painel. */
function resumoDe(dom) {
  const abertos = [];
  for (const m of dom.matchAll(/<section[^>]*id="((?:nt|dv)-[a-z]+)"([^>]*)>/g)) {
    if (!/\bhidden\b/.test(m[2])) abertos.push(m[1]);
  }
  const st = /id="(?:nt|dv)-status"[^>]*>([^<]*)</.exec(dom);
  return 'painéis abertos: ' + (abertos.join(', ') || 'nenhum') + ' · status: ' + (st ? st[1] : '?');
}

async function esperaRenderCdp(chrome, url, esperaMs, predicado, extrair) {
  const pronto = predicadoDe(predicado);
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'md-probe-cdp-'));
  // porta derivada do pid: execuções paralelas não costumam colidir
  const porta = 9400 + (process.pid % 400);
  const proc = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1400,900',
    '--remote-debugging-port=' + porta,
    '--user-data-dir=' + perfil,
    '--disable-application-cache',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let ws = null;
  try {
    // a aba nova já nasce navegando para a URL; só esperamos o endpoint abrir
    let alvo = null;
    for (let i = 0; i < 100 && !alvo; i++) {
      try {
        const r = await fetch(
          'http://127.0.0.1:' + porta + '/json/new?' + encodeURIComponent(url),
          { method: 'PUT' }
        );
        if (r.ok) alvo = await r.json();
      } catch (err) {
        /* Chrome ainda subindo */
      }
      if (!alvo) await new Promise((res) => setTimeout(res, 100));
    }
    if (!alvo || !alvo.webSocketDebuggerUrl) {
      throw new Error('Chrome não abriu a aba para ' + url);
    }

    ws = new WebSocket(alvo.webSocketDebuggerUrl);
    let seq = 0;
    const pendentes = new Map();
    const rpc = (method, params) => new Promise((res, rej) => {
      const id = ++seq;
      pendentes.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const pend = pendentes.get(msg.id);
      if (!pend) return;
      pendentes.delete(msg.id);
      if (msg.error) pend.rej(new Error(msg.error.message));
      else pend.res(msg.result);
    });
    ws.addEventListener('close', () => {
      for (const [, pend] of pendentes) pend.rej(new Error('conexão com o DevTools fechou'));
      pendentes.clear();
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    const inicio = Date.now();
    for (;;) {
      const r = await rpc('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      const dom = (r.result && r.result.value) || '';
      if (pronto(dom)) {
        /* `value` de textarea e afins não serializa no DOM: quem precisa
           ler propriedade passa uma expressão e recebe o resultado num
           comentário no fim do dump. */
        if (!extrair) return dom;
        const extra = await rpc('Runtime.evaluate', {
          expression: 'String(' + String(extrair) + ')',
          returnByValue: true,
        });
        return dom + '\n<!--extra:' + String((extra.result && extra.result.value) || '').replace(/-->/g, '--&gt;') + '-->';
      }
      if (Date.now() - inicio > esperaMs) {
        throw new Error('o render não ficou pronto em ' + esperaMs + ' ms (' + resumoDe(dom) + ')');
      }
      await new Promise((res) => setTimeout(res, 250));
    }
  } finally {
    try { if (ws) ws.close(); } catch (err) { /* já fechado */ }
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (err) { /* já saiu */ }
    /* perfil travado por um processo que ainda está saindo não é motivo de
       derrubar a suíte: o %TEMP% limpa depois */
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (err) { /* tenta de novo na próxima */ }
  }
}

module.exports = { esperaRenderCdp, previewReady, PREDICADOS };

if (require.main === module) {
  const [, , url, espera, chrome, predicado, extrair] = process.argv;
  const esperaMs = Number(espera) || 60000;
  /* trava para a conexão com o DevTools morrer em silêncio: o processo sai
     com erro e o pai reporta, em vez de pendurar a suíte */
  const trava = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('espera travada após ' + (esperaMs + 30000) + ' ms')), esperaMs + 30000)
  );
  Promise.race([esperaRenderCdp(chrome, url, esperaMs, predicado, extrair), trava]).then(
    (dom) => { process.stdout.write(dom); process.exit(0); },
    (err) => { process.stderr.write(String((err && err.message) || err)); process.exit(1); }
  );
}
