'use strict';

/**
 * Markdown -> PDF usando o Chrome (headless) em vez do PDFKit.
 *
 * O layout é o mesmo da pré-visualização: o HTML sai de `markdown.js`, o CSS
 * de página reproduz o de `public/js/pdf.js` e o Paged.js pagina no navegador
 * — é ele que resolve numeração de página, cabeçalho/rodapé e quebras, coisas
 * que o print nativo do Chrome não dá conta sozinho. No fim, o Chrome imprime
 * a página já paginada pelo DevTools Protocol (`Page.printToPDF`), esperando o
 * Paged.js confirmar o trabalho antes de imprimir — assim o PDF nunca sai em
 * branco ou com fonte substituta por causa de corrida de tempo.
 *
 * Fica desligado por padrão: só entra em cena quando `USER_CHROME` está ligado.
 * Sem Chrome disponível, quem chama deve cair no gerador atual (PDFKit).
 */

const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { render } = require('./markdown');
const { parseFrontMatter, resolveTitle } = require('./pdf');
const { normalize, mix } = require('./settings');
const fonts = require('./fonts');
const shared = require('../../public/js/shared-settings.js');

const ROOT = path.join(__dirname, '..', '..');
const PAGED_JS = path.join(ROOT, 'public', 'vendor', 'paged.js');

/** Tempo virtual (ms) que o Chrome pode "gastar" esperando o Paged.js. */
const VIRTUAL_TIME_BUDGET = Number(process.env.CHROME_PDF_BUDGET) || 20000;
/** Tempo de parede (ms) antes de desistir do processo do Chrome. */
const PROCESS_TIMEOUT = Number(process.env.CHROME_PDF_TIMEOUT) || 90000;
/** Tempo (ms) que o CDP espera o Paged.js confirmar a paginação. */
const CDP_TIMEOUT = Number(process.env.CHROME_PDF_CDP_TIMEOUT) || 30000;

/** Log de diagnóstico do modo CDP (liga com CHROME_PDF_DEBUG=1). */
function dbg() {
  if (process.env.CHROME_PDF_DEBUG !== '1') return;
  console.error('[pdf:debug]', ...arguments);
}

const FALSY = new Set(['', '0', 'false', 'no', 'off', 'nao', 'não', 'null', 'undefined']);

function flagOn(value) {
  if (value === undefined || value === null) return false;
  return !FALSY.has(String(value).trim().toLowerCase());
}

/**
 * O usuário escolheu converter pelo Chrome?
 *
 * Vale `USER_CHROME` (nome pedido) e, como apelido, `USE_CHROME`. Qualquer
 * coisa diferente de false/0/off liga o modo; ausente ou "false" mantém o
 * gerador atual.
 */
function chromeEnabled() {
  return flagOn(process.env.USER_CHROME) || flagOn(process.env.USE_CHROME);
}

/* ------------------------------------------------------------------ *
 * Localização do executável
 * ------------------------------------------------------------------ */

/** Nomes de executável procurados dentro de um diretório. */
function executableNames() {
  if (process.platform === 'win32') return ['chrome.exe', 'msedge.exe', 'chromium.exe'];
  if (process.platform === 'darwin') {
    return [
      path.join('Contents', 'MacOS', 'Google Chrome'),
      path.join('Contents', 'MacOS', 'Chromium'),
      path.join('Contents', 'MacOS', 'Microsoft Edge'),
      'chrome',
      'chromium',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge', 'microsoft-edge-stable'];
}

/** Caminhos conhecidos por sistema operacional. */
function platformCandidates() {
  const out = [];

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'],
      process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const bases = [
      path.join('Google', 'Chrome', 'Application'),
      path.join('Microsoft', 'Edge', 'Application'),
    ];
    for (const root of roots) {
      for (const base of bases) {
        for (const name of ['chrome.exe', 'msedge.exe']) {
          out.push(path.join(root, base, name));
        }
      }
    }
    return out;
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ];
}

/** Procura o executável no PATH do sistema. */
function fromPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe']
    : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];

  for (const name of names) {
    try {
      const output = execFileSync(finder, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    } catch (err) {
      /* não está no PATH; tenta o próximo */
    }
  }
  return null;
}

let cachedBrowser;

