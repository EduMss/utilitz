'use strict';

/**
 * Testes do renderizador de markdown e da higienização de HTML.
 * Uso: node scripts/test-render.js
 */

const assert = require('assert');
const { render, headings, stats, sanitizeHtml } = require('../src/lib/markdown');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n         ' + err.message);
  }
}

function noDanger(html) {
  assert.ok(!/<\s*script/i.test(html), 'script tag presente');
  assert.ok(!/<\s*iframe/i.test(html), 'iframe presente');
  assert.ok(!/<\s*style/i.test(html), 'style presente');
  assert.ok(!/<\s*(object|embed|applet|form|noscript|template)/i.test(html), 'tag perigosa presente');
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html), 'handler inline presente');
  // só importa quando javascript: aparece como valor de atributo
  assert.ok(
    !/(href|src|action|data|poster|formaction|xlink:href)\s*=\s*["']?\s*(javascript|vbscript)\s*:/i.test(html),
    'URL perigosa em atributo'
  );
  assert.ok(!/(href|src|data)\s*=\s*["']?\s*data:text\/html/i.test(html), 'data:text/html em atributo');
}

console.log('\n== renderização básica ==');

check('título com âncora', () => {
  assert.strictEqual(render('# Olá'), '<h1 id="ola">Olá</h1>\n');
});

check('títulos repetidos ganham ids únicos', () => {
  const html = render('## Sub\n\n## Sub\n\n## Sub');
  assert.ok(/id="sub"/.test(html));
  assert.ok(/id="sub-2"/.test(html));
  assert.ok(/id="sub-3"/.test(html));
});

check('conteúdo do título aparece uma vez só', () => {
  const html = render('# Olá');
  assert.strictEqual(html.match(/Olá/g).length, 1, html);
});

check('sumário vem do render, não do parse', () => {
  const hs = headings('# A\n## B\n## B');
  assert.deepStrictEqual(hs, [
    { level: 1, text: 'A', id: 'a' },
    { level: 2, text: 'B', id: 'b' },
    { level: 2, text: 'B', id: 'b-2' },
  ]);
});

check('estatísticas contam palavras e títulos', () => {
  const s = stats('# Olá\n\num dois três');
  assert.strictEqual(s.words, 5, 'inclui a palavra do título');
  assert.strictEqual(s.headings, 1);
  assert.strictEqual(s.characters, 19);
  assert.ok(s.readingTime >= 1);
});

check('markdown vazio não quebra', () => {
  assert.strictEqual(render(''), '');
  assert.strictEqual(render(null), '');
  assert.strictEqual(render(undefined), '');
  assert.deepStrictEqual(headings(''), []);
});

check('link externo abre em nova aba', () => {
  const html = render('[x](https://exemplo.com)');
  assert.ok(/target="_blank"/.test(html), html);
  assert.ok(/rel="noopener noreferrer"/.test(html), html);
});

check('link interno não ganha target', () => {
  const html = render('[x](#secão)');
  assert.ok(!/target=/.test(html), html);
});

check('lista, tabela e citação', () => {
  const html = render('- a\n- b\n\n> citação\n\n| a | b |\n| - | - |\n| 1 | 2 |');
  assert.ok(/<ul>/.test(html), html);
  assert.ok(/<blockquote>/.test(html), html);
  assert.ok(/md-table-wrap/.test(html), html);
});

check('bloco de código com highlight', () => {
  const html = render('```js\nconst a = 1;\n```');
  assert.ok(/md-pre/.test(html), html);
  assert.ok(/hljs/.test(html), html);
});

check('bloco de código sem linguagem não quebra', () => {
  const html = render('```\ntexto <b>a</b>\n```');
  assert.ok(/md-pre/.test(html), html);
});

check('linguagem inexistente cai para plaintext', () => {
  const html = render('```naoexiste\nx = 1\n```');
  assert.ok(/md-pre/.test(html), html);
});

console.log('\n== higienização ==');

check('remove <script> com conteúdo', () => {
  noDanger(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'));
});

check('remove script com atributos e barra final', () => {
  noDanger(sanitizeHtml('<script type="text/javascript" src="x.js"></script>ok'));
  noDanger(sanitizeHtml('<script src="x.js"/>ok'));
});

check('remove handlers inline', () => {
  noDanger(sanitizeHtml('<img src="a.png" onerror="alert(1)">'));
  noDanger(sanitizeHtml('<div ONCLICK=alert(1) id="k">x</div>'));
  noDanger(sanitizeHtml('<p onmouseover=\'alert(1)\'>x</p>'));
});

check('remove javascript: em href', () => {
  noDanger(sanitizeHtml('<a href="javascript:alert(1)">x</a>'));
  noDanger(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>'));
  noDanger(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>'));
  noDanger(sanitizeHtml('<a href="  javascript:alert(1)">x</a>'));
});

check('remove iframe, object, embed, form', () => {
  noDanger(sanitizeHtml('<iframe src="https://x.com"></iframe>'));
  noDanger(sanitizeHtml('<object data="x.swf"></object>'));
  noDanger(sanitizeHtml('<embed src="x.swf">'));
  noDanger(sanitizeHtml('<form action="/x"><input onfocus=alert(1)></form>'));
});

check('remove link/meta/base', () => {
  const html = sanitizeHtml('<link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0;url=x"><base href="//evil">texto');
  assert.ok(!/<link/i.test(html), html);
  assert.ok(!/<meta/i.test(html), html);
  assert.ok(!/<base/i.test(html), html);
  assert.ok(html.includes('texto'), html);
});

check('preserva imagem base64 legítima', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo=';
  const html = sanitizeHtml('<img src="' + src + '">');
  assert.ok(html.includes(src), html);
});

check('recusa svg base64 (pode carregar script)', () => {
  const src = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const html = sanitizeHtml('<img src="' + src + '">');
  assert.ok(!/svg\+xml/.test(html), html);
  // no markdown o link perigoso não pode virar <img src=...>
  assert.ok(!/src\s*=\s*"[^"]*svg\+xml/i.test(render('![alt](' + src + ')')), 'markdown gerou img com svg');
});

check('recusa data: que não seja imagem em base64', () => {
  const html = sanitizeHtml('<img src="data:image/png,conteudo-raw">');
  assert.ok(/src=""/.test(html), html);
  assert.ok(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>').includes('href=""'));
});

check('preserva https normal', () => {
  const html = sanitizeHtml('<a href="https://exemplo.com">x</a>');
  assert.ok(html.includes('https://exemplo.com'), html);
});

check('não quebra texto com < e >', () => {
  const html = sanitizeHtml('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>');
  assert.ok(html.includes('&lt;'), html);
  assert.ok(html.includes('&amp;'), html);
});

check('não quebra tabelas do markdown', () => {
  const html = render('| a | b |\n| :- | -: |\n| 1 | 2 |');
  assert.ok(/<table>/.test(html), html);
  noDanger(html);
});

check('markdown com HTML sujo sai limpo', () => {
  const html = render('<script>alert(1)</script>\n\n[clique](javascript:alert(2))\n\n<img src=x onerror=alert(3)>');
  noDanger(html);
  assert.ok(!/onerror/i.test(html), 'onerror sobreviveu');
  assert.ok(!/<a\s[^>]*href/i.test(html), 'link perigoso virou âncora');
});

check('bloco de código preservado e escapado', () => {
  const html = render('```html\n<script>alert(1)</script>\n```');
  assert.ok(/md-pre/.test(html), html);
  assert.ok(html.includes('&lt;'), 'tags devem ficar escapadas: ' + html);
  assert.ok(html.includes('&gt;'), 'tags devem ficar escapadas: ' + html);
  noDanger(html);
});

console.log('\n' + pass + ' passaram, ' + failures.length + ' falharam\n');
if (failures.length) process.exit(1);