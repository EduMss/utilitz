'use strict';

/** Escape de HTML para interpolar conteúdo dentro dos templates. */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV = [
  { href: '/', label: 'Início', match: '/' },
  { href: '/visualizar', label: 'Visualizar', match: '/visualizar' },
  { href: '/pdf', label: 'PDF', match: '/pdf' },
];

/**
 * Carimbo de versão dos assets estáticos.
 *
 * O HTML das páginas é sempre gerado novo, mas o navegador segura
 * `viewer.js`, `app.css` e afins em cache. Sem um carimbo, editar um arquivo
 * não aparece na tela: a pessoa recebe o HTML novo com o script velho, e
 * qualquer botão novo simplesmente não faz nada. O mtime do arquivo entra na
 * URL, então cada edição gera uma URL nova.
 */
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** `?v=<mtime>` do arquivo em public/, ou '' se ele não existir. */
function assetVersion(url) {
  const file = path.join(PUBLIC_DIR, url.split('?')[0].replace(/^\/+/, ''));
  try {
    return '?v=' + Math.floor(fs.statSync(file).mtimeMs);
  } catch (err) {
    return '';
  }
}

/** Acrescenta o carimbo de versão a um caminho estático. */
function versioned(url) {
  return escapeHtml(url) + assetVersion(url);
}

function nav(active) {
  return NAV.map((item) => {
    const current = item.match === '/' ? active === '/' : active.startsWith(item.match);
    return (
      '<a class="nav-link' +
      (current ? ' is-active' : '') +
      '" href="' +
      item.href +
      '">' +
      escapeHtml(item.label) +
      '</a>'
    );
  }).join('');
}

/**
 * Casca comum das páginas.
 * @param {{title: string, description?: string, active: string, body: string,
 *          scripts?: string[], bodyClass?: string, chrome?: boolean}} options
 *        chrome controla apenas a barra de navegação do site. O app.css é
 *        sempre carregado: as ferramentas usam classes que vivem nele.
 */
function layout(options) {
  const {
    title,
    description = 'Ferramenta fullstack Node.js para visualizar e converter Markdown.',
    active,
    body,
    scripts = [],
    bodyClass = '',
    chrome = true,
  } = options;

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Markdown Studio</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${versioned('/css/base.css')}">
  <link rel="stylesheet" href="${versioned('/css/markdown.css')}">
  <link rel="stylesheet" href="${versioned('/css/app.css')}">
</head>
<body class="${escapeHtml(bodyClass)}">
${chrome ? `<header class="topbar">
  <a class="brand" href="/">
    <span class="brand-mark">M↓</span>
    <span class="brand-text">Markdown Studio</span>
  </a>
  <nav class="nav">${nav(active)}</nav>
</header>` : ''}
${body}
<script src="${versioned('/js/shared-settings.js')}"></script>
<script src="${versioned('/js/common.js')}"></script>
${scripts.map((src) => `<script src="${versioned(src)}"></script>`).join('\n')}
</body>
</html>`;
}

module.exports = { layout, escapeHtml, versioned };