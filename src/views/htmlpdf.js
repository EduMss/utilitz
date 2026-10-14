'use strict';

const { layout } = require('./layout');
const shared = require('../../public/js/shared-settings.js');

/** Opções do seletor de papel, direto do catálogo compartilhado. */
function sizeOptions() {
  return Object.keys(shared.PAGE_SIZES)
    .map((key) => {
      const size = shared.PAGE_SIZES[key];
      const label = `${size.label} — ${size.width} x ${size.height} mm`;
      return `<option value="${key}"${key === 'A4' ? ' selected' : ''}>${label}</option>`;
    })
    .join('');
}

/** Presets de margem, do mesmo catálogo que o servidor usa para montar o @page. */
function marginOptions() {
  return Object.keys(shared.MARGIN_PRESETS)
    .map((key) => `<option value="${key}">${shared.MARGIN_PRESETS[key].label}</option>`)
    .join('');
}

function htmlpdf() {
  return layout({
    title: 'Converter HTML para PDF',
    description:
      'Cole um HTML (página inteira ou pedaço solto) e baixe o PDF com o papel, as margens e a orientação que escolher.',
    active: '/html-pdf',
    bodyClass: 'page-htmlpdf',
    scripts: ['/js/html-pdf.js'],
    body: `
<main class="home fmt">
  <section class="hero fmt-hero">
    <p class="eyebrow">Conversão com o Chrome do seu computador</p>
    <h1>Cole o HTML e baixe o <span class="grad">PDF</span> pronto.</h1>
    <p class="lead">
      Página inteira ou pedaço solto: a folha sai com o papel, as margens e a
      orientação que você escolher, com cor de fundo e imagens já carregadas.
      O HTML não viaja — é o Chrome instalado aqui do lado que imprime.
    </p>
    <div class="hero-actions">
      <button type="button" class="btn btn-primary" id="hp-open">Abrir arquivo</button>
      <button type="button" class="btn btn-ghost" id="hp-clear">Limpar tudo</button>
    </div>
  </section>

  <section class="convi-drop fmt-drop" id="hp-drop">
    <input type="file" id="file-input" hidden>
    <div class="convi-drop-inner">
      <strong>Arraste um arquivo .html para cá</strong>
      <span>ou clique para escolher — aceita .html, .htm e .xhtml.</span>
    </div>
  </section>

  <section class="convi-panel fmt-options">
    <div class="convi-group fmt-group">
      <h4>Papel</h4>
      <select id="hp-size" class="select">${sizeOptions()}</select>
    </div>

    <div class="convi-group fmt-group">
      <h4>Orientação</h4>
      <select id="hp-orientation" class="select">
        <option value="retrato">Retrato</option>
        <option value="paisagem">Paisagem</option>
      </select>
    </div>

    <div class="convi-group fmt-group">
      <h4>Margens</h4>
      <select id="hp-margins" class="select">${marginOptions()}</select>
      <p class="set-hint">
        Se o HTML tiver regras <code>@page</code> próprias, elas valem mais que
        estes ajustes.
      </p>
    </div>

    <div class="convi-group fmt-group">
      <h4>Arquivo</h4>
      <label class="set-check">
        <input type="checkbox" id="hp-background" checked>
        <span>Imprimir as cores de fundo</span>
      </label>
      <input type="text" class="text-input" id="hp-title" placeholder="Nome do arquivo (opcional)">
    </div>
  </section>

  <section class="fmt-split">
    <div class="fmt-pane">
      <header class="fmt-pane-head">
        <strong>Entrada</strong>
        <span class="muted" id="hp-source">colado na página</span>
      </header>
      <textarea id="hp-input" class="fmt-editor" spellcheck="false"
        placeholder="Cole aqui o HTML — a página inteira ou só o pedaço que vira PDF."></textarea>
      <div class="fmt-samples" id="hp-samples"></div>
      <div class="fmt-foot fmt-in-foot">
        <span class="muted" id="hp-in-stats">—</span>
        <span class="grow"></span>
        <span class="muted">Bom para arquivos de até 4 MB</span>
      </div>
    </div>

    <div class="fmt-pane fmt-pane-out">
      <header class="fmt-pane-head">
        <strong>Prévia</strong>
        <span class="fmt-badge" id="hp-badge">—</span>
        <span class="grow"></span>
        <button type="button" class="btn btn-soft btn-sm" id="hp-print">Imprimir</button>
        <button type="button" class="btn btn-primary btn-sm" id="hp-pdf">Gerar PDF</button>
      </header>
      <div class="fmt-error" id="hp-error" hidden></div>
      <div class="fmt-preview is-frame">
        <iframe id="hp-frame" class="fmt-frame" title="Prévia do HTML"
          sandbox="allow-same-origin allow-modals allow-popups"></iframe>
      </div>
      <div class="fmt-foot fmt-out-foot">
        <span class="muted" id="hp-out-stats">—</span>
        <span class="grow"></span>
        <span class="muted" id="hp-hint"></span>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span>A conversão usa o Chrome, Chromium ou Edge instalado no seu computador</span>
  </footer>
</main>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { htmlpdf };
