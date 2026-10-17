'use strict';

const { layout, versioned } = require('./layout');

/**
 * Editor de PDF.
 *
 * A edição acontece inteiramente no navegador: o pdf.js renderiza as páginas
 * e o pdf-lib monta o arquivo final (remover páginas, inserir imagem como
 * página, texto por cima). O servidor só entrega a casca e as bibliotecas em
 * /vendor — nenhum arquivo viaja para lá.
 */
function pdfedit() {
  return layout({
    title: 'Editar PDF',
    description:
      'Abra um PDF e edite no navegador: reorganize e remova páginas, insira imagens como página inteira, acrescente texto com fonte e cor, e exporte o arquivo ou uma página como imagem.',
    active: '/editar-pdf',
    bodyClass: 'page-pdfedit',
    scripts: ['/js/pdfedit.js'],
    body: `
<header class="bar pe-bar" id="pe-bar" role="toolbar" aria-label="Ferramentas do editor de PDF">
  <div class="bar-tools">
    <button type="button" class="btn btn-soft btn-sm" id="pe-open">Abrir PDF</button>
    <button type="button" class="btn btn-primary btn-sm" id="pe-save">Baixar PDF</button>
  </div>

  <span class="pe-sep" role="separator"></span>

  <div class="bar-tools" id="pe-text-tools">
    <button type="button" class="btn btn-soft btn-sm" id="pe-add-text">+ Texto</button>
    <button type="button" class="btn btn-soft btn-sm" id="pe-edit" disabled>Editar texto</button>
    <select id="pe-font" class="select pe-select" title="Família da fonte">
      <optgroup label="Fontes padrão do PDF">
        <option value="Helvetica">Helvetica</option>
        <option value="Times">Times</option>
        <option value="Courier">Courier</option>
      </optgroup>
      <optgroup label="Google Fonts">
        <option value="Roboto">Roboto</option>
        <option value="Open Sans">Open Sans</option>
        <option value="Montserrat">Montserrat</option>
        <option value="Lato">Lato</option>
        <option value="Fira Sans">Fira Sans</option>
        <option value="Merriweather">Merriweather</option>
        <option value="Playfair Display">Playfair Display</option>
        <option value="Caveat">Caveat</option>
      </optgroup>
    </select>
    <input type="number" id="pe-size" class="text-input pe-size" min="4" max="280" step="1" value="16" title="Tamanho da fonte (pt)">
    <button type="button" class="icon-btn pe-style-btn" id="pe-bold" title="Negrito" aria-pressed="false"><strong>B</strong></button>
    <button type="button" class="icon-btn pe-style-btn" id="pe-italic" title="Itálico" aria-pressed="false"><em>I</em></button>
    <label class="pe-color-wrap" title="Cor do texto">
      <input type="color" id="pe-color" class="pe-color" value="#111827">
    </label>
    <button type="button" class="icon-btn" id="pe-del" title="Excluir o item selecionado (Delete)" disabled>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.5 1h3l.5 1H14v1.5H2V2h3.5l.5-1Zm-3 4h9l-.6 9.2a1.5 1.5 0 0 1-1.5 1.3H5.6a1.5 1.5 0 0 1-1.5-1.3L3.5 5Zm3 2v6h1V7H6.5Zm3 0v6h1V7h-1Z"/></svg>
    </button>
    <button type="button" class="icon-btn pe-style-btn is-on" id="pe-layer" title="Texto que já vem no PDF: passe o mouse para ver, arraste para mover" aria-pressed="true">Aa</button>
  </div>

  <span class="grow"></span>

  <div class="bar-actions">
    <select id="pe-zoom" class="select pe-select" title="Zoom — 100% renderiza a 75% (a folha com as setas cabe na tela). O scroll do mouse zooma no cursor; arraste o fundo para mover a folha">
      <option value="fit" selected>Ajustar</option>
      <option value="0.25">25%</option>
      <option value="0.33">33%</option>
      <option value="0.5">50%</option>
      <option value="0.75">75%</option>
      <option value="1">100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="2">200%</option>
      <option value="3">300%</option>
    </select>
    <button type="button" class="btn btn-soft btn-sm" id="pe-png" title="Salva a página aberta agora como imagem PNG">PNG da página</button>
  </div>
</header>

<div class="pe-layout">
  <aside class="pe-panel pe-pages" aria-label="Páginas do PDF">
    <header class="pe-head">
      <strong>Páginas</strong>
      <span class="muted" id="pe-pagecount">0</span>
      <span class="grow"></span>
      <button type="button" class="icon-btn" id="pe-add-blank" title="Inserir página em branco do mesmo tamanho da atual">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2h2v5h5v2H9v5H7V9H2V7h5V2Z"/></svg>
      </button>
    </header>
    <div class="pe-thumbs" id="pe-thumbs" aria-live="polite"></div>
  </aside>

  <section class="pe-stage" id="pe-stage" aria-label="Página atual">
    <div class="pe-empty" id="pe-empty">
      <strong>Arraste um PDF para cá</strong>
      <span>ou clique em “Abrir PDF” lá em cima — o arquivo não sai do seu computador.</span>
      <button type="button" class="btn btn-primary" id="pe-open-2">Abrir PDF</button>
    </div>
    <div class="pe-page-wrap" id="pe-page-wrap" hidden>
      <button type="button" class="pe-nav-arrow" id="pe-prev-page" title="Página anterior" disabled>
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 3.6 2.9 8.7l1.2 1.2L7.25 6.8V13h1.5V6.8l3.15 3.1 1.2-1.2L8 3.6Z"/></svg>
      </button>
      <div class="pe-page" id="pe-page">
        <canvas id="pe-canvas"></canvas>
        <div class="pe-overlay" id="pe-overlay"></div>
      </div>
      <button type="button" class="pe-nav-arrow" id="pe-next-page" title="Próxima página" disabled>
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 12.4 13.1 7.3l-1.2-1.2L8.75 9.2V3h-1.5v6.2L4.1 6.1 2.9 7.3 8 12.4Z"/></svg>
      </button>
    </div>
  </section>

  <aside class="pe-panel pe-images" aria-label="Imagens para inserir">
    <header class="pe-head">
      <strong>Imagens</strong>
      <span class="muted" id="pe-imgcount">0</span>
      <span class="grow"></span>
      <button type="button" class="icon-btn" id="pe-add-img" title="Adicionar imagens">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7 2h2v5h5v2H9v5H7V9H2V7h5V2Z"/></svg>
      </button>
    </header>
    <div class="pe-img-grid" id="pe-img-grid" aria-live="polite"></div>
  </aside>
</div>

<input type="file" id="pe-pdf-input" accept="application/pdf,.pdf" hidden>
<input type="file" id="pe-img-input" accept="image/*" multiple hidden>

<div class="toast" id="toast" role="status"></div>

<script>window.PE_WORKER = ${JSON.stringify(versioned('/vendor/pdf.worker.min.js'))};</script>
<script src="${versioned('/vendor/pdf.min.js')}"></script>
<script src="${versioned('/vendor/fontkit.umd.min.js')}"></script>
<script src="${versioned('/vendor/pdf-lib.min.js')}"></script>
`,
  });
}

module.exports = { pdfedit };
