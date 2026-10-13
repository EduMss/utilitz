'use strict';

const { layout } = require('./layout');

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'gif', label: 'GIF' },
  { value: 'bmp', label: 'BMP' },
  { value: 'tiff', label: 'TIFF' },
  { value: 'ico', label: 'ICO' },
  { value: 'svg', label: 'SVG' },
];

function images() {
  const formatButtons = FORMATS.map(
    (format) =>
      `<button type="button" class="chip convi-chip" data-format="${format.value}">${format.label}</button>`
  ).join('');

  return layout({
    title: 'Converter imagens',
    description: 'Converta imagens entre PNG, JPEG, WebP, GIF, BMP, TIFF, ICO e SVG direto no navegador.',
    active: '/imagens',
    bodyClass: 'page-images',
    scripts: ['/js/image-codecs.js', '/js/image-converter.js'],
    body: `
<main class="home convi">
  <section class="hero convi-hero">
    <p class="eyebrow">Conversão 100% no navegador</p>
    <h1>Troque o <span class="grad">formato</span> das suas imagens</h1>
    <p class="lead">
      PNG, JPEG, WebP, GIF, BMP, TIFF, ICO e SVG. Arraste os arquivos, escolha o
      destino e baixe cada um ou todos de uma vez. Nenhuma imagem sai do seu
      dispositivo.
    </p>
  </section>

  <section class="convi-drop" id="drop">
    <input type="file" id="image-input" accept="image/*" multiple hidden>
    <div class="convi-drop-inner">
      <strong>Arraste imagens para cá</strong>
      <span>ou clique para escolher — aceita PNG, JPG, WebP, AVIF, HEIC (Safari), GIF, BMP e ICO.</span>
    </div>
  </section>

  <section class="convi-panel">
    <div class="convi-group">
      <h4>Formato de saída</h4>
      <div class="convi-formats" id="formats">${formatButtons}</div>
    </div>

    <div class="convi-opts">
      <label class="convi-opt" id="quality-field">
        <span class="convi-opt-label">Qualidade <b id="quality-value">92%</b></span>
        <input type="range" id="quality" min="0.4" max="1" step="0.01" value="0.92">
      </label>

      <label class="convi-opt">
        <span class="convi-opt-label">Redimensionar</span>
        <select id="maxdim" class="select">
          <option value="0">Manter tamanho original</option>
          <option value="2560">Máx. 2560 px no maior lado</option>
          <option value="1920">Máx. 1920 px no maior lado</option>
          <option value="1280">Máx. 1280 px no maior lado</option>
          <option value="1024">Máx. 1024 px no maior lado</option>
          <option value="800">Máx. 800 px no maior lado</option>
          <option value="512">Máx. 512 px no maior lado</option>
        </select>
      </label>

      <label class="convi-opt" id="background-field">
        <span class="convi-opt-label">Fundo (formatos sem transparência)</span>
        <input type="color" id="background" value="#ffffff">
      </label>
    </div>

    <div class="convi-actions">
      <span class="muted" id="convi-count">Nenhuma imagem</span>
      <span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-clear">Limpar</button>
      <button type="button" class="btn btn-primary btn-sm" id="btn-zip" disabled>
        Baixar tudo (ZIP) <span class="spinner" id="zip-spinner" hidden></span>
      </button>
    </div>
  </section>

  <section class="convi-list" id="list"></section>

  <footer class="foot">
    <span>A conversão roda no seu navegador · nada é enviado para o servidor</span>
  </footer>
</main>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { images };