/** Caminho do Chrome/Chromium/Edge, ou null se não houver. */
function resolveChrome() {
  if (cachedBrowser !== undefined) return cachedBrowser;

  const candidates = [];
  const explicit = String(process.env.DIR_CHROME || '').trim();

  if (explicit) {
    try {
      if (fs.statSync(explicit).isFile()) candidates.push(explicit);
    } catch (err) {
      /* pode ser um diretório */
    }
    for (const name of executableNames()) candidates.push(path.join(explicit, name));
  }

  candidates.push(...platformCandidates());

  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) {
        cachedBrowser = candidate;
        return cachedBrowser;
      }
    } catch (err) {
      /* segue para o próximo */
    }
  }

  cachedBrowser = fromPath();
  return cachedBrowser;
}

/** Só para testes: esquece o que foi detectado. */
function resetChromeCache() {
  cachedBrowser = undefined;
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Seria seguro embutir um valor dentro de <script> como JSON. */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Valor de `font-family` para o CSS de impressão. */
function fontStack(key, fallbackKey, installed) {
  if (Object.prototype.hasOwnProperty.call(shared.FONT_FAMILIES, key)) {
    return shared.FONT_FAMILIES[key].css;
  }
  const descriptor = installed.find((item) => item.key === key);
  if (descriptor) return '"' + descriptor.family + '", serif';
  const fallback = shared.FONT_FAMILIES[fallbackKey];
  return fallback ? fallback.css : 'serif';
}

/** Conta os títulos e devolve o bloco HTML do sumário. */
function buildToc(headings, settings) {
  const usable = (headings || []).filter((item) => item.level <= settings.tocDepth);
  if (!settings.showToc || !usable.length) return '';

  const items = usable
    .map((item) => {
      const indent = Math.max(0, item.level - 1) * 14;
      return (
        '<li style="margin-left:' + indent + 'px">' +
        '<a href="#' + escapeHtml(item.id) + '">' + escapeHtml(item.text) + '</a></li>'
      );
    })
    .join('');

  return (
    '<nav class="md-toc">' +
    '<div class="md-toc-title">Sumário</div>' +
    '<ul>' + items + '</ul>' +
    '</nav>'
  );
}

/**
 * CSS de página: reproduz `previewCss()` de `public/js/pdf.js` para o PDF do
 * Chrome sair igual à pré-visualização, mais o fundo do tema (que na prévia
 * vem do painel e aqui precisa ser pintado em cada folha).
 */
function printCss(settings, installed) {
  const size = shared.PAGE_SIZES[settings.pageSize] || shared.PAGE_SIZES.A4;
  const landscape = settings.orientation === 'landscape';
  const width = landscape ? size.height : size.width;
  const height = landscape ? size.width : size.height;

  const font = fontStack(settings.fontFamily, settings.fontFamily, installed);
  const heading = settings.headingFontFamily === 'inherit'
    ? font
    : fontStack(settings.headingFontFamily, settings.fontFamily, installed);

  const muted = mix(settings.textColor, settings.backgroundColor, 0.45);
  const scales = [2.05, 1.58, 1.3, 1.14, 1.02, 0.95];
  const headingCss = scales
    .map((scale, i) => {
      const level = i + 1;
      const margin = settings.paragraphSpacing / 3;
      return (
        '#preview-pages h' + level + ' {' +
        'font-size:' + (settings.fontSize * scale * settings.headingScale).toFixed(2) + 'pt;' +
        'margin:' + (level === 1 ? 0 : margin * 1.8) + 'pt 0 ' + margin * 0.7 + 'pt;' +
        'line-height:1.25;' +
        'color:' + settings.headingColor + ';' +
        (level === 1 ? 'border-bottom:1px solid ' + settings.accentColor + '55;padding-bottom:6pt;' : '') +
        '}'
      );
    })
    .join('\n');

  const position = settings.pageNumberPosition || 'footer-center';
  const onFooter = position.indexOf('footer') === 0;
  const align = position.split('-')[1] || 'center';
  const box = (onFooter ? 'bottom' : 'top') + '-' + align;
  const counterFormat =
    settings.pageNumberFormat === 'roman'
      ? 'counter(page, lower-roman)'
      : settings.pageNumberFormat === 'arabic-total'
      ? 'counter(page) " / " counter(pages)'
      : 'counter(page)';

  const furniture =
    (settings.pageNumbers
      ? '@page { @' + box + ' { content: ' + counterFormat + '; font: ' + (settings.fontSize - 2.4).toFixed(1) + 'pt ' + font + '; color: ' + muted + '; } }'
      : '') +
    (settings.runningTitle || (settings.runningTitle === '' && false)
      ? ''
      : '#preview-pages h1 { string-set: running content(); } @page { @top-left { content: string(running); font: ' +
        (settings.fontSize - 2.4).toFixed(1) + 'pt ' + font + '; color: ' + muted + '; } }');

  const listMarker = shared.LIST_STYLES[settings.listStyle].css;

  return `
@page {
  size: ${width}mm ${height}mm;
  margin: ${settings.margins.top}mm ${settings.margins.right}mm ${settings.margins.bottom}mm ${settings.margins.left}mm;
}
${furniture}

#preview-pages {
  font-family: ${font};
  font-size: ${settings.fontSize}pt;
  line-height: ${settings.lineHeight};
  letter-spacing: ${settings.letterSpacing}pt;
  color: ${settings.textColor};
  text-align: ${settings.textAlign === 'justify' ? 'justify' : settings.textAlign};
  hyphens: ${settings.hyphenation ? 'auto' : 'manual'};
}
#preview-pages p { margin: 0 0 ${settings.paragraphSpacing}pt; text-indent: ${settings.firstLineIndent}mm; }
#preview-pages h1, #preview-pages h2, #preview-pages h3,
#preview-pages h4, #preview-pages h5, #preview-pages h6 {
  font-family: ${heading};
  font-weight: 700;
  letter-spacing: 0;
  /* Título não herda o justify do corpo: com uma palavra por linha ele
     esticaria tudo (palavra na esquerda, outra na direita). */
  text-align: left;
  break-after: avoid;
}
${headingCss}
#preview-pages ul, #preview-pages ol { margin: 0 0 ${settings.paragraphSpacing}pt; padding-left: 5mm; }
#preview-pages ul { list-style-type: ${listMarker}; }
#preview-pages li { margin: 0.6mm 0; break-inside: avoid; }
#preview-pages li > ul, #preview-pages li > ol { margin-top: 0.6mm; }
#preview-pages li::marker { color: ${settings.accentColor}; }
#preview-pages blockquote {
  margin: ${settings.paragraphSpacing / 2}pt 0;
  padding: 2pt 0 2pt 4mm;
  border-left: 2pt solid ${settings.accentColor};
  color: ${muted};
}
#preview-pages blockquote p { text-indent: 0; }
#preview-pages hr { border: 0; border-top: 0.6pt solid ${settings.borderColor}; margin: ${settings.paragraphSpacing * 1.4}pt 0; }
#preview-pages a { color: ${settings.linkColor}; text-decoration: underline; }
#preview-pages code {
  font-family: Consolas, "Courier New", monospace;
  font-size: 0.88em;
  color: ${settings.codeColor};
}
#preview-pages pre {
  background: ${settings.codeBackground};
  border: 0.6pt solid ${settings.borderColor};
  border-radius: 2pt;
  padding: 5pt 6pt;
  margin: ${settings.paragraphSpacing / 2}pt 0;
  white-space: pre-wrap;
  word-break: break-word;
  break-inside: auto;
  font-size: ${(settings.fontSize * 0.82).toFixed(2)}pt;
  line-height: 1.4;
}
#preview-pages pre code { color: inherit; background: none; font-size: 1em; }
#preview-pages table {
  width: 100%;
  border-collapse: collapse;
  margin: ${settings.paragraphSpacing / 2}pt 0;
  font-size: ${(settings.fontSize * 0.95).toFixed(2)}pt;
}
#preview-pages th, #preview-pages td {
  border: 0.35pt solid ${settings.textColor};
  padding: 3pt 4pt;
  text-align: left;
}
#preview-pages th { background: ${mix(settings.accentColor, settings.backgroundColor, 0.14)}; font-weight: 700; }
#preview-pages tr { break-inside: avoid; }
#preview-pages img { max-width: ${settings.imageMaxWidth}%; height: auto; break-inside: avoid; }
#preview-pages .md-table-wrap { overflow: visible; }

/* Sumário */
#preview-pages .md-toc { break-after: page; }
#preview-pages .md-toc-title {
  font-family: ${heading};
  font-weight: 700;
  font-size: ${(settings.fontSize * 1.5).toFixed(2)}pt;
  color: ${settings.headingColor};
  margin: 0 0 ${settings.paragraphSpacing * 0.6}pt;
}
#preview-pages .md-toc ul { list-style: none; margin: 0; padding: 0; }
#preview-pages .md-toc li { margin: 0 0 ${settings.paragraphSpacing * 0.35}pt; }
#preview-pages .md-toc a { color: ${settings.textColor}; text-decoration: none; }
#preview-pages .md-toc a::after { content: target-counter(attr(href), page); float: right; color: ${muted}; }

/* Cada folha carrega o fundo do tema. Na prévia isso vem do painel branco;
   aqui a folha precisa ser pintada e o Chrome precisa imprimir a cor. */
.pagedjs_page {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  background: ${settings.backgroundColor} !important;
}

/* Conteúdo de emergência: fica visível no <body> e só some quando a
   paginação confirma (data-pagedjs-ready). É o que garante que um PDF em
   branco é impossível mesmo se o Paged.js não completar. */
#fallback-content { margin: 0; }
[data-pagedjs-ready] #fallback-content { display: none; }
`;
}

/** Regras @font-face com o arquivo embutido em base64 (sem depender de rede). */
async function embeddedFaces(settings, installed) {
  const weights = { normal: 400, bold: 700, italic: 400, boldItalic: 700 };
  const styles = { normal: 'normal', bold: 'normal', italic: 'italic', boldItalic: 'italic' };

  const wanted = new Set([settings.fontFamily]);
  if (settings.headingFontFamily !== 'inherit') wanted.add(settings.headingFontFamily);

  const rules = [];
  for (const key of wanted) {
    const descriptor = installed.find((item) => item.key === key);
    if (!descriptor || !descriptor.files) continue;
    for (const [variant, file] of Object.entries(descriptor.files)) {
      try {
        const buffer = await fsp.readFile(path.join(fonts.FONT_DIR, file));
        rules.push(
          '@font-face{font-family:"' + descriptor.family + '";font-style:' + (styles[variant] || 'normal') +
          ';font-weight:' + (weights[variant] || 400) +
          ';src:url(data:font/ttf;base64,' + buffer.toString('base64') + ') format("truetype")}'
        );
      } catch (err) {
        /* arquivo sumiu: segue sem essa variação */
      }
    }
  }

  return rules.join('\n');
}

/**
 * Monta o documento HTML que o Chrome vai imprimir.
 * @returns {Promise<string>}
 */
async function buildHtml(source, rawSettings, options = {}) {
  const settings = normalize(rawSettings);
  const { meta, body } = parseFrontMatter(source);
  const title = resolveTitle(body, meta, options.fallbackName || 'Documento');
  const result = render(body, { headings: true });

  /* `loading="lazy"` some em páginas que o Chrome não rolou; na impressão a
     imagem precisa estar carregada antes da hora. */
  const contentHtml = String(result.html || '').replace(/loading="lazy"/g, 'loading="eager"');
  const installed = await fonts.list();
  const toc = buildToc(result.headings, settings);
  const content = '<div id="preview-pages">' + toc + contentHtml + '</div>';
  const css = printCss(settings, installed);
  const faces = await embeddedFaces(settings, installed);

  /* Famílias em uso: servem para o JS carregar as fontes de forma explícita
     antes de paginar (ver loadExternalFonts no bootstrap). */
  const bodyFont = fontStack(settings.fontFamily, settings.fontFamily, installed);
  const headingFont = settings.headingFontFamily === 'inherit'
    ? bodyFont
    : fontStack(settings.headingFontFamily, settings.fontFamily, installed);

  const bootstrap = `
(function () {
  var CONTENT = ${jsonForScript(content)};
  var CSS = ${jsonForScript(css)};
  var FONT_STACKS = ${jsonForScript([bodyFont, headingFont])};
  var target = document.getElementById('pages');
  var fallback = document.getElementById('fallback-content');
  function fontsReady() {
    if (!document.fonts || !document.fonts.ready) return Promise.resolve();
    return document.fonts.ready.then(function () {}, function () {});
  }
  /* Carrega as famílias em uso antes de paginar. Foi necessário porque o
     Chrome às vezes imprimia antes da fonte externa ficar pronta (PDF com
     fonte substituta) ou ficava esperando a fonte para sempre (página em
     branco). Forçar o download resolve os dois casos. */
  function loadExternalFonts() {
    if (!document.fonts || typeof document.fonts.load !== 'function') return Promise.resolve();
    var guard = new Promise(function (resolve) { setTimeout(resolve, 8000); });
    var loads = FONT_STACKS.map(function (stack) {
      return document.fonts.load('16px ' + stack, 'Àg 0123')
        .then(function () {}, function () {});
    });
    return Promise.race([Promise.all(loads), guard]);
  }
  window.addEventListener('load', function () {
    if (!window.Paged || typeof window.Paged.Previewer !== 'function') {
      document.documentElement.setAttribute('data-pagedjs-error', 'Paged.js nao carregado');
      return;
    }
    var previewer = new window.Paged.Previewer();
    loadExternalFonts()
      .then(fontsReady)
      .then(function () {
        return previewer.preview(CONTENT, [{ 'chrome-print.css': CSS }], target);
      })
      .then(function () {
        /* O <main id="pages"> nasce vazio e o fallback (visível por padrão) só
           some quando a paginação confirma as folhas. Assim um PDF em branco
           é impossível: se o Paged.js falhar ou estourar o tempo, o Chrome
           imprime o conteúdo cru em vez de nada. */
        if (!target || target.querySelectorAll('.pagedjs_page').length === 0) {
          document.documentElement.setAttribute('data-pagedjs-error', 'Paged.js nao gerou paginas');
          return;
        }
        document.documentElement.setAttribute('data-pagedjs-ready', '1');
        /* Esconde o fallback por estilo inline (e não só por CSS): o polisher
           do Paged.js pode descartar a regra e o conteúdo cru imprimiria
           duplicado junto com as folhas paginadas. */
        if (fallback) fallback.style.display = 'none';
      })
      .catch(function (err) {
        document.documentElement.setAttribute('data-pagedjs-error', String((err && err.message) || err));
      });
  });
})();`;

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style data-pagedjs-ignore>
html, body { margin: 0; padding: 0; }
${faces}
</style>
<script src="${pathToFileURL(PAGED_JS).href}"></script>
</head>
<body>
<main id="pages"></main>
<div id="fallback-content">${content}</div>
<script>${bootstrap}</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Execução do Chrome
 * ------------------------------------------------------------------ */

/** Espera um tempo (tamanho em ms) antes de seguir. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Imprime o documento com o Chrome headless.
 *
 * Preferência pelo DevTools Protocol: o print só acontece depois que o
 * JavaScript confirma a paginação (`data-pagedjs-ready`), então `--print-to-pdf`
 * não estoura mais no meio do trabalho. Sem `WebSocket` global (Node anterior a
 * 22), usa o modo CLI, que ainda depende do orçamento de tempo virtual.
 *
 * @param {string} browser caminho do executável
 * @param {string} htmlPath
 * @param {string} pdfPath
 * @param {string} profile
 * @returns {Promise<void>}
 */
function runChrome(browser, htmlPath, pdfPath, profile) {
  if (typeof WebSocket === 'function') {
    return runChromeViaCdp(browser, htmlPath, pdfPath, profile).catch((err) => {
      console.warn('[pdf] CDP falhou, tentando o modo CLI: ' + err.message);
      return runChromeCli(browser, htmlPath, pdfPath, profile);
    });
  }
  return runChromeCli(browser, htmlPath, pdfPath, profile);
}

/** Modo legado: `--print-to-pdf` com orçamento de tempo virtual. */
function runChromeCli(browser, htmlPath, pdfPath, profile) {
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-application-cache',
    '--run-all-compositor-stages-before-draw',
    '--no-pdf-header-footer',
    '--print-to-pdf-no-header',
    '--virtual-time-budget=' + VIRTUAL_TIME_BUDGET,
    '--user-data-dir=' + profile,
    '--print-to-pdf=' + pdfPath,
    pathToFileURL(htmlPath).href,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      browser,
      args,
      { timeout: PROCESS_TIMEOUT, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (fs.existsSync(pdfPath)) {
          resolve();
          return;
        }
        const detail = String(stderr || (err && err.message) || '').trim().split(/\r?\n/).slice(-4).join('\n');
        const failure = new Error('O Chrome não gerou o PDF.' + (detail ? '\n' + detail : ''));
        failure.code = 'CHROME_PRINT_FAILED';
        reject(failure);
      }
    );
  });
}

