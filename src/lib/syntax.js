'use strict';

const hljs = require('highlight.js/lib/common');

/**
 * Paleta usada no PDF. O navegador usa o tema padrão do highlight.js,
 * o PDF usa esta paleta para garantir contraste em fundo claro.
 */
const TOKEN_COLORS = {
  keyword: '#7c3aed',
  built_in: '#7c3aed',
  literal: '#7c3aed',
  type: '#0f766e',
  title: '#0f766e',
  function: '#2563eb',
  params: '#475569',
  string: '#b45309',
  number: '#b45309',
  regexp: '#b45309',
  comment: '#94a3b8',
  doctag: '#94a3b8',
  meta: '#64748b',
  symbol: '#b45309',
  attr: '#c026d3',
  attribute: '#c026d3',
  tag: '#be123c',
  name: '#be123c',
  variable: '#be123c',
  'variable.language': '#be123c',
  deleted: '#be123c',
  addition: '#15803d',
  section: '#0f766e',
  bullet: '#64748b',
  quote: '#64748b',
  doctype: '#64748b',
  punctuation: '#475569',
  operator: '#475569',
  entity: '#b45309',
  subst: '#1f2937',
};

const PLAIN = '#1f2937';

/** Decodifica as entidades que o highlight.js escapa. */
function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Converte o HTML do highlight.js em runs coloridos, preservando o texto.
 * @returns {Array<{text: string, color: string}>}
 */
function htmlToRuns(html) {
  const runs = [];
  const stack = [];
  const tagRe = /(<span class="([^"]*)">)|<\/span>|([^<]+)/g;
  const currentColor = () => (stack.length ? stack[stack.length - 1] : PLAIN);
  let match;

  while ((match = tagRe.exec(html)) !== null) {
    /* Tres grupos: tag completa, classe e texto. Os dois ultimos so
       existem na alternativa que casou. */
    const [full, , cls, text] = match;

    if (full === '</span>') {
      stack.pop();
      continue;
    }

    if (cls !== undefined) {
      /* As classes vem como `hljs-attr`; a paleta usa o nome sem prefixo. */
      stack.push(TOKEN_COLORS[cls.replace(/^hljs-/, '')] || currentColor());
      continue;
    }

    const value = decodeEntities(text || '');
    if (!value) continue;

    const color = currentColor();
    const last = runs[runs.length - 1];
    if (last && last.color === color) last.text += value;
    else runs.push({ text: value, color });
  }

  return runs.length ? runs : [{ text: '', color: PLAIN }];
}

/**
 * Realça o código e devolve uma lista de linhas, cada linha com seus runs.
 * @param {string} code
 * @param {string} language
 * @param {boolean} enabled quando falso, devolve texto sem cor
 */
function highlightLines(code, language, enabled) {
  const source = String(code).replace(/\t/g, '  ').replace(/\r\n/g, '\n');
  const plain = () => source.split('\n').map((line) => [{ text: line, color: PLAIN }]);

  if (!enabled || !language || !hljs.getLanguage(language)) return plain();

  let html;
  try {
    html = hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch (err) {
    return plain();
  }

  /* O highlight.js preserva as quebras de linha dentro dos spans,
     basta separar os runs ao encontrar "\n". */
  const lines = [[]];
  htmlToRuns(html).forEach((run) => {
    run.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, color: run.color });
    });
  });

  return lines;
}

module.exports = { highlightLines, htmlToRuns, TOKEN_COLORS };