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

/** A prévia terminou de paginar: folhas prontas e contador preenchido. */
const previewReady = (dom) =>
  /pagedjs_sheet/.test(dom) && !/id="pages-info"[^>]*>—/.test(dom);

async function esperaRenderCdp(chrome, url, esperaMs) {
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
      if (previewReady(dom)) return dom;
      if (Date.now() - inicio > esperaMs) {
        throw new Error('o render não ficou pronto em ' + esperaMs + ' ms');
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

module.exports = { esperaRenderCdp, previewReady };

if (require.main === module) {
  const [, , url, espera, chrome] = process.argv;
  const esperaMs = Number(espera) || 60000;
  /* trava para a conexão com o DevTools morrer em silêncio: o processo sai
     com erro e o pai reporta, em vez de pendurar a suíte */
  const trava = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('espera travada após ' + (esperaMs + 30000) + ' ms')), esperaMs + 30000)
  );
  Promise.race([esperaRenderCdp(chrome, url, esperaMs), trava]).then(
    (dom) => { process.stdout.write(dom); process.exit(0); },
    (err) => { process.stderr.write(String((err && err.message) || err)); process.exit(1); }
  );
}
