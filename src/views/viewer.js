'use strict';

const { layout } = require('./layout');

function viewer() {
  return layout({
    title: 'Visualizar',
    active: '/visualizar',
    bodyClass: 'page-viewer',
    scripts: ['/js/viewer.js'],
    body: `
<div class="stage" id="stage" tabindex="-1">
  <article class="doc md" id="doc" aria-live="polite"></article>

  <div class="stage-hint" id="stage-hint">
    <strong>Cole seu markdown</strong>
    <span>Abra a gaveta do editor para escrever — o preview ocupa a tela inteira.</span>
  </div>
</div>

<div class="v-toolbar" id="toolbar">
  <a class="tb-logo" href="/" title="Voltar ao início">M↓</a>

  <div class="tb-group">
    <button type="button" class="tb-btn tb-primary" id="btn-toggle-editor" title="Abrir/fechar o editor (E)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/></svg>
      <span>Editor</span>
    </button>
  </div>

  <div class="tb-group">
    <button type="button" class="tb-btn" id="btn-zoom-out" title="Diminuir zoom (-)">−</button>
    <button type="button" class="tb-btn tb-zoom" id="btn-zoom-reset" title="Zoom de 100% (0)">100%</button>
    <button type="button" class="tb-btn" id="btn-zoom-in" title="Aumentar zoom (+)">+</button>
  </div>

  <div class="tb-group">
    <button type="button" class="tb-btn" id="btn-theme" title="Alternar tema">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/></svg>
    </button>
    <button type="button" class="tb-btn" id="btn-outline" title="Mostrar sumário (T)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
    </button>
  </div>

  <div class="tb-group">
    <button type="button" class="tb-btn" id="btn-open" title="Abrir arquivo .md">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6l2 2h8v10H4z"/></svg>
    </button>
    <button type="button" class="tb-btn" id="btn-save-file" title="Baixar .md">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 19h14"/></svg>
    </button>
    <button type="button" class="tb-btn" id="btn-save-library" title="Salvar na biblioteca">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v16l-6-4-6 4z"/></svg>
    </button>
    <button type="button" class="tb-btn" id="btn-print" title="Imprimir (P)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 19H5v-6h14v6h-2M7 15h10v5H7z"/></svg>
    </button>
  </div>

  <div class="tb-group">
    <a class="tb-btn" href="/pdf" title="Abrir no conversor de PDF">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>
      <span>PDF</span>
    </a>
    <button type="button" class="tb-btn" id="btn-fullscreen" title="Tela cheia (F)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5"/></svg>
    </button>
  </div>
</div>

<div class="v-drawer-backdrop" id="drawer-backdrop" hidden></div>

<aside class="v-drawer" id="drawer" aria-hidden="true">
  <header class="v-drawer-head">
    <span>Markdown</span>
    <div class="v-drawer-actions">
      <button type="button" class="chip" id="btn-image" title="Inserir imagem (colar, arrastar ou escolher arquivo)">🖼 Imagem</button>
      <button type="button" class="chip" id="btn-format" title="Formatar">Formatar</button>
      <button type="button" class="chip" data-example="0">Exemplo</button>
      <button type="button" class="icon-btn" id="btn-clear" title="Limpar">✕</button>
      <button type="button" class="chip chip-close" id="btn-close-drawer" title="Fechar o editor (Esc)">Fechar</button>
    </div>
  </header>
  <textarea id="source" class="v-drawer-input" spellcheck="false"
    placeholder="# Escreva aqui&#10;&#10;O preview aparece em tempo real na tela."></textarea>
  <footer class="v-drawer-foot">
    <span id="drawer-count">0 palavras</span>
    <span class="grow"></span>
    <button type="button" class="chip" id="btn-to-pdf">Levar para o PDF →</button>
  </footer>
</aside>

<nav class="v-outline" id="outline" aria-hidden="true">
  <div class="v-outline-head">Sumário</div>
  <div class="v-outline-list" id="outline-list"></div>
</nav>

<div class="v-status" id="status">
  <span id="status-counts">0 palavras</span>
  <span class="sep">·</span>
  <span id="status-pages"></span>
</div>

<div class="v-progress" id="progress"><i></i></div>

<div class="toast" id="toast" role="status"></div>
<input type="file" id="file-input" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
<input type="file" id="img-input" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" hidden>

<div class="dropzone dropzone-screen" id="screen-drop" aria-hidden="true">
  <div>
    <strong>Solte a imagem aqui para inserir no markdown</strong>
    <small>No editor, ela entra exatamente no ponto do mouse.</small>
  </div>
</div>
`,
  });
}

module.exports = { viewer };