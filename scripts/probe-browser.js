'use strict';
/**
 * Sonda de navegador: carrega as páginas em um Chrome/Edge headless, semeia um
 * rascunho e verifica se o render realmente apareceu no DOM paginado.
 *
 * Uso: node scripts/probe-browser.js      (exige o servidor rodando)
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { previewReady } = require('./probe-cdp-dump');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'public', '_probe.html');
const CLICK = path.join(ROOT, 'public', '_click.html');
const DUPLO = path.join(ROOT, 'public', '_duplo.html');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const BASE = process.env.BASE || 'http://localhost:3000';

// documento longo o bastante para gerar várias páginas no preview
const SAMPLE = [
  '# Título de Teste',
  '',
  'Parágrafo com **negrito**, *itálico* e `código`.',
  '',
  '## Seção Um',
  '',
  '- item a',
  '- item b',
  '',
  '## Seção Dois',
  '',
  '1. primeiro',
  '2. segundo',
  '',
  '### Uma citação',
  '',
  '> Texto citado.',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  ...Array.from({ length: 30 }, (_, i) =>
    'Parágrafo ' + (i + 1) + ' para forçar a quebra de página e conferir a paginação real do preview.'
  ),
].join('\n');

function probeHtml(handoff) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>probe</title></head>
<body>
<script>
// Sonda descartável: semeia o rascunho e redireciona para a página real.
var md = ${JSON.stringify(SAMPLE)};
var go = new URLSearchParams(location.search).get('go') || '/visualizar';
var viaHome = new URLSearchParams(location.search).get('home') === '1';
try {
  if (viaHome) {
    // simula exatamente o que a home grava ao clicar no botão
    localStorage.setItem('md:draft:shared', JSON.stringify(md));
    localStorage.setItem('md:handoff', JSON.stringify({
      target: go === '/pdf' ? 'pdf' : 'viewer',
      markdown: md,
      title: 'Título de Teste',
      at: Date.now(),
    }));
  } else {
    localStorage.setItem('md:draft:viewer', JSON.stringify(md));
    localStorage.setItem('md:draft:pdf', JSON.stringify(md));
  }
} catch (e) {}
location.replace(go);
</script>
</body></html>`;
}

/**
 * Carrega uma página no navegador e devolve o DOM já com o JS executado.
 * `budget` é o tempo virtual em ms; ele serve para páginas simples
 * assentarem. Quando a página precisa paginar (o /pdf com Paged.js), a
 * espera é em tempo real e sai do `probe-cdp-dump.js` — ver `dumpDomReady`.
 */
function dumpDom(browser, url, budget) {
  // perfil novo a cada execução: sem cache de execuções anteriores
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'md-probe-'));
  try {
    return execFileSync(
      browser,
      [
        '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        '--window-size=1400,900',
        '--virtual-time-budget=' + (budget || process.env.PROBE_BUDGET || '60000'),
        '--user-data-dir=' + profile,
        '--disable-application-cache',
        '--dump-dom',
        url,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        /* trava de verdade em vez de esperar para sempre: um Chrome preso no
           dump derruba a suíte inteira junto */
        timeout: Number(budget || 60000) + 90000 }
    );
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** Conteúdo interno de #id, equilibrando as tags. */
function innerOf(html, id) {
  const open = html.indexOf('id="' + id + '"');
  if (open === -1) return null;
  const start = html.indexOf('>', open) + 1;
  const tagMatch = /<([a-z][a-z0-9]*)/i.exec(html.slice(open, start));
  const name = tagMatch ? tagMatch[1] : 'div';
  const re = new RegExp('<(/?)' + name + '\\b[^>]*>', 'gi');
  re.lastIndex = start;
  let depth = 1, i = start, m;
  while ((m = re.exec(html)) && depth > 0) {
    depth += m[1] ? -1 : 1;
    i = m.index + m[0].length;
  }
  return html.slice(start, i);
}

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log('\nNavegador headless não encontrado; sonda de navegador pulada.\n');
  process.exit(0);
}

/**
 * Página de apoio que embute uma rota num iframe de mesma origem, interage com
 * a interface e escreve o resultado num <pre>. O dump do DOM do pai não mostra
 * o conteúdo do iframe, por isso o relatório precisa morar no documento de
 * cima.
 *
 * Serve para conferir o que só o layout revela: se um painel tem área de fato,
 * se o textarea aceita digitação, se o clique chega ao botão.
 */
