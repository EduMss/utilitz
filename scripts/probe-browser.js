'use strict';
/**
 * Sonda de navegador: carrega as páginas em um Chrome/Edge headless, semeia um
 * rascunho e verifica se o render realmente apareceu no DOM paginado.
 *
 * Uso: node scripts/probe-browser.js      (exige o servidor rodando)
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(ROOT, 'public', '_probe.html');
const CLICK = path.join(ROOT, 'public', '_click.html');

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
 * `budget` é o tempo virtual em ms: a paginação do Paged.js faz trabalho real
 * de layout e fontes, e um orçamento curto captura o DOM no meio da paginação.
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
 * Carrega a página repetindo com orçamentos crescentes até `ready(dom)` passar.
 * O --dump-dom dispara quando o tempo virtual acaba, e a paginação do Paged.js
 * faz trabalho real de layout: numa máquina lenta um orçamento fixo captura o
 * DOM no meio do caminho e gera falha falso-positiva.
 */
function dumpDomReady(browser, url, ready) {
  const budgets = ready ? [30000, 60000, 120000, 180000] : [30000];
  let dom = '';
  for (const budget of budgets) {
    dom = dumpDom(browser, url, budget);
    if (!ready || ready(dom)) return dom;
  }
  return dom;
}

/** A prévia terminou de paginar: folhas prontas e contador preenchido. */
const previewReady = (dom) =>
  /pagedjs_sheet/.test(dom) && !/id="pages-info"[^>]*>—/.test(dom);

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

} finally {
  fs.rmSync(PROBE, { force: true });
  fs.rmSync(CLICK, { force: true });
}

console.log(
  failures ? '\n' + failures + ' falha(s) de renderização\n' : '\nRenderização verificada em navegador real.\n'
);
process.exit(failures ? 1 : 0);