/**
 * Modo DevTools Protocol: sobe o Chrome com a porta de depuração e pede a
 * impressão só depois de `data-pagedjs-ready`. É o que guarda o PDF de sair
 * em branco (Paged.js no meio do caminho) ou com fonte substituta.
 */
async function runChromeViaCdp(browser, htmlPath, pdfPath, profile) {
  const url = pathToFileURL(htmlPath).href;
  const deadline = Date.now() + CDP_TIMEOUT;

  const child = spawn(browser, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ], { windowsHide: true });

  return new Promise((resolve, reject) => {
    let ws = null;
    let settled = false;
    let stderrTail = '';
    let browserWs = null;

    function cleanup() {
      if (ws) { try { ws.close(); } catch (e) { /* ignora */ } }
      try { child.kill(); } catch (e) { /* ignora */ }
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function done() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    const bootTimeout = setTimeout(() => {
      fail(new Error('O Chrome não abriu a porta de depuração a tempo.'));
    }, 30000);

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      const m = stderrTail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m && !browserWs) {
        browserWs = m[1];
        clearTimeout(bootTimeout);
        run(browserWs).catch(fail);
      }
    });

    child.on('error', (err) => fail(err));

    async function run(wsUrl) {
      ws = new WebSocket(wsUrl);
      const pending = new Map();
      let nextId = 1;

      const send = (method, params = {}, sessionId) =>
        new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params, sessionId }));
        });

      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(String(event.data)); } catch (e) { return; }
        if (msg && msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.rej(new Error(msg.error.message));
          else p.res(msg);
        }
      });

      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('WebSocket do Chrome não abriu.')), { once: true });
      });

      dbg('ws aberto em', Date.now());
      const create = await send('Target.createTarget', { url: 'about:blank' });
      dbg('target criado');
      const attach = await send('Target.attachToTarget', { targetId: create.result.targetId, flatten: true });
      const sessionId = attach.result.sessionId;
      dbg('sessão', sessionId);

      await send('Page.enable', {}, sessionId);
      await send('Page.navigate', { url }, sessionId);
      dbg('navegou para', url);

      let status = 'incompleto';
      const t0 = Date.now();
      while (Date.now() < deadline) {
        const evalResult = await send('Runtime.evaluate', {
          expression: 'JSON.stringify({ready:document.documentElement.getAttribute("data-pagedjs-ready"),' +
            'error:document.documentElement.getAttribute("data-pagedjs-error")})',
          returnByValue: true,
        }, sessionId).catch((err) => {
          dbg('evaluate falhou:', err.message);
          return null;
        });

        /* Runtime.evaluate devolve { result: { result: { value } } }: o
           primeiro "result" é o retorno do método CDP, o segundo é o valor
           avaliado na página. */
        const cdp = evalResult && evalResult.result;
        const value = cdp && cdp.result && cdp.result.value;
        if (typeof value === 'string') {
          try {
            const state = JSON.parse(value);
            if (state.ready === '1') { status = 'ready'; break; }
            if (state.error) { status = 'error(' + state.error + ')'; break; }
          } catch (e) { /* tenta de novo no próximo poll */ }
        }
        if ((Date.now() - t0) % 3000 < 150) {
          dbg('poll em', Date.now() - t0 + 'ms =>', value);
        }
        await sleep(150);
      }
      dbg('fim da espera em', Date.now() - t0 + 'ms, status', status);

      if (status !== 'ready') {
        console.warn('[pdf] paginação incompleta (' + status + '); o fallback no HTML cobre o conteúdo.');
      }

      const tPrint = Date.now();
      const print = await send('Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      }, sessionId);
      dbg('printToPDF em', Date.now() - tPrint + 'ms');

      if (!print || !print.result || !print.result.data) {
        throw new Error('Page.printToPDF não devolveu dados.');
      }

      await fsp.writeFile(pdfPath, Buffer.from(print.result.data, 'base64'));
      done();
    }
  });
}

/**
 * Converte markdown em PDF com o Chrome.
 * @param {string} source
 * @param {object} rawSettings
 * @param {{ fallbackName?: string, metadata?: object }} [options]
 * @returns {Promise<Buffer>}
 */
async function renderPdf(source, rawSettings = {}, options = {}) {
  const browser = resolveChrome();
  if (!browser) {
    const err = new Error('Nenhum Chrome/Chromium/Edge foi encontrado para gerar o PDF.');
    err.code = 'CHROME_NOT_FOUND';
    throw err;
  }

  const html = await buildHtml(source, rawSettings, options);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'md-chrome-'));
  const htmlPath = path.join(dir, 'documento.html');
  const pdfPath = path.join(dir, 'documento.pdf');
  const profile = path.join(dir, 'profile');

  try {
    await fsp.writeFile(htmlPath, html, 'utf8');
    await runChrome(browser, htmlPath, pdfPath, profile);
    return await fsp.readFile(pdfPath);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  chromeEnabled,
  resolveChrome,
  resetChromeCache,
  renderPdf,
  buildHtml,
};