function frameHtml(route, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>quadro</title></head>
<body>
<pre id="out"></pre>
<iframe id="fr" src="${route}" style="width:1400px;height:900px;border:0"></iframe>
<script>
var fr = document.getElementById('fr');
var R = {};

function report() { document.getElementById('out').textContent = JSON.stringify(R); }

/** Área visível de um elemento, e o que o navegador devolve no centro dela. */
function alvo(w, id) {
  var el = w.document.getElementById(id);
  if (!el) return { existe: false };
  var r = el.getBoundingClientRect();
  var meio = w.document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return {
    existe: true,
    w: Math.round(r.width),
    h: Math.round(r.height),
    noAlvo: !!(meio && (meio === el || el.contains(meio))),
  };
}

fr.addEventListener('load', function () {
  setTimeout(function () {
    try {
      // o corpo pode ser síncrono (objeto) ou assíncrono (promise): as duas
      // rotas escrevem o relatório no mesmo <pre>
      Promise.resolve(${body}).then(function (value) { R = value; report(); },
        function (err) { R = { erro: String(err) }; report(); });
    } catch (e) { R = { erro: String(e) }; report(); }
  }, 3000);
});
</script></body></html>`;
}

/**
 * Interface do conversor de PDF: precisa continuar utilizável depois que a
 * prévia é paginada. O Paged.js descarta a condição `print` do CSS que recebe,
 * então regra de impressão vazava para a tela e desmontava a tela dividida.
 */
function pdfFrameBody() {
  return `(async function () {
  var w = fr.contentWindow, d = w.document;
  var out = {};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  out.split = alvo(w, 'editor-pane');
  out.preview = alvo(w, 'preview-pane');
  out.editor = alvo(w, 'source');
  out.baixar = alvo(w, 'btn-download');
  out.ajustes = alvo(w, 'btn-settings');
  out.splitDisplay = w.getComputedStyle(d.querySelector('.split')).display;

  /* No Chrome headless o download nunca encerra o ciclo e o tempo virtual
     do --dump-dom fica preso para sempre. Interceptar a âncora devolve o
     controle ao teste — e registra que o arquivo foi pedido, que é o que
     interessa: o clique percorreu o caminho inteiro até o download. */
  d.addEventListener('click', function (ev) {
    var a = ev.target;
    if (a && a.tagName === 'A' && a.hasAttribute('download')) {
      ev.preventDefault();
      out.baixou = a.getAttribute('download');
    }
  }, true);

  // dá para digitar de verdade?
  var ta = d.getElementById('source');
  var antes = ta.value;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.value = antes + '\\n<!--toque-->';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  out.aceitouDigitacao = ta.value.indexOf('<!--toque-->') !== -1;
  ta.value = antes;
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));

  // o clique chega no botão de baixar?
  d.getElementById('btn-download').click();
  out.baixarCliqueOk = true;
  /* o fetch do PDF e a âncora rodam nesse intervalo (tempo virtual) */
  await sleep(6000);

  out.corDoFundo = w.getComputedStyle(d.body).backgroundColor;
  return out;
})()`;
}

/** Lê o relatório JSON escrito por frameHtml() dentro do dump. */
function frameReport(dom) {
  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!m || !m[1].trim()) throw new Error('a página de apoio não devolveu relatório');
  return JSON.parse(
    m[1]
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
  );
}

/** HTML para testar a gaveta do visualizador. */
function clickHtml() {
  return frameHtml('/visualizar', viewerFrameBody());
}

/**
 * Corpo do quadro que confere o estado do sumário: clica no botão de verdade,
 * navega para fora e volta, e mede se o estado sobreviveu. O estado é uma
 * preferência salva — se a carga da página o inverter em vez de aplicá-lo,
 * o sumário some (ou reaparece) sozinho a cada navegação.
 */
function viewerOutlineBody() {
  return `(async function () {
  var w = fr.contentWindow, d = w.document;
  var out = {};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var esperaQuadro = function () {
    return new Promise(function (r) { fr.addEventListener('load', function () { setTimeout(r, 400); }, { once: true }); });
  };
  var estado = function () {
    var o = fr.contentDocument.getElementById('outline');
    return o ? o.classList.contains('is-open') : null;
  };

  d.getElementById('btn-outline').click();
  out.depoisDoClique = estado();
  await sleep(100);

  var naSaida = esperaQuadro();
  fr.contentWindow.location.href = '/';
  await naSaida;

  var naVolta = esperaQuadro();
  fr.contentWindow.location.href = '/visualizar';
  await naVolta;
  out.aposVoltar = estado();

  out.btnLigado = fr.contentDocument.getElementById('btn-outline')
    .classList.contains('is-on') === out.aposVoltar;
  return out;
})()`;
}

/**
 * Lógica executada dentro do iframe do /formatar: cola um JSON de uma linha
 * só e confere se a prévia vira leitura de verdade (linhas, números e cor),
 * depois exercita o aviso de `\n` literal e o botão que o converte.
 */
function formatFrameBody() {
  return `(async function () {
  var w = fr.contentWindow, d = w.document;
  var out = {};
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  var ta = d.getElementById('fmt-input');
  if (!ta) return { semEditor: true };

  /* um JSON colado de uma linha só precisa virar leitura de verdade */
  ta.value = '{"nome":"Ana","tags":["a","b"],"ativo":true}';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(800);

  out.badge = d.getElementById('fmt-badge').textContent;
  out.linhas = d.querySelectorAll('#fmt-preview .fmt-line').length;
  var num = d.querySelector('#fmt-preview .fmt-num');
  out.primeiraNum = num ? num.textContent : null;
  out.realce = /hljs-/.test(d.getElementById('fmt-preview').innerHTML);
  out.copiar = !d.getElementById('fmt-copy').disabled;
  out.baixar = !d.getElementById('fmt-download').disabled;

  /* texto com \\n literal: o aviso e o botão de converter precisam aparecer */
  var nl = String.fromCharCode(92) + 'n';
  var br = String.fromCharCode(10);
  var asp = String.fromCharCode(34);
  ta.value = 'um' + nl + 'dois';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(800);

  out.grupoTexto = !d.getElementById('grp-text').hidden;
  out.dicaAlerta = d.getElementById('text-hint').className.indexOf('is-alert') !== -1;
  var fix = d.getElementById('hint-fix');
  out.temBotaoConverter = !!fix;
  if (fix) {
    fix.click();
    await sleep(400);
    out.linhasDepois = d.querySelectorAll('#fmt-preview .fmt-line').length;
    out.checkboxLigado = d.getElementById('opt-unescape').checked;
  }

  /* JSON escapado: remover 1 nível de escape precisa virar JSON de verdade */
  var barras = String.fromCharCode(92);
  ta.value = '{' + barras + asp + 'nome' + barras + asp + ':' +
             barras + asp + 'Ana' + barras + asp + '}';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(800);

  out.grupoJson = !d.getElementById('grp-json').hidden;
  var box = d.getElementById('opt-remove-escapes');
  out.temOpcaoEscape = !!box;
  box.checked = true;
  box.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(400);
  out.escapeVirouJson = d.querySelectorAll('#fmt-preview .fmt-line').length > 1 &&
    d.getElementById('fmt-preview').textContent.indexOf(barras + asp) === -1;

  /* texto multilinha: em uma linha só, escapado como string */
  ta.value = 'primeira linha' + br + 'outra linha';
  ta.dispatchEvent(new w.Event('input', { bubbles: true }));
  await sleep(800);
  var one = d.getElementById('opt-one-line');
  out.temOpcaoUmaLinha = !!one;
  if (one) {
    one.checked = true;
    one.dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(400);
    var saida = d.getElementById('fmt-preview').textContent;
    out.umaLinhaSo = d.querySelectorAll('#fmt-preview .fmt-line').length === 1 &&
      saida.indexOf(nl) !== -1 && saida.indexOf(br) === -1;
    out.unescapeDesligado = !d.getElementById('opt-unescape').checked;
  }

  return out;
})()`;
}

/** Lógica executada dentro do iframe do visualizador. */
function viewerFrameBody() {
  return `(function () {
  var w = fr.contentWindow;
  var d = w.document;
  var drawer = d.getElementById('drawer');
  var backdrop = d.getElementById('drawer-backdrop');
  var close = d.getElementById('btn-close-drawer');
  var out = { abriu: false, fechou: false, fundoEscondido: null, fundoFecha: false };

  function left() {
    return Math.round(drawer.getBoundingClientRect().left);
  }

  // sem transição o getComputedStyle reflete o estado final de verdade
  var st = d.createElement('style');
  st.textContent = '*{transition:none !important;animation:none !important}';
  d.head.appendChild(st);

  d.getElementById('btn-toggle-editor').click();
  out.abriu = drawer.classList.contains('is-open');
  out.leftAberto = left();

  var r = close.getBoundingClientRect();
  out.btnVisivel = r.left >= 0 && r.top >= 0 && r.right <= w.innerWidth;
  var alvo = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  out.btnDescoberto = !!alvo && (alvo.id === 'btn-close-drawer');

  close.click();
  out.fechou = !drawer.classList.contains('is-open');
  out.leftFechado = left();
  out.fundoEscondido = backdrop.hidden;

  d.getElementById('btn-toggle-editor').click();
  backdrop.click();
  out.fundoFecha = !drawer.classList.contains('is-open');
  out.leftDepoisFundo = left();
  return out;
})()`;
}

/**
 * Carrega a página e devolve o DOM com o render concluído.
 *
 * Quando há `ready`, a espera roda em tempo real num processo filho que
 * conversa com o DevTools Protocol até o predicado passar (ver
 * `probe-cdp-dump.js`). Sem `ready` basta o --dump-dom com tempo virtual:
 * as páginas sem paginação assentam dentro do orçamento.
 */
/**
 * Espera a página ficar pronta. Sem predicado, usa o dump de orçamento
 * virtual (rápido, serve para páginas quietas); com predicado — nome do
 * registro do helper ou função — roda o Chrome em tempo real via CDP até o
 * predicado passar, que é o caso de páginas com SSE aberto.
 */
function dumpDomReady(browser, url, pronto, extrair) {
  if (!pronto) return dumpDom(browser, url, 30000);
  const espera = Number(process.env.PROBE_WAIT) || 60000;
  const args = [path.join(__dirname, 'probe-cdp-dump.js'), url, String(espera), browser];
  if (typeof pronto === 'string') args.push(pronto);
  if (extrair) args.push(extrair);
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: espera + 60000,
  });
  if (r.status !== 0) {
    throw new Error((r.stderr || '').trim() || 'espera do render terminou com status ' + r.status);
  }
  return r.stdout;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else {
    failures++;
    console.log('  FAIL ' + name + (detail ? '\n         ' + String(detail).slice(0, 300) : ''));
  }
}

// usado para conferir o CSS da gaveta
const appCss = fs.readFileSync(path.join(ROOT, 'public', 'css', 'app.css'), 'utf8');

fs.writeFileSync(PROBE, probeHtml(), 'utf8');
console.log('\n== navegador real ==');
console.log('  ' + browser + '\n');

/**
 * Texto que o editor recebeu, lido do contador de palavras.
 * Não dá para ler o <textarea> do dump: `value` é propriedade e não aparece
 * na serialização do DOM. O contador é calculado a partir do editor, então
 * serve como verificação indireta e ainda pega "[object Object]".
 */
function editorWords(dom) {
  const m = dom.match(/id="(?:counter|status-counts)"[^>]*>(\d+)\s+palavras?/);
  return m ? Number(m[1]) : null;
}

// mesma contagem que o servidor usa em stats()
const EXPECTED_WORDS = SAMPLE.trim().split(/\s+/).length;

try {
  for (const target of ['/visualizar', '/pdf']) {
    console.log('  -- ' + target);
    let dom = '';
    try {
      const url = BASE + '/_probe.html?go=' + encodeURIComponent(target);
      dom = dumpDomReady(browser, url, target === '/pdf' ? previewReady : null);
    } catch (err) {
      check(target + ' carregou', false, err.message);
      continue;
    }

    check(
      target + ' carrega base, markdown e app.css',
      ['/css/base.css', '/css/markdown.css', '/css/app.css'].every((c) => dom.includes('href="' + c)),
      'o app.css não deve ser removido da página'
    );

    check(target + ' não tem aviso de erro', !/Não foi possível renderizar|Erro na pré-visualização/.test(dom));
    check(target + ' tem conteúdo visível', dom.replace(/<[^>]+>/g, ' ').replace(/\s+/g, '').length > 200);
    check(
      target + ' não mostrou "[object Object]"',
      !/\[object Object\]/.test(dom),
      'um objeto foi usado como texto'
    );
    check(
      target + ' não deixou o editor vazio',
      editorWords(dom) === EXPECTED_WORDS,
      'contador=' + editorWords(dom) + ' esperado=' + EXPECTED_WORDS
    );

    if (target === '/visualizar') {
      const doc = innerOf(dom, 'doc') || '';
      check('visualizador renderizou o markdown', doc.includes('Título de Teste'), 'len=' + doc.length);
      check('visualizador manteve negrito/itálico', /<strong>/.test(doc) && /<em>/.test(doc));
      check('visualizador formatou a tabela', /<table/.test(doc));
      check('visualizador montou o sumário', (innerOf(dom, 'outline-list') || '').includes('Seção Um'));
      check('visualizador contou palavras', /\d+ palavras/.test(dom));
    } else {
      const prev = innerOf(dom, 'preview-pages') || '';
      check('pdf renderizou o markdown', prev.includes('Título de Teste'), 'len=' + prev.length);
      check('Paged.js gerou folhas', /pagedjs_sheet/.test(prev));
      const sheets = (prev.match(/class="pagedjs_sheet"/g) || []).length;
      check('Paged.js paginou mais de uma página', sheets > 1, 'folhas=' + sheets);
      check('folhas contêm o texto', /pagedjs_page_content/.test(prev));
      check('formatação preservada na prévia', /<strong>/.test(prev) && /<table/.test(prev));

      // O Paged.js só usa A4 e margens se o @page do previewCss chegar até
      // ele; caso contrário assume o padrão dele (Letter, margem 1in).
      check(
        'o @page de tamanho A4 chegou ao Paged.js',
        /--pagedjs-width:\s*210mm/.test(dom) && /--pagedjs-height:\s*297mm/.test(dom),
        'o Paged.js está no padrão Letter 8.5in'
      );
      check(
        'as margens do @page foram aplicadas',
        /--pagedjs-margin-top:\s*20mm/.test(dom) && /--pagedjs-margin-left:\s*18mm/.test(dom),
        'margens não chegaram ao Paged.js'
      );

      const info = /id="pages-info"[^>]*>([^<]{0,40})/.exec(dom);
      check(
        'contador de páginas foi atualizado',
        info && /página/.test(info[1]) && !/^—/.test(info[1].trim()),
        'pages-info=' + (info ? info[1] : '(ausente)')
      );
      const counts = [...dom.matchAll(/--pagedjs-page-count:\s*(\d+)/g)].map((m) => Number(m[1]));
      check(
        'o total do Paged.js bate com o contador',
        counts.length > 0 && counts[counts.length - 1] === sheets,
        'contador=' + counts.join(',') + ' folhas=' + sheets
      );
    }
    console.log('');
  }

  /* ---------------------------------------------------------------
     O sumário do visualizador precisa sobreviver a sair e voltar.
     --------------------------------------------------------------- */
  console.log('  -- /visualizar: o sumário guarda o estado');
  let sumario = null;
  try {
    fs.writeFileSync(CLICK, frameHtml('/visualizar', viewerOutlineBody()), 'utf8');
    sumario = frameReport(dumpDom(browser, BASE + '/_click.html', 60000));
  } catch (err) {
    check('sumário do visualizador', false, err.message);
  }
  if (sumario) {
    check('o clique no botão muda o estado do sumário', typeof sumario.depoisDoClique === 'boolean', JSON.stringify(sumario));
    check('o estado do sumário sobrevive a navegar e voltar', sumario.depoisDoClique === sumario.aposVoltar, JSON.stringify(sumario));
    check('o botão reflete o estado do sumário', sumario.btnLigado === true, JSON.stringify(sumario));
  }
  console.log('');

  /* ---------------------------------------------------------------
     A tela dividida precisa continuar utilizável depois de paginar.

     O Paged.js descarta a condição `print` do CSS que recebe e joga as
     regras na tela. As regras de impressão escondem a interface com
     `display: none !important`, então a tela dividida desmontava: o editor
     ficava com 0x0 e a prévia tomava a janela, engolindo o editor e o
     botão de baixar. Só a área real dos elementos denuncia isso.
     --------------------------------------------------------------- */
  console.log('  -- /pdf: a interface continua utilizável');
  fs.writeFileSync(CLICK, frameHtml('/pdf', pdfFrameBody()), 'utf8');
  let ui = null;
  try {
    ui = frameReport(dumpDom(browser, BASE + '/_click.html', 60000));
  } catch (err) {
    check('interface do /pdf', false, err.message);
  }
  if (ui) {
    check('a tela dividida continua em grid', ui.splitDisplay === 'grid', 'display=' + ui.splitDisplay);
    check('o editor ocupa metade da tela', ui.split.w > 200 && ui.split.h > 300, JSON.stringify(ui.split));
    check('a prévia ocupa a outra metade', ui.preview.w > 200 && ui.preview.h > 300, JSON.stringify(ui.preview));
    check('o editor é clicável', ui.editor.noAlvo === true, JSON.stringify(ui.editor));
    check('o editor aceita digitação', ui.aceitouDigitacao === true);
    check('o botão Baixar PDF é clicável', ui.baixar.noAlvo === true, JSON.stringify(ui.baixar));
    check(
      'o clique percorreu o caminho até o download',
      typeof ui.baixou === 'string' && /\.pdf$/.test(ui.baixou),
      'baixou=' + JSON.stringify(ui.baixou)
    );
    check('o botão de ajustes é clicável', ui.ajustes.noAlvo === true, JSON.stringify(ui.ajustes));
  }
  console.log('');

  /* ---------------------------------------------------------------
     Texto escrito na home precisa chegar nas ferramentas
     --------------------------------------------------------------- */
  console.log('  -- passagem da home para as ferramentas');
  for (const [target, marker] of [['/visualizar', 'doc'], ['/pdf', 'preview-pages']]) {
    let dom = '';
    try {
      dom = dumpDomReady(
        browser,
        BASE + '/_probe.html?home=1&go=' + encodeURIComponent(target),
        target === '/pdf' ? previewReady : null
      );
    } catch (err) {
      check('home -> ' + target, false, err.message);
      continue;
    }
    check('home -> ' + target + ': o texto chegou ao editor', editorWords(dom) === EXPECTED_WORDS, 'contador=' + editorWords(dom) + ' esperado=' + EXPECTED_WORDS);
    check('home -> ' + target + ': o texto foi renderizado', (innerOf(dom, marker) || '').includes('Título de Teste'));
    check('home -> ' + target + ': sem "[object Object]"', !/\[object Object\]/.test(dom));
  }
  console.log('');

  /* ---------------------------------------------------------------
     A gaveta do editor precisa ter como sair
     --------------------------------------------------------------- */
  console.log('  -- gaveta do editor (visualizador)');
  {
    let dom = '';
    try {
      dom = dumpDom(browser, BASE + '/visualizar');
    } catch (err) {
      check('gaveta: página carregou', false, err.message);
    }
    if (dom) {
      check('gaveta começa fechada', /id="drawer"[^>]*aria-hidden="true"/.test(dom));
      check('gaveta existe botão de fechar', /id="btn-close-drawer"/.test(dom));
      check('existe fundo clicável', /id="drawer-backdrop"/.test(dom));
      check('fundo começa escondido', /id="drawer-backdrop"[^>]*hidden/.test(dom));
      // z-index do fundo tem de ficar abaixo da gaveta, senão o clique não passa
      const backdrop = Number((appCss.match(/\.v-drawer-backdrop\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
      const drawer = Number((appCss.match(/\.v-drawer\s*\{[^}]*z-index:\s*(\d+)/) || [])[1]);
      check('o fundo fica atrás da gaveta', backdrop && drawer && backdrop < drawer, 'backdrop=' + backdrop + ' drawer=' + drawer);
      check('a gaveta é movida para fora da tela ao fechar', /translateX\(-102%\)/.test(appCss));
    }
  }
  console.log('');

  /* ---------------------------------------------------------------
     Clicar de verdade na gaveta, num iframe de mesma origem.

     Ler o HTML não basta: um botão pode estar no DOM e o listener não
     responder — foi assim que um js/css velho no cache virou um botão
     morto sem erro nenhum no console.
     --------------------------------------------------------------- */
  console.log('  -- gaveta: clique de verdade');
  fs.writeFileSync(CLICK, clickHtml(), 'utf8');
  let report = null;
  try {
    report = frameReport(dumpDom(browser, BASE + '/_click.html', 45000));
  } catch (err) {
    check('clique na gaveta', false, err.message);
  }
  if (report) {
    check('o botão da barra abre a gaveta', report.abriu === true, JSON.stringify(report.abriu));
    check('com a gaveta aberta ela cobre a tela', report.leftAberto === 0, 'left=' + report.leftAberto);
    check('o botão Fechar está visível e clicável', report.btnVisivel && report.btnDescoberto, JSON.stringify({ visivel: report.btnVisivel, descoberto: report.btnDescoberto }));
    check('o botão Fechar fecha a gaveta', report.fechou === true && report.leftFechado < 0, JSON.stringify({ fechou: report.fechou, left: report.leftFechado }));
    check('o fundo some ao fechar', report.fundoEscondido === true);
    check('clicar no fundo também fecha', report.fundoFecha === true && report.leftDepoisFundo < 0, JSON.stringify({ fecha: report.fundoFecha, left: report.leftDepoisFundo }));
  }
  console.log('');

  /* ---------------------------------------------------------------
     /formatar: a promessa da página é transformar uma linha ilegível
     em leitura — então é isso que a sonda confere, no navegador de
     verdade: linhas numeradas, cor do realce e o aviso de `\n`
     literal com o botão que o converte.
     --------------------------------------------------------------- */
  console.log('  -- /formatar: formatação no navegador');
  fs.writeFileSync(CLICK, frameHtml('/formatar', formatFrameBody()), 'utf8');
  let fmt = null;
  try {
    fmt = frameReport(dumpDom(browser, BASE + '/_click.html', 60000));
  } catch (err) {
    check('/formatar no navegador', false, err.message);
  }
  if (fmt) {
    check('/formatar: a página abriu sem erro', !fmt.erro, JSON.stringify(fmt.erro));
    check('/formatar: JSON de uma linha vira várias', fmt.linhas > 4, 'linhas=' + fmt.linhas);
    check('/formatar: o tipo foi detectado como JSON', fmt.badge === 'JSON', 'badge=' + fmt.badge);
    check('/formatar: a primeira linha numerada é 1', fmt.primeiraNum === '1', 'num=' + fmt.primeiraNum);
    check('/formatar: a prévia sai colorida', fmt.realce === true);
    check('/formatar: copiar e baixar habilitam com conteúdo', fmt.copiar === true && fmt.baixar === true);
    check('/formatar: o painel de texto aparece na família certa', fmt.grupoTexto === true);
    check('/formatar: o aviso de \\n literal foi exibido', fmt.dicaAlerta === true);
    check('/formatar: o botão de converter aparece', fmt.temBotaoConverter === true);
    check('/formatar: converter o \\n dá duas linhas', fmt.linhasDepois === 2, 'linhas=' + fmt.linhasDepois);
    check('/formatar: o checkbox de converter ficou ligado', fmt.checkboxLigado === true);
    check('/formatar: o grupo JSON aparece quando a entrada é JSON', fmt.grupoJson === true);
    check(
      '/formatar: remover 1 nível de escape vira JSON formatado',
      fmt.temOpcaoEscape === true && fmt.escapeVirouJson === true,
      JSON.stringify(fmt)
    );
    check(
      '/formatar: o texto sai em uma linha só escapado',
      fmt.temOpcaoUmaLinha === true && fmt.umaLinhaSo === true,
      JSON.stringify(fmt)
    );
    check('/formatar: virar string desliga a conversão de \\n', fmt.unescapeDesligado === true);
  }
  console.log('');

  /* ---------------------------------------------------------------
     Salas compartilhadas: /notas e /drive. A semeadura das salas é
     assíncrona (só existe fetch no evento do Node) e o resto da sonda é
     síncrono, então ela roda num filho e devolve os ids. As páginas de
     sala são conferidas em tempo real pelo helper CDP: com o SSE aberto,
     o --dump-dom de orçamento virtual nunca sai do "conectando".
     --------------------------------------------------------------- */
  function apiDeFilho(codigo) {
    const r = spawnSync(process.execPath, ['-e', codigo], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) {
      throw new Error((r.stderr || '').trim().slice(0, 300) || 'semeio das salas falhou');
    }
    return r.stdout;
  }

  /** O que o helper CDP extraiu via expressão (vira comentário no dump). */
  function extraDe(dom) {
    const m = /<!--extra:([\s\S]*?)-->/.exec(dom);
    return m ? m[1] : '';
  }

  /** Duas cópias da mesma sala lado a lado: uma digita, a outra recebe. */
  function duploHtml(rota) {
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>quadro duplo</title></head>
<body>
<pre id="out"></pre>
<iframe id="a" style="width:690px;height:620px;border:0"></iframe>
<iframe id="b" style="width:690px;height:620px;border:0"></iframe>
<script>
var A = document.getElementById('a'), B = document.getElementById('b');
function report(r) { document.getElementById('out').textContent = JSON.stringify(r); }
var carregados = 0;
function aoCarregar() {
  if (++carregados < 2) return;
  setTimeout(testar, 2500); // deixa o estado chegar e o canal abrir nos dois
}
function testar() {
  try {
    var ta = A.contentDocument.getElementById('nt-texto');
    if (!ta) return report({ erro: 'sem editor no quadro A' });
    var marcador = 'pingue da sonda ' + Date.now();
    ta.value = marcador;
    ta.dispatchEvent(new A.contentWindow.Event('input', { bubbles: true }));
    setTimeout(function () {
      var tb = B.contentDocument.getElementById('nt-texto');
      var oa = A.contentDocument.getElementById('nt-online');
      var ob = B.contentDocument.getElementById('nt-online');
      report({
        marcador: marcador,
        chegou: !!tb && tb.value === marcador,
        textoB: tb ? String(tb.value).slice(0, 60) : null,
        onlineA: oa ? oa.textContent : null,
        onlineB: ob ? ob.textContent : null,
      });
    }, 2500);
  } catch (e) { report({ erro: String(e) }); }
}
A.addEventListener('load', aoCarregar);
B.addEventListener('load', aoCarregar);
A.src = ${JSON.stringify(rota)};
B.src = ${JSON.stringify(rota)};
</script></body></html>`;
  }

  console.log('  -- salas: páginas de criação');
  for (const alvo of ['/notas', '/drive']) {
    try {
      const dom = dumpDom(browser, BASE + alvo);
      check(
        alvo + ' carrega com o painel de criar',
        dom.includes(alvo === '/notas' ? 'nt-criar-btn' : 'dv-criar-btn')
      );
      check(alvo + ' traz os scripts das salas', dom.includes('/js/salas.js'));
      check(alvo + ' não mostra "[object Object]"', !/\[object Object\]/.test(dom));
    } catch (err) {
      check(alvo + ' carrega', false, err.message);
    }
  }

  let semeada = null;
  try {
    semeada = JSON.parse(
      apiDeFilho(
      'const base = ' + JSON.stringify(BASE) + ';' +
        "const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });" +
        '(async () => {' +
        "  const nota = await (await post('/api/notas', {})).json();" +
        "  await post('/api/notas/' + nota.id, { texto: 'recado da sonda' });" +
        "  const drive = await (await post('/api/drive', {})).json();" +
        "  const nome = 'relatório da sonda.txt';" +
        "  const up = await fetch(base + '/api/drive/' + drive.id + '/arquivos?nome=' + encodeURIComponent(nome), { method: 'POST', body: 'conteudo da sonda' });" +
        "  if (up.status !== 201) throw new Error('upload recusado: ' + up.status);" +
        '  return { nota: nota.id, drive: drive.id, nome: nome };' +
        '})().then(function (r) { console.log(JSON.stringify(r)); }, function (e) { console.error(String(e)); process.exit(1); });'
      )
    );
  } catch (err) {
    check('semeio das salas pela API', false, err.message);
  }

  if (semeada) {
    console.log('  -- salas: sala de notas em tempo real');
    let salaDom = null;
    try {
      salaDom = dumpDomReady(
        browser,
        BASE + '/notas/' + semeada.nota,
        'conectado',
        'document.getElementById("nt-texto").value.slice(0, 80)'
      );
    } catch (err) {
      check('/notas/<sala> abre no navegador', false, err.message);
    }
    if (salaDom) {
      check('/notas/<sala> conecta no canal de atualizações', /id="nt-status"[^>]*>conectado</.test(salaDom));
      check('/notas/<sala> mostra o texto da sala', extraDe(salaDom).includes('recado da sonda'), extraDe(salaDom));
      check('/notas/<sala> não mostra "[object Object]"', !/\[object Object\]/.test(salaDom));
    }

    console.log('  -- salas: porta de senha');
    try {
      const privada = apiDeFilho(
        'fetch(' + JSON.stringify(BASE + '/api/notas') +
          ", { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senha: 'x' }) })" +
          '.then(function (r) { return r.json(); }).then(function (j) { console.log(j.id); })'
      ).trim();
      const dom = dumpDomReady(browser, BASE + '/notas/' + privada, 'pedindoSenha');
      check('/notas privada para no pedido de senha', /<section[^>]*id="nt-senha"/.test(dom));
      check('/notas privada não entrega o editor', !/<section class="sala-mesa" id="nt-sala">/.test(dom));
    } catch (err) {
      check('/notas privada pede a senha', false, err.message);
    }

    console.log('  -- salas: drive em tempo real');
    try {
      const dom = dumpDomReady(browser, BASE + '/drive/' + semeada.drive, 'conectado');
      check('/drive/<sala> conecta no canal de atualizações', /id="dv-status"[^>]*>conectado</.test(dom));
      check('/drive/<sala> lista o arquivo enviado', dom.includes(semeada.nome));
      check('/drive/<sala> traz o link de download', /\/arquivos\//.test(dom));
    } catch (err) {
      check('/drive/<sala> abre no navegador', false, err.message);
    }

    console.log('  -- salas: dois quadros escrevendo juntos');
    fs.writeFileSync(DUPLO, duploHtml('/notas/' + semeada.nota), 'utf8');
    let duplo = null;
    try {
      duplo = frameReport(dumpDomReady(browser, BASE + '/_duplo.html', 'relatorio'));
    } catch (err) {
      check('a sonda de dois quadros terminou', false, err.message);
    }
    fs.rmSync(DUPLO, { force: true });
    if (duplo) {
      check('o que um digita chega no outro quadro', duplo.chegou === true, JSON.stringify(duplo));
      check(
        'os dois quadros veem as duas pessoas online',
        duplo.onlineA === '2' && duplo.onlineB === '2',
        JSON.stringify(duplo)
      );
    }
  }
  console.log('');
} finally {
  fs.rmSync(PROBE, { force: true });
  fs.rmSync(CLICK, { force: true });
  fs.rmSync(DUPLO, { force: true });
}

console.log(
  failures ? '\n' + failures + ' falha(s) de renderização\n' : '\nRenderização verificada em navegador real.\n'
);
process.exit(failures ? 1 : 0);
