/* =========================================================
   Conversor de imagens (página /imagens)

   Tudo acontece no navegador: os arquivos são decodificados com
   `createImageBitmap` (ou um <img> como reserva), desenhados num
   canvas e recodificados. PNG, JPEG e WebP saem do próprio canvas;
   GIF, BMP, TIFF, ICO e SVG usam os encoders de image-codecs.js.

   Reconvertemos tudo sempre que uma opção muda. Um token (`run`)
   cancela o lote anterior quando outra configuração é escolhida no
   meio do caminho, evitando que resultados antigos sobrescrevam os
   novos.
   ========================================================= */
(function () {
  'use strict';

  const MD = window.MD;
  const Codecs = window.ImageCodecs;
  if (!MD || !Codecs) return;

  const $ = MD.$;
  const $$ = MD.$$;
  const toast = MD.toast;

  /* ---------------------------------------------------------
     Formatos de saída
     --------------------------------------------------------- */
  const FORMATS = {
    png: { label: 'PNG', mime: 'image/png', ext: 'png' },
    jpeg: { label: 'JPEG', mime: 'image/jpeg', ext: 'jpg' },
    webp: { label: 'WebP', mime: 'image/webp', ext: 'webp' },
    gif: { label: 'GIF', mime: 'image/gif', ext: 'gif' },
    bmp: { label: 'BMP', mime: 'image/bmp', ext: 'bmp' },
    tiff: { label: 'TIFF', mime: 'image/tiff', ext: 'tiff' },
    ico: { label: 'ICO', mime: 'image/x-icon', ext: 'ico' },
    svg: { label: 'SVG', mime: 'image/svg+xml', ext: 'svg' },
  };

  // O canvas codifica estes direto; os demais usam os encoders próprios.
  const NATIVE = { png: 1, jpeg: 1, webp: 1 };
  // Formatos sem canal alfa: o fundo escolhido é aplicado antes de desenhar.
  const OPAQUE = { jpeg: 1, bmp: 1, tiff: 1 };

  const MAX_BYTES = 40 * 1024 * 1024;

  const state = {
    format: 'png',
    quality: 0.92,
    maxDim: 0,
    background: '#ffffff',
    items: [],
  };

  let uid = 0;
  let run = 0;

  const el = {
    drop: $('#drop'),
    input: $('#image-input'),
    formats: $('#formats'),
    quality: $('#quality'),
    qualityValue: $('#quality-value'),
    maxdim: $('#maxdim'),
    background: $('#background'),
    list: $('#list'),
    count: $('#convi-count'),
    clear: $('#btn-clear'),
    zip: $('#btn-zip'),
  };

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function isImage(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('image/') === 0) return true;
    return /\.(png|jpe?g|jfif|webp|gif|bmp|ico|avif|heic|heif|tiff?|svg)$/i.test(file.name || '');
  }

  /** Ajusta as dimensões ao limite escolhido, sem ampliar. */
  function fit(width, height, maxDim) {
    if (!maxDim || (width <= maxDim && height <= maxDim)) {
      return { w: width, h: height };
    }
    const scale = maxDim / Math.max(width, height);
    return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      let timer = null;
      timer = setTimeout(() => {
        reject(new Error(
          'O navegador não respondeu ao codificar ' +
          (type === 'image/webp' ? 'WebP' : (type.split('/')[1] || type)) +
          ' (qualidade ' + Math.round((quality == null ? 1 : quality) * 100) + '%).'
        ));
      }, 12000);
      canvas.toBlob((blob) => {
        clearTimeout(timer);
        resolve(blob);
      }, type, quality);
    });
  }

  function outputName(item, ext) {
    const stem = String(item.name || 'imagem').replace(/\.[^./\\]+$/, '') || 'imagem';
    return stem + '.' + ext;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ---------------------------------------------------------
     Decodificação
     --------------------------------------------------------- */
  async function ensureDecoded(item) {
    if (item.source || item.error) return;
    try {
      let source = null;
      if (typeof createImageBitmap === 'function') {
        try {
          source = await createImageBitmap(item.file, { imageOrientation: 'from-image' });
        } catch (err) {
          source = null; // alguns formatos/versões só aceitam <img>
        }
      }
      if (!source) {
        const url = URL.createObjectURL(item.file);
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch (err) {
          URL.revokeObjectURL(url);
          throw err;
        }
        item.decodeUrl = url;
        source = img;
      }
      item.source = source;
      item.width = source.width || source.naturalWidth || 0;
      item.height = source.height || source.naturalHeight || 0;
      if (!item.width || !item.height) throw new Error('sem dimensões');
    } catch (err) {
      item.error = 'Não foi possível ler esta imagem neste navegador.';
    }
  }

  /* ---------------------------------------------------------
     Codificação
     --------------------------------------------------------- */
  function makeResult(blob, spec, width, height, warning) {
    return {
      blob: blob,
      mime: spec.mime,
      ext: spec.ext,
      label: spec.label,
      width: width,
      height: height,
      warning: warning || '',
    };
  }

  async function encode(drawable, width, height, opts) {
    const format = opts.format;
    const spec = FORMATS[format];
    const dim = fit(width, height, opts.maxDim);

    const canvas = document.createElement('canvas');
    canvas.width = dim.w;
    canvas.height = dim.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas indisponível neste navegador.');

    if (OPAQUE[format]) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, dim.w, dim.h);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, dim.w, dim.h);

    if (NATIVE[format]) {
      const quality = format === 'png' ? undefined : opts.quality;
      let blob = await toBlob(canvas, spec.mime, quality);
      if (!blob) throw new Error('Este navegador não gera ' + spec.label + '.');
      // Safari não codifica WebP: o canvas devolve PNG com outro tipo.
      if (format === 'webp' && blob.type && blob.type !== 'image/webp') {
        blob = await toBlob(canvas, 'image/png');
        return makeResult(blob, FORMATS.png, dim.w, dim.h, 'WebP indisponível — gerado PNG.');
      }
      return makeResult(blob, spec, dim.w, dim.h);
    }

    if (format === 'gif') {
      const rgba = ctx.getImageData(0, 0, dim.w, dim.h).data;
      const bytes = Codecs.encodeGif(rgba, dim.w, dim.h);
      return makeResult(new Blob([bytes], { type: spec.mime }), spec, dim.w, dim.h);
    }
    if (format === 'bmp') {
      const rgba = ctx.getImageData(0, 0, dim.w, dim.h).data;
      const bytes = Codecs.encodeBmp(rgba, dim.w, dim.h);
      return makeResult(new Blob([bytes], { type: spec.mime }), spec, dim.w, dim.h);
    }
    if (format === 'tiff') {
      const rgba = ctx.getImageData(0, 0, dim.w, dim.h).data;
      const bytes = Codecs.encodeTiff(rgba, dim.w, dim.h);
      return makeResult(new Blob([bytes], { type: spec.mime }), spec, dim.w, dim.h);
    }

    // ICO e SVG embutem um PNG
    const pngBlob = await toBlob(canvas, 'image/png');
    if (!pngBlob) throw new Error('Falha ao gerar o PNG intermediário.');
    const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
    if (format === 'ico') {
      const bytes = Codecs.encodeIco(pngBytes, dim.w, dim.h);
      return makeResult(new Blob([bytes], { type: spec.mime }), spec, dim.w, dim.h);
    }
    if (format === 'svg') {
      const svg = Codecs.encodeSvg(pngBytes, dim.w, dim.h);
      return makeResult(new Blob([svg], { type: spec.mime }), spec, dim.w, dim.h);
    }
    throw new Error('Formato não suportado.');
  }

  /* ---------------------------------------------------------
     Conversão em lote
     --------------------------------------------------------- */
  async function reconvert() {
    const token = ++run;
    renderList();
    updateToolbar();

    for (const item of state.items) {
      if (token !== run) return;
      item.busy = true;
      item.error = ''; // trocar de formato recomeça do zero
      renderList();

      await ensureDecoded(item);
      if (token !== run) return;

      if (item.error) {
        item.busy = false;
        renderList();
        continue;
      }

      await tick(); // deixa a UI pintar antes de um passo pesado
      if (token !== run) return;

      try {
        const result = await encode(item.source, item.width, item.height, state);
        if (token !== run) return;
        item.result = result;
      } catch (err) {
        item.result = null;
        item.error = err && err.message ? err.message : 'Falha ao converter.';
      }
      item.busy = false;
      renderList();
    }

    updateToolbar();
  }

  /* ---------------------------------------------------------
     Renderização
     --------------------------------------------------------- */
  function statusHtml(item) {
    if (item.error) {
      return '<span class="convi-status is-error">' + escapeHtml(item.error) + '</span>';
    }
    if (item.busy || !item.result) {
      return '<span class="convi-status"><span class="spinner"></span> Convertendo…</span>';
    }
    const out = item.result;
    const warn = out.warning ? ' · <b class="convi-warn">' + escapeHtml(out.warning) + '</b>' : '';
    return (
      '<span class="convi-status is-ok">Saída: ' +
      escapeHtml(out.label) + ' · ' + out.width + '×' + out.height +
      ' · ' + formatBytes(out.blob.size) + warn + '</span>'
    );
  }

  function cardHtml(item) {
    const ready = item.result && !item.error && !item.busy;
    const source = (item.width && item.height)
      ? 'Original: ' + item.width + '×' + item.height + ' · ' + formatBytes(item.size)
      : 'Original: ' + formatBytes(item.size);
    const download = ready
      ? '<button type="button" class="btn btn-soft btn-sm" data-act="download" data-id="' + item.id + '">Baixar</button>'
      : '';

    return (
      '<article class="convi-card' + (ready ? ' is-ready' : '') + '" data-id="' + item.id + '">' +
      '<div class="convi-thumb"><img src="' + item.preview + '" alt="" loading="lazy"></div>' +
      '<div class="convi-info">' +
      '<div class="convi-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</div>' +
      '<div class="convi-meta">' + escapeHtml(source) + '</div>' +
      statusHtml(item) +
      '</div>' +
      '<div class="convi-card-actions">' +
      download +
      '<button type="button" class="icon-btn" data-act="remove" data-id="' + item.id + '" title="Remover">✕</button>' +
      '</div>' +
      '</article>'
    );
  }

  function renderList() {
    if (!state.items.length) {
      el.list.innerHTML =
        '<div class="convi-start">' +
        '<p class="muted">Nenhuma imagem ainda. Arraste arquivos ou clique na área acima.</p>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="btn-sample">Usar imagem de exemplo</button>' +
        '</div>';
      const sample = $('#btn-sample');
      if (sample) sample.addEventListener('click', addSample);
      return;
    }
    el.list.innerHTML = state.items.map(cardHtml).join('');
  }

  function updateToolbar() {
    const total = state.items.length;
    const ready = state.items.filter((item) => item.result && !item.error && !item.busy).length;
    el.count.textContent = total === 0
      ? 'Nenhuma imagem'
      : ready + ' de ' + total + (total === 1 ? ' imagem pronta' : ' imagens prontas');
    el.zip.disabled = ready === 0;
    el.clear.disabled = total === 0;
  }

  /* ---------------------------------------------------------
     Adicionar / remover arquivos
     --------------------------------------------------------- */
  async function addFiles(files) {
    const images = files.filter(isImage);
    if (!images.length) {
      toast('Nenhuma imagem reconhecida.', 'error');
      return;
    }

    let added = 0;
    for (const file of images) {
      if (file.size > MAX_BYTES) {
        toast('"' + file.name + '" é grande demais (máx. 40 MB).', 'error');
        continue;
      }
      state.items.push({
        id: 'img-' + (++uid),
        file: file,
        name: file.name || ('imagem-' + uid),
        size: file.size,
        preview: URL.createObjectURL(file),
        decodeUrl: '',
        source: null,
        width: 0,
        height: 0,
        result: null,
        error: '',
        busy: true,
      });
      added++;
    }
    if (!added) return;
    await reconvert();
  }

  function removeItem(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index === -1) return;
    const item = state.items[index];
    URL.revokeObjectURL(item.preview);
    if (item.decodeUrl) URL.revokeObjectURL(item.decodeUrl);
    state.items.splice(index, 1);
    run++; // invalida o lote em andamento
    renderList();
    updateToolbar();
  }

  function clearAll() {
    for (const item of state.items) {
      URL.revokeObjectURL(item.preview);
      if (item.decodeUrl) URL.revokeObjectURL(item.decodeUrl);
    }
    state.items = [];
    run++;
    renderList();
    updateToolbar();
  }

  /* ---------------------------------------------------------
     Download
     --------------------------------------------------------- */
  function downloadItem(id) {
    const item = state.items.find((entry) => entry.id === id);
    if (!item || !item.result) return;
    saveBlob(item.result.blob, outputName(item, item.result.ext));
  }

  function uniqueName(name, used) {
    if (!used[name]) {
      used[name] = 1;
      return name;
    }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = used[name];
    let candidate;
    do {
      n++;
      candidate = stem + '-' + n + ext;
    } while (used[candidate]);
    used[name] = n;
    used[candidate] = 1;
    return candidate;
  }

  async function downloadZip() {
    const ready = state.items.filter((item) => item.result && !item.error);
    if (!ready.length) {
      toast('Nada para baixar ainda.', 'error');
      return;
    }

    el.zip.disabled = true;
    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    el.zip.appendChild(spinner);

    try {
      const used = {};
      const files = [];
      for (const item of ready) {
        const bytes = new Uint8Array(await item.result.blob.arrayBuffer());
        files.push({ name: uniqueName(outputName(item, item.result.ext), used), data: bytes });
      }
      const zip = Codecs.zipStore(files);
      saveBlob(new Blob([zip], { type: 'application/zip' }), 'imagens-convertidas.zip');
      toast(ready.length === 1 ? '1 imagem baixada.' : ready.length + ' imagens baixadas.');
    } catch (err) {
      toast('Não foi possível montar o ZIP.', 'error');
    } finally {
      spinner.remove();
      updateToolbar();
    }
  }

  /* ---------------------------------------------------------
     Formatos de entrada/saída: seleção e opções
     --------------------------------------------------------- */
  function applyFormatUi() {
    $$('.convi-chip', el.formats).forEach((chip) => {
      chip.classList.toggle('is-active', chip.dataset.format === state.format);
    });
    const lossy = state.format === 'jpeg' || state.format === 'webp';
    const field = $('#quality-field');
    if (field) {
      field.classList.toggle('is-disabled', !lossy);
      const slider = $('#quality');
      if (slider) slider.disabled = !lossy;
      el.qualityValue.textContent = Math.round(Number(el.quality.value) * 100) + '%';
    }
  }

  function setFormat(format) {
    if (state.format === format) return;
    state.format = format;
    applyFormatUi();
    reconvert();
  }

  function readOptions() {
    state.quality = Number(el.quality.value) || 0.92;
    state.maxDim = Number(el.maxdim.value) || 0;
    state.background = el.background.value || '#ffffff';
  }

  /* ---------------------------------------------------------
     Imagem de exemplo
     --------------------------------------------------------- */
  async function addSample() {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 900, 600);
    grad.addColorStop(0, '#6c8cff');
    grad.addColorStop(0.5, '#8a6bff');
    grad.addColorStop(1, '#35d0ba');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 900, 600);

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#0b1020';
    ctx.beginPath();
    ctx.arc(250, 300, 150, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(650, 250, 110, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 64px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Utilitz', 450, 330);
    ctx.font = '400 26px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('imagem de exemplo', 450, 375);

    let blob = null;
    try {
      blob = await toBlob(canvas, 'image/png');
    } catch (err) {
      toast(err.message || 'Não foi possível gerar o exemplo.', 'error');
      return;
    }
    if (!blob) {
      toast('Não foi possível gerar o exemplo.', 'error');
      return;
    }
    await addFiles([new File([blob], 'exemplo.png', { type: 'image/png' })]);
  }

  /* ---------------------------------------------------------
     Eventos
     --------------------------------------------------------- */
  function filesFromDataTransfer(dt) {
    const out = [];
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) out.push(file);
        }
      }
    }
    if (!out.length && dt.files) {
      for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
    }
    return out;
  }

  function init() {
    applyFormatUi();

    el.formats.addEventListener('click', (event) => {
      const chip = event.target.closest('.convi-chip');
      if (chip) setFormat(chip.dataset.format);
    });

    el.quality.addEventListener('input', () => {
      el.qualityValue.textContent = Math.round(Number(el.quality.value) * 100) + '%';
    });
    el.quality.addEventListener('change', () => {
      readOptions();
      reconvert();
    });

    el.maxdim.addEventListener('change', () => {
      readOptions();
      reconvert();
    });

    el.background.addEventListener('change', () => {
      readOptions();
      reconvert();
    });

    el.drop.addEventListener('click', () => el.input.click());
    el.input.addEventListener('change', () => {
      const files = Array.prototype.slice.call(el.input.files || []);
      el.input.value = '';
      if (files.length) addFiles(files);
    });

    // Arrastar e soltar em qualquer ponto da janela
    ['dragenter', 'dragover'].forEach((type) => {
      window.addEventListener(type, (event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        el.drop.classList.add('is-over');
      });
    });
    window.addEventListener('dragleave', (event) => {
      if (event.relatedTarget === null) el.drop.classList.remove('is-over');
    });
    window.addEventListener('drop', (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      el.drop.classList.remove('is-over');
      const files = filesFromDataTransfer(event.dataTransfer).filter(isImage);
      if (files.length) addFiles(files);
    });

    el.list.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const id = button.dataset.id;
      if (button.dataset.act === 'download') downloadItem(id);
      else if (button.dataset.act === 'remove') removeItem(id);
    });

    el.clear.addEventListener('click', clearAll);
    el.zip.addEventListener('click', downloadZip);

    renderList();
    updateToolbar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
