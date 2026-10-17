/* =========================================================
   Editor de PDF — /editar-pdf

   O pdf.js renderiza as páginas na tela; o pdf-lib é a fonte
   da verdade do arquivo (páginas, imagens embutidas) e monta
   o PDF exportado, desenhando por cima os itens que a pessoa
   adicionou (texto e imagens), que vivem em `state.overlays`
   em unidades de ponto, como o próprio PDF.

   Convenções de coordenada:
   - tudo é medido em pontos (pt), a unidade do PDF;
   - `x` é a borda esquerda do item;
   - `yTop` é a distância da base da folha até o TOPO do item
     (mesma convenção de cima para baixo do canvas de exibição
     é derivada disso: top% = (altura - yTop) / altura).
   ========================================================= */
(function () {
  'use strict';

  const { $, $$, toast } = window.MD;
  const { imageFiles, dataUrlFor } = window.MD.image;

  const PDFLib = window.PDFLib;
  const pdfjsLib = window.pdfjsLib;

  const A4 = { width: 595.28, height: 841.89 };
  const MAX_IMG_BYTES = 25 * 1024 * 1024;

  /* Família de fonte → como ela aparece na tela e no arquivo.
     - kind 'standard': as 14 fontes base do PDF, embutidas de graça;
     - kind 'ttf': arquivo TTF em /fonts (Google Fonts baixadas para o
       projeto). No export, o arquivo é baixado sob demanda e embutido com
       subsetting, então o PDF final não carrega a fonte inteira. */
  const FAMILIES = {
    Helvetica: {
      kind: 'standard',
      css: 'Helvetica, Arial, sans-serif',
      variants: {
        '': 'Helvetica',
        b: 'Helvetica-Bold',
        i: 'Helvetica-Oblique',
        bi: 'Helvetica-BoldOblique',
      },
    },
    Times: {
      kind: 'standard',
      css: '"Times New Roman", Times, serif',
      variants: {
        '': 'TimesRoman',
        b: 'TimesRoman-Bold',
        i: 'TimesRoman-Italic',
        bi: 'TimesRoman-BoldItalic',
      },
    },
    Courier: {
      kind: 'standard',
      css: '"Courier New", Courier, monospace',
      variants: {
        '': 'Courier',
        b: 'Courier-Bold',
        i: 'Courier-Oblique',
        bi: 'Courier-BoldOblique',
      },
    },
    Roboto: { kind: 'ttf', css: 'Roboto, sans-serif', file: 'Roboto' },
    'Open Sans': { kind: 'ttf', css: '"Open Sans", sans-serif', file: 'OpenSans' },
    Montserrat: { kind: 'ttf', css: 'Montserrat, sans-serif', file: 'Montserrat' },
    Lato: { kind: 'ttf', css: 'Lato, sans-serif', file: 'Lato' },
    'Fira Sans': { kind: 'ttf', css: '"Fira Sans", sans-serif', file: 'FiraSans' },
    Merriweather: { kind: 'ttf', css: 'Merriweather, serif', file: 'Merriweather' },
    'Playfair Display': { kind: 'ttf', css: '"Playfair Display", serif', file: 'PlayfairDisplay' },
    Caveat: { kind: 'ttf', css: 'Caveat, cursive', file: 'Caveat' },
  };

  /* Nome do arquivo TTF por variante ('' regular, b negrito, i itálico,
     bi ambos). Caveat não tem itálico no catálogo: o regular faz as vezes. */
  const VARIANT_FILE = { '': 'Regular', b: 'Bold', i: 'Italic', bi: 'BoldItalic' };

  function fontFileOf(family, variant) {
    const cfg = FAMILIES[family];
    if (!cfg || cfg.kind !== 'ttf') return null;
    let name = cfg.file + '-' + VARIANT_FILE[variant];
    if (variant === 'bi' && family === 'Caveat') name = cfg.file + '-Bold';
    return '/fonts/' + name + '.ttf';
  }

  /* Bytes das fontes TTF já baixados (evita refazer o fetch no export). */
  const fontBytesCache = {};

  function fontBytesOf(url) {
    if (!fontBytesCache[url]) {
      fontBytesCache[url] = fetch(url).then(
        (response) => (response.ok ? response.arrayBuffer().then((buf) => new Uint8Array(buf)) : null),
        () => null
      );
    }
    return fontBytesCache[url];
  }

  let uid = 0;
  const nextId = () => 'i' + (++uid);

  const state = {
    doc: null,          // PDFDocument do pdf-lib — a edição acontece aqui
    bytes: null,        // serialização atual de `doc`
    pdf: null,          // documento do pdf.js, derivado de `bytes`
    name: 'documento',
    page: 0,            // página aberta no palco
    scale: 1,           // px por pt do palco (para posicionar itens)
    zoom: 'fit',
    overlays: [],       // itens de texto/imagem por página
    images: [],         // biblioteca de imagens do painel direito
    selected: null,     // id do item selecionado no palco
    editing: null,      // id do item de texto em digitação
    showPdfText: true,  // camada com o texto que já vem no PDF
    pan: { x: 0, y: 0 },// deslocamento da folha no palco (arrastar o fundo)
    defaults: { family: 'Helvetica', size: 16, bold: false, italic: false, color: '#111827' },
    renderSeq: 0,
    renderTask: null,   // render do pdf.js em andamento (cancelado se sobrescrito)
    undo: [],           // desfazer (Ctrl+Z): snapshots dos overlays
    redo: [],           // refazer (Ctrl+Shift+Z): snapshots desfeitos
    editPending: null,  // edição de texto aberta: { snap, id, text }
    lastCoalesce: null, // chave da última mudança contínua (seletor de cor)
    lastCoalesceAt: 0,
  };

  /* Passos de zoom percorridos pelo scroll do mouse e pelo seletor. */
  const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  /* O "100%" do editor renderiza a 75% do tamanho real: a folha inteira,
     com as setas de página, tem que caber na tela sem rolagem. */
  const ZOOM_BASE = 0.75;

  /* Espaço vertical das setas acima e abaixo do papel (2 × 30px + 2 × 12px):
     o "Ajustar" reserva isso para as setas nunca saírem da tela. */
  const ARROW_SPACE = 84;

  const els = {};

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const uidStr = () => nextId();

  function hexToRgb(hex) {
    const value = String(hex || '').replace('#', '');
    const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return PDFLib.rgb(0, 0, 0);
    return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function variantOf(item) {
    return (item.bold ? 'b' : '') + (item.italic ? 'i' : '');
  }

  /** Fonte embutida para um item: StandardFont ou TTF com subsetting.
      `cache` vale por exportação — o pdf-lib só deixa embutir no doc certo. */
  async function embedFontFor(doc, item, cache) {
    const family = FAMILIES[item.family] || FAMILIES.Helvetica;
    const variant = variantOf(item);
    const key = item.family + '|' + variant;
    if (cache[key]) return cache[key];

    let font;
    if (family.kind === 'ttf') {
      const url = fontFileOf(item.family, variant);
      const bytes = url ? await fontBytesOf(url) : null;
      font = bytes
        ? await doc.embedFont(bytes, { subset: true })
        : await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    } else {
      font = await doc.embedFont(PDFLib.StandardFonts[family.variants[variant] || family.variants['']]);
    }
    cache[key] = font;
    return font;
  }

  /**
   * Torna o texto encodable no WinAnsi do PDF.
   *
   * As fontes padrão do PDF só conhecem o conjunto WinAnsi: um emoji ou um
   * glifo raro faz o pdf-lib lançar e a exportação inteira falhar. O que não
   * tem correspondente vira `?` — o que está na tela continua inteiro, só o
   * arquivo impresso perde o símbolo exótico.
   */
  function pdfSafe(text) {
    /* Cobrem tudo que o WinAnsi conhece: ASCII, Latin-1 e os mapeados em
       0x80–0x9F (traços, aspas curvas, ©, ™, €…). */
    const WINANSI_OK = /[\t\n\x20-\x7E\xA0-\xFF¡-ÿŒœŠšŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/;
    return String(text == null ? '' : text)
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // emoji (par sobressalente)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // controle que o PDF rejeita
      .replace(/[^\t\n\x20-\xFF]/g, (ch) => (WINANSI_OK.test(ch) ? ch : '?'));
  }

  function downloadBlob(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function fileSize(kb) {
    return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
  }

  /* ---------------------------------------------------------
     Acesso ao documento
     --------------------------------------------------------- */
  const pageCount = () => (state.doc ? state.doc.getPageCount() : 0);

  function pageSize(index) {
    const i = clamp(index == null ? state.page : index, 0, pageCount() - 1);
    if (!state.doc) return A4;
    const size = state.doc.getPage(i).getSize();
    return { width: size.width, height: size.height };
  }

  const overlaysOf = (pageIndex) => state.overlays.filter((o) => o.page === pageIndex);

  const selectedItem = () => state.overlays.find((o) => o.id === state.selected) || null;

  /* ---------------------------------------------------------
     Ciclo de carga: pdf-lib → bytes → pdf.js
     --------------------------------------------------------- */
  /* ---------------------------------------------------------
     Desfazer / refazer (Ctrl+Z e Ctrl+Shift+Z) — snapshots dos overlays
     --------------------------------------------------------- */
  const UNDO_MAX = 60;

  /** Cópia dos overlays no estado atual (o `orig` também é copiado). */
  function snapshot() {
    return state.overlays.map((item) => {
      const copy = Object.assign({}, item);
      if (item.orig) copy.orig = Object.assign({}, item.orig);
      return copy;
    });
  }

  /**
   * Fecha a edição de texto em aberto, se ela mudou o texto: o snapshot
   * do começo da edição vira um passo de desfazer. Se a edição continuou
   * aberta, instala um novo pendente a partir do estado recém-fechado.
   */
  function flushEditPending() {
    const pending = state.editPending;
    if (!pending) return;
    state.editPending = null;
    const item = state.overlays.find((o) => o.id === pending.id);
    if (item && item.text !== pending.text) {
      state.undo.push(pending.snap);
      if (state.undo.length > UNDO_MAX) state.undo.shift();
      state.redo.length = 0;
      state.lastCoalesce = null;
    }
    if (item && state.editing === pending.id) {
      state.editPending = { snap: snapshot(), id: pending.id, text: item.text };
    }
  }

  /** Empilha um snapshot capturado ANTES da mudança. */
  function commitSnap(snap) {
    flushEditPending();
    state.undo.push(snap);
    if (state.undo.length > UNDO_MAX) state.undo.shift();
    state.redo.length = 0;
    state.lastCoalesce = null;
  }

  /**
   * Marca o início de uma mudança no item selecionado. `coalesce` agrupa
   * mudanças repetidas da mesma operação (o seletor de cor dispara
   * `input` dezenas de vezes) em um único passo de desfazer.
   */
  function beginChange(coalesce) {
    const now = Date.now();
    if (coalesce && state.lastCoalesce === coalesce && now - state.lastCoalesceAt < 1000) {
      state.lastCoalesceAt = now;
      return;
    }
    commitSnap(snapshot());
    state.lastCoalesce = coalesce || null;
    state.lastCoalesceAt = now;
  }

  /** Aplica um snapshot e redesenha (seleção e edição são soltas). */
  function applySnapshot(snap) {
    state.overlays = snap.map((item) => {
      const copy = Object.assign({}, item);
      if (item.orig) copy.orig = Object.assign({}, item.orig);
      return copy;
    });
    state.selected = null;
    state.editing = null;
    state.editPending = null;
    state.lastCoalesce = null;
    renderOverlay();
    updateToolbar();
  }

  function undo() {
    flushEditPending();
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    applySnapshot(state.undo.pop());
    toast('Desfeito');
  }

  function redo() {
    flushEditPending();
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    applySnapshot(state.redo.pop());
    toast('Refeito');
  }

  /**
   * O histórico só vale para a estrutura atual de páginas: inserir,
   * remover ou reordenar páginas invalida os snapshots (os índices de
   * página mudam e o próprio documento pdf-lib não é copiado aqui).
   */
  function clearHistory() {
    state.undo.length = 0;
    state.redo.length = 0;
    state.editPending = null;
    state.lastCoalesce = null;
  }

  async function openPdfBytes(bytes, name) {
    try {
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      state.doc = doc;
      state.name = String(name || 'documento').replace(/\.pdf$/i, '') || 'documento';
      state.overlays = [];
      state.selected = null;
      state.editing = null;
      clearHistory();
      state.page = 0;
      await syncDoc();
      toast('PDF aberto: ' + pageCount() + ' página(s).');
    } catch (err) {
      toast('Não deu para abrir o PDF: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  /** Serializa o pdf-lib e recarrega o pdf.js + a interface. */
  async function syncDoc() {
    state.bytes = await state.doc.save();
    if (state.pdf) {
      try { await state.pdf.destroy(); } catch (err) { /* já descarregado */ }
      state.pdf = null;
    }
    state.pdf = await pdfjsLib.getDocument({ data: state.bytes.slice() }).promise;
    state.page = clamp(state.page, 0, state.pdf.numPages - 1);
    els.empty.hidden = true;
    els.pageWrap.hidden = false;
    updateCounters();
    updateThumbActive();
    await renderThumbs();
    await renderStage();
  }

  /* ---------------------------------------------------------
     Painel esquerdo — miniaturas (uma por linha)
     --------------------------------------------------------- */
  async function renderThumbs() {
    const wrap = els.thumbs;
    wrap.textContent = '';
    const total = state.pdf.numPages;
    for (let i = 0; i < total; i++) {
      const item = document.createElement('div');
      item.className = 'pe-thumb' + (i === state.page ? ' is-active' : '');
      item.dataset.index = String(i);
      item.draggable = true;

      const canvas = document.createElement('canvas');
      canvas.className = 'pe-thumb-canvas';

      const num = document.createElement('span');
      num.className = 'pe-thumb-num';
      num.textContent = String(i + 1);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pe-thumb-del';
      del.title = 'Remover a página ' + (i + 1);
      del.setAttribute('aria-label', del.title);
      del.textContent = '✕';

      item.appendChild(canvas);
      item.appendChild(num);
      item.appendChild(del);
      wrap.appendChild(item);
    }

    /* Renderiza em sequência: várias páginas grandes em paralelo estouram
       a memória do navegador de uma vez só. */
    for (let i = 0; i < total; i++) {
      const canvas = wrap.children[i].querySelector('canvas');
      try {
        const page = await state.pdf.getPage(i + 1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 132 / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      } catch (err) {
        /* página protegida/quebrada: o quadro fica cinza, o resto segue */
      }
    }
  }

  function updateThumbActive() {
    $$('.pe-thumb', els.thumbs).forEach((el) => {
      el.classList.toggle('is-active', Number(el.dataset.index) === state.page);
    });
  }

  function updateCounters() {
    els.pageCount.textContent = String(pageCount());
    els.imgCount.textContent = String(state.images.length);
  }

  /* ---------------------------------------------------------
     Palco — página atual + camada de itens
     --------------------------------------------------------- */
  async function renderStage() {
    if (!state.pdf) return;
    const seq = ++state.renderSeq;
    const page = await state.pdf.getPage(state.page + 1);
    const base = page.getViewport({ scale: 1 });

    let scale;
    if (state.zoom === 'fit') {
      const availW = Math.max(120, els.stage.clientWidth - 32);
      const availH = Math.max(120, els.stage.clientHeight - ARROW_SPACE - 32);
      scale = Math.min(availW / base.width, availH / base.height);
    } else {
      scale = (Number(state.zoom) || 1) * ZOOM_BASE;
    }
    if (seq !== state.renderSeq) return; // outra renderização assumiu o turno

    /* Cancela o render anterior ainda em andamento: com rolagem rápida do
       scroll, vários renders tentariam pintar o mesmo canvas ao mesmo
       tempo e o pdf.js rejeitaria ("Cannot use the same canvas during
       multiple render() operations"). */
    if (state.renderTask) {
      state.renderTask.cancel();
      state.renderTask = null;
    }

    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = els.canvas;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    state.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      // cancelado por um zoom mais novo — o render vencedor pinta
      if (state.renderTask === task) state.renderTask = null;
      return;
    }
    if (state.renderTask === task) state.renderTask = null;
    if (seq !== state.renderSeq) return;

    state.scale = viewport.width / base.width;
    await ensurePdfText(page);
    renderOverlay();
    applyPan();
    updatePageNav();
  }

  /**
   * Transforma o texto que já vem no PDF em itens manipuláveis.
   *
   * O pdf.js expõe a posição de cada trecho de texto da página
   * (getTextContent). Cada trecho vira um item de texto como os nossos, só
   * que invisível (o canvas mostra o original) e "limpo" (dirty = false):
   * a pessoa arrasta, e aí sim o original é coberto de branco na exportação
   * e o texto é redesenhado na nova posição. Texto rotacionado fica onde está.
   */
  async function ensurePdfText(page) {
    if (!state.doc) return;
    /* Já existe a camada para esta página (mesmo depois de zoom ou troca
       de página os itens ficam em state.overlays). */
    if (state.overlays.some((o) => o.orig && o.page === state.page)) return;

    let content;
    try {
      content = await page.getTextContent();
    } catch (err) {
      return; // PDF protegido ou sem camada de texto: segue o baile
    }
    const size = pageSize();
    const vp = page.getViewport({ scale: 1 });
    const ruler = document.createElement('canvas').getContext('2d');

    content.items.forEach((it) => {
      const str = it.str == null ? '' : String(it.str);
      if (!str.trim()) return;
      const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
      if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.03) return; // rotacionado
      const fontSize = Math.hypot(tx[2], tx[3]);
      if (!fontSize || fontSize < 2 || fontSize > 400) return;

      /* Largura medida com a fonte equivalente na tela: dá noção fiel do
         espaço ocupado, para o branco cobrir o original sem sobra. */
      const style = (content.styles && content.styles[it.fontName]) || {};
      ruler.font = fontSize + 'px ' + (style.fontFamily || 'sans-serif');
      const width = ruler.measureText(str).width || it.width || fontSize * 0.5 * str.length;

      const yTop = size.height - tx[5] + fontSize; // topo ≈ altura da ascendente
      state.overlays.push({
        id: uidStr(),
        type: 'text',
        page: state.page,
        x: tx[4] - 0.5,
        yTop,
        text: str,
        family: 'Helvetica',
        size: fontSize,
        bold: false,
        italic: false,
        color: '#000000',
        baseOffset: fontSize, // do topo até a linha de base original
        orig: { x: tx[4] - 0.5, yTop, w: Math.max(3, width + 1.5), h: fontSize * 1.5 },
        dirty: false,
      });
    });
  }

  function renderOverlay() {
    const layer = els.overlay;
    layer.textContent = '';
    if (!state.doc) return;

    const size = pageSize();
    layer.style.setProperty('--pe-scale', String(state.scale));
    layer.classList.toggle('hide-pdf-text', !state.showPdfText);

    const items = overlaysOf(state.page);

    /* Primeiro os retângulos brancos que cobrem o texto original de quem
       já foi movido — debaixo dos itens, como a prévia do PDF exportado. */
    items.forEach((item) => {
      if (item.type !== 'text' || !item.orig || !item.dirty) return;
      const erase = document.createElement('div');
      erase.className = 'pe-erase';
      erase.style.left = (item.orig.x / size.width) * 100 + '%';
      erase.style.top = ((size.height - item.orig.yTop) / size.height) * 100 + '%';
      erase.style.width = (item.orig.w / size.width) * 100 + '%';
      erase.style.height = (item.orig.h / size.height) * 100 + '%';
      layer.appendChild(erase);
    });

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'pe-item pe-item-' + item.type;
      el.dataset.id = item.id;
      el.style.left = (item.x / size.width) * 100 + '%';
      el.style.top = ((size.height - item.yTop) / size.height) * 100 + '%';

      if (item.type === 'text') {
        const family = FAMILIES[item.family] || FAMILIES.Helvetica;
        el.style.fontSize = item.size * state.scale + 'px';
        el.style.fontFamily = family.css;
        el.style.fontWeight = item.bold ? '700' : '400';
        el.style.fontStyle = item.italic ? 'italic' : 'normal';
        /* Texto nativo ainda não mexido fica invisível: o que aparece é o
           próprio PDF no canvas por baixo. Assim não sai "fantasma". */
        el.style.color = item.orig && !item.dirty ? 'transparent' : item.color;
        el.textContent = item.text.length ? item.text : ' ';
        if (item.orig) el.classList.add('pe-item-frompdf');
        if (item.dirty) el.classList.add('is-dirty');
        if (state.editing === item.id) {
          el.contentEditable = 'true';
          el.classList.add('is-editing');
        }

        /* Alças do texto: 4 tiras na borda movem o bloco (valem também
           durante a edição) e 4 quinas escalam o tamanho da fonte. São
           ilhas `contenteditable=false`, então a digitação não lasca. */
        ['n', 's', 'w', 'e'].forEach((lado) => {
          const tira = document.createElement('span');
          tira.className = 'pe-edge pe-edge-' + lado;
          tira.dataset.handle = 'edge';
          tira.contentEditable = 'false';
          el.appendChild(tira);
        });
        /* Depois das tiras: nas interseções as quinas ficam por cima. */
        ['nw', 'ne', 'se', 'sw'].forEach((canto) => {
          const quina = document.createElement('span');
          quina.className = 'pe-corner pe-corner-' + canto;
          quina.dataset.handle = 'corner';
          quina.dataset.corner = canto;
          quina.contentEditable = 'false';
          el.appendChild(quina);
        });
      } else {
        const img = state.images.find((im) => im.id === item.imgId);
        el.style.width = (item.w / size.width) * 100 + '%';
        el.style.height = (item.h / size.height) * 100 + '%';
        if (img) el.style.backgroundImage = 'url("' + img.dataUrl + '")';

        const handle = document.createElement('span');
        handle.className = 'pe-resize';
        handle.dataset.handle = 'resize';
        el.appendChild(handle);
      }

      if (state.selected === item.id) el.classList.add('is-selected');
      layer.appendChild(el);
    });

    renderLayers(); // a lista de camadas acompanha a folha
  }

  /* ---------------------------------------------------------
     Seleção e edição de itens
     --------------------------------------------------------- */

  /* Liga/desliga a marcação visual da seleção SEM reconstruir os itens:
     reconstruir no pointerdown destruía o elemento no meio da sequência
     de cliques, e o navegador deixava de formar o clique duplo. */
  function syncSelection() {
    els.overlay.querySelectorAll('.pe-item').forEach((el) => {
      el.classList.toggle('is-selected', el.dataset.id === state.selected);
    });
    renderLayers(); // o realce da lista acompanha a seleção da folha
  }

  function select(id) {
    if (state.selected === id) return;
    stopEditing();
    state.selected = id;
    syncSelection();
    updateToolbar();
  }

  function deselect() {
    if (!state.selected) return;
    stopEditing();
    state.selected = null;
    syncSelection();
    updateToolbar();
  }

  function startEditing(id) {
    const item = state.overlays.find((o) => o.id === id && o.type === 'text');
    if (!item) return;
    flushEditPending();
    /* Guarda o estado pré-digitação: se o texto mudar, vira passo de
       desfazer quando a edição fechar (ou antes, se outra ação vier).
       Um segundo clique duplo durante a edição não re-armazena — isso
       perderia o snapshot do começo da digitação. */
    if (!state.editPending || state.editPending.id !== id) {
      state.editPending = { snap: snapshot(), id, text: item.text };
    }
    state.editing = id;
    state.selected = id;
    renderOverlay();
    updateToolbar();
    const el = els.overlay.querySelector('.pe-item[data-id="' + id + '"]');
    if (!el) return;
    el.focus();
    /* Seleciona o texto todo: a ideia é digitar por cima e pronto. As
       alças ficam fora do range — se ficassem dentro, digitar por cima
       apagaria os elementos (voltariam só no próximo redesenho). */
    let fim = el.childNodes.length;
    for (let i = 0; i < el.childNodes.length; i++) {
      const no = el.childNodes[i];
      if (no.nodeType === 1 && no.dataset && no.dataset.handle) { fim = i; break; }
    }
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(el, fim);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function stopEditing() {
    if (!state.editing) return;
    const item = state.overlays.find((o) => o.id === state.editing);
    const el = els.overlay.querySelector('.pe-item[data-id="' + state.editing + '"]');
    state.editing = null;
    if (item && el) {
      item.text = normalizeText(el.innerText);
      if (item.orig) item.dirty = true;
      el.contentEditable = 'false';
      el.classList.remove('is-editing');
      el.classList.toggle('is-dirty', !!item.dirty);
    }
    flushEditPending(); // commita a digitação como passo de desfazer, se mudou
    /* Texto nativo do PDF que virou sujo precisa do retângulo branco por
       baixo — único caso em que parar de editar exige redesenho. Nos
       nossos textos, mexer no DOM direto basta e mantém o elemento vivo
       para a sequência de cliques em curso (clique duplo!). */
    if (item && item.orig && item.dirty) renderOverlay();
  }

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/\r/g, '')
      .replace(/\u2028/g, '\n')
      .replace(/\u2029/g, '\n');
  }

  function deleteSelected() {
    const item = selectedItem();
    if (!item) return;
    beginChange();
    /* Texto nativo do PDF: "excluir" vira apagar o trecho — some do arquivo
       exportado (o branco cobre o original) sem afetar o resto da página. */
    if (item.orig) {
      item.text = '';
      item.dirty = true;
    } else {
      state.overlays = state.overlays.filter((o) => o.id !== item.id);
    }
    if (state.editing === item.id) state.editing = null;
    state.selected = null;
    renderOverlay();
    updateToolbar();
  }

  /* ---------------------------------------------------------
     Criação de itens
     --------------------------------------------------------- */
  async function addText(pageIndex, x, yTop) {
    if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
    const page = clamp(pageIndex, 0, pageCount() - 1);
    const size = pageSize(page);
    const d = state.defaults;
    const item = {
      id: uidStr(),
      type: 'text',
      page,
      x: clamp(x, 0, size.width),
      yTop: clamp(yTop, 0, size.height),
      text: 'Texto',
      family: d.family,
      size: d.size,
      bold: d.bold,
      italic: d.italic,
      color: d.color,
    };
    beginChange();
    state.overlays.push(item);
    await goToPage(page, { keepSelection: true });
    /* O palco precisa estar desenhado (renderOverlay) antes de entrar em
       edição: startEditing procura o elemento recém-criado no DOM. */
    startEditing(item.id);
  }

  /** Imagem como elemento por cima da página (não preenche a folha). */
  function addImageOverlay(pageIndex, img, xCenter, yTopCenter) {
    if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
    const page = clamp(pageIndex, 0, pageCount() - 1);
    const size = pageSize(page);
    const ratio = img.height && img.width ? img.height / img.width : 1;
    const w = size.width * 0.5;
    const h = w * ratio;
    const item = {
      id: uidStr(),
      type: 'image',
      page,
      x: clamp(xCenter - w / 2, 0, Math.max(0, size.width - w)),
      yTop: clamp(yTopCenter + h / 2, Math.min(h, size.height), size.height),
      w,
      h,
      imgId: img.id,
    };
    beginChange();
    state.overlays.push(item);
    goToPage(page, { keepSelection: true });
    select(item.id);
  }

  /** Imagem como página inteira: uma folha nova do tamanho da atual,
      com a imagem esticada de ponta a ponta. */
  async function addImageAsPage(imgId, afterIndex) {
    const img = state.images.find((im) => im.id === imgId);
    if (!img) return;
    if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
    clearHistory(); // a estrutura de páginas muda: snapshots antigos não valem mais
    const after = clamp(afterIndex == null ? state.page : afterIndex, 0, pageCount() - 1);
    const size = pageSize(after);
    const embedded = await embedImage(state.doc, img);
    state.doc.insertPage(after + 1, [size.width, size.height]);
    state.doc.getPage(after + 1).drawImage(embedded, { x: 0, y: 0, width: size.width, height: size.height });
    state.page = after + 1;
    await syncDoc();
    toast('Imagem adicionada como a página ' + (after + 2) + '.');
  }

  /** Embute a imagem no doc, convertendo para PNG quando o formato não
      for nativo do PDF (GIF, WebP, BMP…). */
  async function embedImage(doc, img) {
    if (img.mime === 'image/jpeg') return doc.embedJpg(img.bytes);
    if (img.mime === 'image/png') return doc.embedPng(img.bytes);
    const png = await toPngBytes(img.dataUrl);
    return doc.embedPng(png);
  }

  function toPngBytes(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Não consegui converter a imagem.'));
          blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
        }, 'image/png');
      };
      image.onerror = () => reject(new Error('Imagem inválida.'));
      image.src = dataUrl;
    });
  }

  async function addBlankPage(afterIndex) {
    if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
    clearHistory(); // a estrutura de páginas muda: snapshots antigos não valem mais
    const after = clamp(afterIndex == null ? state.page : afterIndex, 0, pageCount() - 1);
    const size = pageSize(after);
    state.doc.insertPage(after + 1, [size.width, size.height]);
    state.page = after + 1;
    await syncDoc();
    toast('Página em branco inserida após a página ' + (after + 1) + '.');
  }

  /* ---------------------------------------------------------
     Páginas — remover e reordenar
     --------------------------------------------------------- */
  async function removePage(index) {
    if (!state.doc) return;
    if (pageCount() <= 1) return toast('O PDF precisa de pelo menos uma página.', 'error');
    if (!window.confirm('Remover a página ' + (index + 1) + '?')) return;
    clearHistory(); // a estrutura de páginas muda: snapshots antigos não valem mais

    state.overlays = state.overlays
      .filter((o) => o.page !== index)
      .map((o) => (o.page > index ? Object.assign({}, o, { page: o.page - 1 }) : o));
    state.doc.removePage(index);
    state.page = clamp(state.page >= index ? state.page - 1 : state.page, 0, pageCount() - 1);
    state.selected = null;
    await syncDoc();
  }

  /** Reordena os índices dos itens junto com a página que eles acompanham. */
  function shiftOverlaysOnMove(from, to) {
    state.overlays = state.overlays.map((o) => {
      if (o.page === from) return Object.assign({}, o, { page: to });
      if (from < to && o.page > from && o.page <= to) return Object.assign({}, o, { page: o.page - 1 });
      if (to < from && o.page >= to && o.page < from) return Object.assign({}, o, { page: o.page + 1 });
      return o;
    });
  }

  async function movePage(from, to) {
    if (!state.doc || from === to) return;
    const total = pageCount();
    to = clamp(to, 0, total - 1);
    clearHistory(); // a estrutura de páginas muda: snapshots antigos não valem mais
    const [copy] = await state.doc.copyPages(state.doc, [from]);
    state.doc.removePage(from);
    state.doc.insertPage(to, copy);
    shiftOverlaysOnMove(from, to);
    state.page = to;
    state.selected = null;
    await syncDoc();
  }

  async function goToPage(index, options) {
    const opts = options || {};
    state.page = clamp(index, 0, pageCount() - 1);
    if (!opts.keepSelection) {
      state.selected = null;
      state.editing = null;
      /* Trocou de folha: sem deslocamento — a nova página começa no meio. */
      state.pan.x = 0;
      state.pan.y = 0;
    }
    updateThumbActive();
    updateToolbar();
    const active = els.thumbs.querySelector('.pe-thumb.is-active');
    if (active && !opts.keepSelection) active.scrollIntoView({ block: 'nearest' });
    await renderStage();
  }

  /** Seta de navegação: desabilitada na primeira/última página. */
  function updatePageNav() {
    const has = !!state.doc;
    els.prevPage.disabled = !has || state.page <= 0;
    els.nextPage.disabled = !has || state.page >= pageCount() - 1;
  }

  /** Nível do zoom na escala do seletor (o state.scale é o valor real). */
  function currentZoomLevel() {
    return state.zoom === 'fit' ? state.scale / ZOOM_BASE : Number(state.zoom);
  }

  /**
   * Aplica o zoom e reposiciona a folha.
   *
   * Com (cx, cy) — o cursor dentro do palco — o ponto sob o mouse fica
   * parado no lugar (zoom "no cursor"). Sem cursor, o deslocamento atual
   * é reescalado junto, mantendo o enquadramento.
   */
  function setZoom(value, cx, cy) {
    const before = state.scale || 1;
    state.zoom = String(value);
    els.zoom.value = state.zoom;

    if (state.zoom !== 'fit') {
      const f = (Number(state.zoom) * ZOOM_BASE) / before;
      if (cx != null && cy != null) {
        const halfX = els.stage.clientWidth / 2;
        const halfY = els.stage.clientHeight / 2;
        state.pan.x = cx - halfX - (cx - halfX - state.pan.x) * f;
        state.pan.y = cy - halfY - (cy - halfY - state.pan.y) * f;
      } else {
        state.pan.x *= f;
        state.pan.y *= f;
      }
    }
    renderStage(); // o fim do render chama applyPan, que limita o deslocamento
  }

  /** Um passo de zoom na escala ZOOM_STEPS (scroll do mouse e seletor). */
  function stepZoom(direction, cx, cy) {
    const current = currentZoomLevel();
    let index = 0;
    let best = Infinity;
    ZOOM_STEPS.forEach((level, i) => {
      const d = Math.abs(level - current);
      if (d < best) {
        best = d;
        index = i;
      }
    });
    index = clamp(index + direction, 0, ZOOM_STEPS.length - 1);
    setZoom(ZOOM_STEPS[index], cx, cy);
  }

  /**
   * Centraliza a folha no palco e limita o deslocamento às bordas da
   * área: a folha cobre o palco inteiro enquanto ampliada — as setas
   * nunca ultrapassam o topo nem a base da área da página.
   */
  function applyPan() {
    const wrap = els.pageWrap;
    if (!state.doc || wrap.hidden) return;
    const stage = els.stage;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const size = wrap.getBoundingClientRect(); // translate não muda o tamanho
    /* Limite exato às bordas da área: enquanto a folha é maior que o
       palco, ele fica SEMPRE coberto — a seta de cima encosta no topo (ou
       some acima dele) e a de baixo nunca sobe além da borda inferior.
       Não sobra espaço vazio em cima nem embaixo. */
    const mx = Math.max(0, (size.width - sw) / 2);
    const my = Math.max(0, (size.height - sh) / 2);
    state.pan.x = clamp(state.pan.x, -mx, mx);
    state.pan.y = clamp(state.pan.y, -my, my);
    wrap.style.transform =
      'translate(-50%, -50%) translate(' + state.pan.x + 'px, ' + state.pan.y + 'px)';
    stage.classList.toggle('can-pan', mx > 0 || my > 0);
  }

  /* ---------------------------------------------------------
     Painel direito — biblioteca de imagens
     --------------------------------------------------------- */
  async function addImagesToLibrary(files, place) {
    const list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    let added = 0;
    for (const file of list) {
      if (!/^image\//i.test(file.type)) {
        toast('"' + file.name + '" não é uma imagem.', 'error');
        continue;
      }
      if (file.size > MAX_IMG_BYTES) {
        toast('"' + file.name + "' passa de 25 MB.", 'error');
        continue;
      }
      try {
        const dataUrl = await dataUrlFor(file);
        const dims = await imageSize(dataUrl);
        const img = {
          id: uidStr(),
          name: file.name,
          dataUrl,
          mime: file.type.toLowerCase() === 'image/jpg' ? 'image/jpeg' : file.type.toLowerCase(),
          bytes: dataUrlBytes(dataUrl),
          width: dims.width,
          height: dims.height,
        };
        state.images.push(img);
        added += 1;
        if (place && state.doc) {
          const size = pageSize();
          addImageOverlay(state.page, img, size.width / 2, size.height / 2);
        }
      } catch (err) {
        toast('"' + file.name + '": ' + (err && err.message ? err.message : err), 'error');
      }
    }
    renderImages();
    if (added) toast(added + ' imagem(ns) no painel direito.');
  }

  function dataUrlBytes(dataUrl) {
    const base64 = String(dataUrl).split(',')[1] || '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function imageSize(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('não consegui ler a imagem'));
      image.src = dataUrl;
    });
  }

  function renderImages() {
    const grid = els.imgGrid;
    grid.textContent = '';
    updateCounters();

    if (!state.images.length) {
      grid.appendChild(emptyHint('Arraste imagens aqui, cole (Ctrl+V) ou clique no +.'));
      return;
    }

    state.images.forEach((img) => {
      const card = document.createElement('figure');
      card.className = 'pe-img';
      card.draggable = true;
      card.dataset.id = img.id;

      const thumb = document.createElement('div');
      thumb.className = 'pe-img-thumb';
      thumb.style.backgroundImage = 'url("' + img.dataUrl + '")';

      const cap = document.createElement('figcaption');
      cap.className = 'pe-img-name';
      cap.textContent = img.name;
      cap.title = img.name + ' — ' + img.width + 'x' + img.height + ' — ' + fileSize(img.bytes.length * 0.75 / 1024);

      const acts = document.createElement('div');
      acts.className = 'pe-img-acts';

      const asPage = document.createElement('button');
      asPage.type = 'button';
      asPage.className = 'btn btn-soft btn-sm';
      asPage.dataset.act = 'page';
      asPage.title = 'Criar uma página inteira com esta imagem';
      asPage.textContent = 'Página';

      const ins = document.createElement('button');
      ins.type = 'button';
      ins.className = 'btn btn-soft btn-sm';
      ins.dataset.act = 'insert';
      ins.title = 'Soltar esta imagem no centro da página atual';
      ins.textContent = 'Ins.';

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'icon-btn pe-img-del';
      del.dataset.act = 'remove';
      del.title = 'Tirar da biblioteca';
      del.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="m4.2 3.1 8.7 8.7-1.1 1.1L3.1 4.2l1.1-1.1ZM12.9 3.1l1.1 1.1L4.2 14l-1.1-1.1L12.9 3.1Z"/></svg>';

      acts.appendChild(asPage);
      acts.appendChild(ins);
      card.appendChild(del);
      card.appendChild(thumb);
      card.appendChild(cap);
      card.appendChild(acts);
      grid.appendChild(card);
    });
  }

  function emptyHint(text) {
    const el = document.createElement('p');
    el.className = 'pe-hint';
    el.textContent = text;
    return el;
  }

  /* ---------------------------------------------------------
     Barra de ferramentas
     --------------------------------------------------------- */
  function updateToolbar() {
    const item = selectedItem();
    const text = item && item.type === 'text' ? item : null;
    const source = text || state.defaults;

    els.font.value = source.family;
    els.size.value = String(source.size);
    els.color.value = source.color;
    els.bold.classList.toggle('is-on', !!source.bold);
    els.bold.setAttribute('aria-pressed', String(!!source.bold));
    els.italic.classList.toggle('is-on', !!source.italic);
    els.italic.setAttribute('aria-pressed', String(!!source.italic));

    /* Fonte/cor só fazem sentido em texto: com uma imagem selecionada os
       controles ficam inativos em vez de aplicar em silêncio em nada. */
    const textDisabled = item && item.type !== 'text';
    [els.font, els.size, els.color, els.bold, els.italic].forEach((el) => {
      el.disabled = !!textDisabled;
    });
    els.del.disabled = !item;

    /* "Editar texto": funciona para texto nosso e para o texto nativo do
       PDF — mesma caixa de edição, botão visível lá na barra. */
    els.edit.disabled = !text;
    els.edit.textContent = state.editing ? 'Concluir' : 'Editar texto';
    els.edit.classList.toggle('is-on', !!state.editing);
  }

  function patchSelected(patch, coalesce) {
    const item = selectedItem();
    if (item && item.type === 'text') {
      beginChange(coalesce);
      /* No texto nativo do PDF a linha de base fica a `baseOffset` do topo;
         mudar o tamanho tem que manter essa distância na proporção nova. */
      if (patch.size && item.baseOffset && patch.size !== item.size) {
        item.baseOffset *= patch.size / item.size;
      }
      Object.assign(item, patch);
      if (item.orig) item.dirty = true;
      renderOverlay();
    } else {
      Object.assign(state.defaults, patch);
    }
    updateToolbar();
  }

  /* ---------------------------------------------------------
     Arrastar e soltar — itens no palco
     --------------------------------------------------------- */
  function pointToPage(clientX, clientY) {
    const rect = els.canvas.getBoundingClientRect();
    const size = pageSize();
    return {
      x: ((clientX - rect.left) / rect.width) * size.width,
      yTop: size.height - ((clientY - rect.top) / rect.height) * size.height,
    };
  }

  function bindStageDrag() {
    let drag = null;
    let pan = null;

    els.overlay.addEventListener('pointerdown', (event) => {
      const el = event.target.closest('.pe-item');
      if (!el) return;
      const item = state.overlays.find((o) => o.id === el.dataset.id);
      if (!item) return;

      /* Soltar o cursor dentro de um texto em edição tem que servir para
         posicionar o caret, não para arrastar o bloco. */
      if (state.editing === item.id && !event.target.dataset.handle) return;

      /* Qualquer alça (imagem, quina ou borda de texto) cancela o default:
         cancelar o pointerdown do próprio item de texto suprimiria o duplo
         clique de editar (evento derivado dos mousedown/mouseup compatíveis),
         mas nas alças isso é o que queremos — elas nunca começam edição. */
      const handle = event.target.dataset.handle;
      if (handle) event.preventDefault();

      select(item.id);

      drag = {
        id: item.id,
        mode: handle === 'resize' ? 'resize' : handle === 'corner' ? 'corner' : 'move',
        startX: event.clientX,
        startY: event.clientY,
        item: Object.assign({}, item),
        before: snapshot(), // estado pré-arraste: vira passo de desfazer
        moved: false,       // vira true ao passar da zona morta de 3px
        ratio: item.type === 'image' && item.w ? item.h / item.w : 0,
      };

      /* Quina de texto: mede a caixa e a âncora (canto oposto ao que foi
         agarrado) para escalar a fonte a partir dali, como um resize de
         verdade — a âncora fica parada no papel. */
      if (drag.mode === 'corner') {
        const r = el.getBoundingClientRect();
        const canto = event.target.dataset.corner || 'se';
        drag.corner = canto;
        drag.ax = canto.indexOf('w') >= 0 ? r.right : r.left;
        drag.ay = canto.indexOf('n') >= 0 ? r.bottom : r.top;
        drag.d0 = Math.hypot(event.clientX - drag.ax, event.clientY - drag.ay) || 1;
        drag.box = { w: r.width, h: r.height };
      }

      /* A captura do ponteiro acontece SÓ no pointermove (depois da zona
         morta de 3px, logo abaixo). Capturar aqui, no pointerdown, mandava
         o mouseup para a camada overlay: o clique virava alvo comum
         (overlay) e o clique duplo nunca chegava no item de texto. */
    });

    els.overlay.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const item = state.overlays.find((o) => o.id === drag.id);
      const el = els.overlay.querySelector('.pe-item[data-id="' + drag.id + '"]');
      if (!item || !el) return;
      const scale = state.scale || 1;
      const dx = (event.clientX - drag.startX) / scale;
      const dy = (event.clientY - drag.startY) / scale;
      const size = pageSize();

      /* Zona morta de 3px: clique simples não arrasta nada. Só o arraste
         que passa dela captura o ponteiro (para continuar seguindo o
         mouse fora da folha) — capturar no pointerdown reprova o clique
         duplo do navegador: o mouseup ia parar na camada overlay e o
         dblclick nunca chegaria no item. */
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 3 &&
            Math.abs(event.clientY - drag.startY) < 3) return;
        drag.moved = true;
        try { els.overlay.setPointerCapture(event.pointerId); } catch (err) { /* ponteiro inativo */ }
        document.body.classList.add('pe-cursor-move');
      }

      if (drag.mode === 'move') {
        item.x = clamp(drag.item.x + dx, -itemW(item) * 0.5, size.width - itemW(item) * 0.5);
        item.yTop = clamp(drag.item.yTop - dy, -itemH(item) * 0.5, size.height + itemH(item) * 0.5);
        /* Mexer no texto nativo do PDF significa redesenhá-lo em outro lugar
           — o original passa a ser coberto na exportação. */
        if (item.orig && (item.x !== drag.item.x || item.yTop !== drag.item.yTop)) {
          item.dirty = true;
        }
      } else if (drag.mode === 'resize') {
        let w = Math.max(12, drag.item.w + dx);
        let h;
        if (event.shiftKey && drag.ratio) {
          h = w * drag.ratio;
        } else {
          /* Sinal positivo: a alça fica na borda de baixo, então arrastar
             para baixo cresce (a borda de cima fica fixa no papel) e para
             cima encolhe — a borda segue o cursor. */
          h = Math.max(12, drag.item.h + dy);
        }
        item.w = w;
        item.h = h;
      } else {
        /* Quina de texto: a fonte cresce com a distância do cursor até a
           âncora — arrastar para longe aumenta, para perto reduz. */
        const d = Math.hypot(event.clientX - drag.ax, event.clientY - drag.ay);
        const nova = clamp(Math.round(drag.item.size * (d / drag.d0) * 10) / 10, 4, 280);
        const f = nova / drag.item.size;
        item.size = nova;
        /* Texto que já vem no PDF: mudar o tamanho conta como redesenho. */
        if (item.orig && nova !== drag.item.size) item.dirty = true;
        /* A âncora fica parada no papel: mover a caixa na direção oposta
           ao canto agarrado, proporcional ao crescimento. */
        const dw = (drag.box.w * (f - 1)) / scale;
        const dh = (drag.box.h * (f - 1)) / scale;
        if (drag.corner.indexOf('w') >= 0) item.x = drag.item.x - dw;
        if (drag.corner.indexOf('n') >= 0) item.yTop = drag.item.yTop + dh;
      }

      el.style.left = (item.x / size.width) * 100 + '%';
      el.style.top = ((size.height - item.yTop) / size.height) * 100 + '%';
      if (drag.mode === 'resize') {
        el.style.width = (item.w / size.width) * 100 + '%';
        el.style.height = (item.h / size.height) * 100 + '%';
      }
      if (drag.mode === 'corner') {
        el.style.fontSize = item.size * scale + 'px';
      }
    });

    const end = () => {
      if (drag) {
        /* Só vira passo de desfazer se algo realmente mudou — um clique
           simples em cima do item (sem arrastar) não empilha nada. */
        const live = state.overlays.find((o) => o.id === drag.id);
        if (live && (live.x !== drag.item.x || live.yTop !== drag.item.yTop ||
            live.w !== drag.item.w || live.h !== drag.item.h ||
            live.size !== drag.item.size ||
            live.dirty !== drag.item.dirty)) {
          commitSnap(drag.before);
        }
        /* Texto nativo do PDF que passou a ser sujo neste arraste: entra
           o retângulo branco por baixo (único motivo de redesenhar). */
        if (live && live.orig && live.dirty !== drag.item.dirty) renderOverlay();
        if (drag.mode === 'corner') updateToolbar(); // sincroniza o campo de tamanho
      }
      drag = null;
      document.body.classList.remove('pe-cursor-move');
    };
    els.overlay.addEventListener('pointerup', end);
    els.overlay.addEventListener('pointercancel', end);

    els.overlay.addEventListener('dblclick', (event) => {
      /* Cl duplo em qualquer ponto do item — inclusive em cima de uma
         alça — é intenção de editar. Alças não geram arraste em clique
         simples (zona morta de 3px), então não há conflito. */
      const el = event.target.closest('.pe-item-text');
      if (el) startEditing(el.dataset.id);
    });

    /* Digitação dentro do item de texto */
    els.overlay.addEventListener('input', (event) => {
      const el = event.target.closest('.pe-item-text');
      if (!el || state.editing !== el.dataset.id) return;
      const item = state.overlays.find((o) => o.id === el.dataset.id);
      if (!item) return;
      item.text = normalizeText(el.innerText);
      if (item.orig) item.dirty = true;
    });

    els.overlay.addEventListener('keydown', (event) => {
      const el = event.target.closest('.pe-item-text');
      if (!el || state.editing !== el.dataset.id) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        stopEditing();
        return;
      }
      /* Enter tem que virar quebra de linha de verdade: o contenteditable
         padrão criaria <div> e o pdf não sairia igual à tela. */
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        document.execCommand('insertText', false, '\n');
      }
    });

    els.overlay.addEventListener('blur', (event) => {
      const el = event.target.closest && event.target.closest('.pe-item-text');
      /* Elemento reconstruído no meio da edição (renderOverlay o removeu):
         o Chrome dispara blur na remoção, mas isso não é o usuário saindo
         do texto — encerraria a edição no meio do próprio redesenho. */
      if (el && el.isConnected && state.editing === el.dataset.id) stopEditing();
    }, true);

    /* Arrastar o fundo (fora dos itens) move a folha quando o zoom passa
       da tela; no mesmo gesto o clique simples desmarca o item. */
    els.stage.addEventListener('pointerdown', (event) => {
      if (!state.doc || event.button !== 0) return;
      if (event.target.closest('.pe-item, .pe-nav-arrow, .pe-empty')) return;
      deselect();
      pan = {
        x: event.clientX,
        y: event.clientY,
        panX: state.pan.x,
        panY: state.pan.y,
      };
      els.stage.setPointerCapture(event.pointerId);
      els.stage.classList.add('is-panning');
    });

    els.stage.addEventListener('pointermove', (event) => {
      if (!pan) return;
      state.pan.x = pan.panX + (event.clientX - pan.x);
      state.pan.y = pan.panY + (event.clientY - pan.y);
      applyPan();
    });

    const endPan = () => {
      pan = null;
      els.stage.classList.remove('is-panning');
    };
    els.stage.addEventListener('pointerup', endPan);
    els.stage.addEventListener('pointercancel', endPan);
  }

  const itemW = (item) => (item.type === 'image' ? item.w : pageSize().width * 0.4);
  const itemH = (item) => (item.type === 'image' ? item.h : item.size * 1.4);

  /* ---------------------------------------------------------
     Arrastar e soltar — páginas (reordenar) e arquivos
     --------------------------------------------------------- */
  function bindThumbs() {
    let from = null;

    els.thumbs.addEventListener('dragstart', (event) => {
      const thumb = event.target.closest('.pe-thumb');
      if (!thumb) return;
      from = Number(thumb.dataset.index);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/pe-page', String(from));
      thumb.classList.add('is-dragging');
    });

    els.thumbs.addEventListener('dragend', () => {
      from = null;
      $$('.pe-thumb', els.thumbs).forEach((el) => {
        el.classList.remove('is-dragging', 'is-over-top', 'is-over-bottom');
      });
    });

    els.thumbs.addEventListener('dragover', (event) => {
      if (from == null) return;
      const thumb = event.target.closest('.pe-thumb');
      if (!thumb) return;
      event.preventDefault();
      const rect = thumb.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      $$('.pe-thumb', els.thumbs).forEach((el) => {
        el.classList.remove('is-over-top', 'is-over-bottom');
      });
      thumb.classList.add(after ? 'is-over-bottom' : 'is-over-top');
    });

    els.thumbs.addEventListener('drop', (event) => {
      const thumb = event.target.closest('.pe-thumb');
      if (!thumb || from == null) return;
      event.preventDefault();
      const rect = thumb.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      let to = Number(thumb.dataset.index) + (after ? 1 : 0);
      const moving = from;
      if (to > moving) to -= 1;
      from = null;
      movePage(moving, clamp(to, 0, pageCount() - 1));
    });

    els.thumbs.addEventListener('click', (event) => {
      const thumb = event.target.closest('.pe-thumb');
      if (!thumb) return;
      if (event.target.closest('.pe-thumb-del')) {
        removePage(Number(thumb.dataset.index));
        return;
      }
      goToPage(Number(thumb.dataset.index));
    });
  }

  function carriesFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  function bindFileDrops() {
    /* Soltar PDF em qualquer lugar do palco abre o arquivo. */
    els.stage.addEventListener('dragover', (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    els.stage.addEventListener('drop', async (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const files = Array.prototype.slice.call(event.dataTransfer.files || []);
      const pdfs = files.filter((f) => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
      if (pdfs.length) {
        if (state.doc && !window.confirm('Substituir o PDF atual pelo que foi solto aqui?')) return;
        openPdfBytes(new Uint8Array(await pdfs[0].arrayBuffer()), pdfs[0].name.replace(/\.pdf$/i, ''));
        return;
      }
      const imgs = files.filter((f) => /^image\//i.test(f.type));
      if (!imgs.length) return;
      const before = state.images.length;
      await addImagesToLibrary(imgs, false);
      /* Toda imagem solta no palco também entra na página, caindo no ponto
         exato do mouse (as que caíram em sequência espalham um pouco). */
      if (!state.doc) return;
      const point = pointToPage(event.clientX, event.clientY);
      const added = state.images.slice(before);
      added.forEach((img, i) => {
        addImageOverlay(state.page, img, point.x + i * 12, point.yTop - i * 12);
      });
    });

    /* Soltar imagem no painel direito só alimenta a biblioteca. */
    const stop = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
    };
    els.imgGrid.addEventListener('dragover', stop);
    els.imgGrid.addEventListener('drop', async (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const files = Array.prototype.slice.call(event.dataTransfer.files || []);
      addImagesToLibrary(files.filter((f) => /^image\//i.test(f.type)), false);
    });

    /* Arrastar uma imagem do painel para a folha a solta no ponto exato. */
    els.imgGrid.addEventListener('dragstart', (event) => {
      const card = event.target.closest('.pe-img');
      if (!card) return;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/pe-image', card.dataset.id);
    });

    els.stage.addEventListener('dragover', (event) => {
      if (event.dataTransfer.types.indexOf('text/pe-image') === -1) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    els.stage.addEventListener('drop', (event) => {
      const id = event.dataTransfer.getData('text/pe-image');
      if (!id) return;
      event.preventDefault();
      const img = state.images.find((im) => im.id === id);
      if (!img) return;
      if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
      const point = pointToPage(event.clientX, event.clientY);
      addImageOverlay(state.page, img, point.x, point.yTop);
    });

    /* Colar imagem (Ctrl+V): entra na biblioteca e na página atual. */
    document.addEventListener('paste', async (event) => {
      const files = imageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      await addImagesToLibrary(files, true);
    });
  }

  /* ---------------------------------------------------------
     Botões do painel de imagens
     --------------------------------------------------------- */
  function bindImageCards() {
    els.imgGrid.addEventListener('click', (event) => {
      const card = event.target.closest('.pe-img');
      const act = event.target.closest('[data-act]');
      if (!card || !act) return;
      const img = state.images.find((im) => im.id === card.dataset.id);
      if (!img) return;

      if (act.dataset.act === 'page') {
        addImageAsPage(img.id, state.page);
      } else if (act.dataset.act === 'insert') {
        if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
        const size = pageSize();
        addImageOverlay(state.page, img, size.width / 2, size.height / 2);
      } else if (act.dataset.act === 'remove') {
        state.images = state.images.filter((im) => im.id !== img.id);
        /* Item já colado na folha continua: ele guarda a referência, e a
           exportação usa o nome dela. Só some da biblioteca. */
        renderImages();
      }
    });
  }

  /* ---------------------------------------------------------
     Camadas — o que está por cima do quê na página atual
     --------------------------------------------------------- */
  const SETA_CIMA = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 4.2 3.6 8.6l1.1 1.1L7.2 7.2V13h1.6V7.2l2.5 2.5 1.1-1.1L8 4.2Z"/></svg>';
  const SETA_BAIXO = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 11.8 12.4 7.4l-1.1-1.1L8.8 8.8V3H7.2v5.8L4.7 6.3 3.6 7.4 8 11.8Z"/></svg>';

  /** Rótulo da camada: a primeira linha do texto, ou o nome do arquivo. */
  function layerLabel(item) {
    if (item.type === 'text') {
      const primeira = (item.text || '').split('\n')[0].trim();
      return primeira || '(texto vazio)';
    }
    const img = state.images.find((im) => im.id === item.imgId);
    return img ? img.name : '(imagem removida)';
  }

  function layerBtn(act, title, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pe-layer-btn';
    b.dataset.act = act;
    b.title = title;
    b.disabled = !!disabled;
    b.innerHTML = act === 'up' ? SETA_CIMA : SETA_BAIXO;
    return b;
  }

  /* Repinta a lista: topo da pilha primeiro (como nos editores de imagem),
     seleção em dia e setas inativas nos extremos. Roda junto do
     renderOverlay e da syncSelection — nunca por conta própria. */
  function renderLayers() {
    if (!els.layers) return;
    const items = overlaysOf(state.page);
    els.layerCount.textContent = String(items.length);
    els.layers.textContent = '';
    if (!items.length) {
      const vazio = document.createElement('p');
      vazio.className = 'pe-layers-empty muted';
      vazio.textContent = 'Nada nesta página ainda — insira imagens ou texto.';
      els.layers.appendChild(vazio);
      return;
    }
    items.slice().reverse().forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'pe-layer' + (state.selected === item.id ? ' is-active' : '');
      row.dataset.id = item.id;
      row.draggable = true;
      row.title = 'Clique para selecionar; arraste para reordenar';

      /* Miniatura do conteúdo: a imagem em si, ou o texto renderizado
         com a fonte/cor/tamanho do item. */
      const previa = document.createElement('span');
      previa.className = 'pe-layer-prev';
      if (item.type === 'image') {
        const img = state.images.find((im) => im.id === item.imgId);
        if (img) previa.style.backgroundImage = 'url("' + img.dataUrl + '")';
      } else {
        const familia = FAMILIES[item.family] || FAMILIES.Helvetica;
        previa.style.fontFamily = familia.css;
        previa.style.fontWeight = item.bold ? '700' : '400';
        previa.style.fontStyle = item.italic ? 'italic' : 'normal';
        previa.style.color = item.color || '#1f2937';
        previa.textContent = (item.text || ' ').split('\n')[0].slice(0, 14);
      }
      row.appendChild(previa);

      const nome = document.createElement('span');
      nome.className = 'pe-layer-name';
      nome.textContent = layerLabel(item);
      row.appendChild(nome);

      row.appendChild(layerBtn('up', 'Subir: fica por cima', i === 0));
      row.appendChild(layerBtn('down', 'Descer: fica por baixo', i === items.length - 1));
      els.layers.appendChild(row);
    });
  }

  /** Grava uma nova ordem (topo->base) de volta no state.overlays. Os
      itens das outras páginas ficam onde estão — só o conteúdo dos
      espaços desta página é reescrito na ordem nova. O array é base->topo,
      por isso a inversão antes de preencher os espaços. */
  function applyLayerOrder(vis) {
    beginChange(); // estado pré-troca vira passo de desfazer
    let k = 0;
    const baseParaTopo = vis.slice().reverse();
    state.overlays = state.overlays.map((o) => (o.page === state.page ? baseParaTopo[k++] : o));
    renderOverlay(); // repinta a folha e a própria lista
  }

  /** Sobe/desce a camada na pilha (troca com a vizinha). */
  function moveLayer(id, dir) {
    const vis = overlaysOf(state.page).slice().reverse();
    const de = vis.findIndex((o) => o.id === id);
    if (de < 0) return;
    const alvo = de + dir;
    if (alvo < 0 || alvo >= vis.length) return;
    const item = vis.splice(de, 1)[0];
    vis.splice(alvo, 0, item);
    applyLayerOrder(vis);
  }

  /** Reordenar arrastando: move `id` para a posição de `alvoId`, antes ou
      depois conforme o meio da linha onde o mouse soltou. */
  function moveLayerTo(id, alvoId, depois) {
    if (id === alvoId) return;
    const vis = overlaysOf(state.page).slice().reverse();
    const de = vis.findIndex((o) => o.id === id);
    if (de < 0) return;
    const item = vis.splice(de, 1)[0];
    const para = vis.findIndex((o) => o.id === alvoId);
    if (para < 0) return;
    vis.splice(para + (depois ? 1 : 0), 0, item);
    applyLayerOrder(vis);
  }

  function bindLayers() {
    els.layers.addEventListener('click', (event) => {
      const row = event.target.closest('.pe-layer');
      if (!row) return;
      const act = event.target.closest('[data-act]');
      if (act) {
        /* A lista é o inverso do array: subir na lista = índice -1. */
        moveLayer(row.dataset.id, act.dataset.act === 'up' ? -1 : 1);
        return;
      }
      select(row.dataset.id);
    });

    /* Reordenar arrastando — mesma receita das miniaturas de página. */
    let arrastando = null;
    const limpar = () => {
      arrastando = null;
      $$('.pe-layer', els.layers).forEach((el) => {
        el.classList.remove('is-dragging', 'is-over-top', 'is-over-bottom');
      });
    };
    els.layers.addEventListener('dragstart', (event) => {
      const row = event.target.closest('.pe-layer');
      if (!row) return;
      arrastando = row.dataset.id;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/pe-layer', arrastando);
    });
    els.layers.addEventListener('dragover', (event) => {
      if (!arrastando) return;
      const row = event.target.closest('.pe-layer');
      if (!row) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const depois = event.clientY > rect.top + rect.height / 2;
      $$('.pe-layer', els.layers).forEach((el) => {
        el.classList.remove('is-over-top', 'is-over-bottom');
      });
      if (row.dataset.id !== arrastando) {
        row.classList.add(depois ? 'is-over-bottom' : 'is-over-top');
      }
    });
    els.layers.addEventListener('drop', (event) => {
      if (!arrastando) return;
      const row = event.target.closest('.pe-layer');
      if (!row) { limpar(); return; }
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const depois = event.clientY > rect.top + rect.height / 2;
      const de = arrastando;
      const para = row.dataset.id;
      limpar();
      moveLayerTo(de, para, depois);
    });
    els.layers.addEventListener('dragend', limpar);
  }

  /** Gaveta de camadas: abre/fecha com a seta na borda do painel. */
  function bindDrawer() {
    els.drawerToggle.addEventListener('click', () => {
      const aberto = els.drawer.classList.toggle('is-open');
      els.drawerToggle.classList.toggle('is-open', aberto);
      els.drawerToggle.setAttribute('aria-expanded', String(aberto));
      els.drawerToggle.title = aberto ? 'Esconder as camadas' : 'Mostrar as camadas';
    });
  }

  /* ---------------------------------------------------------
     Exportar
     --------------------------------------------------------- */
  async function exportPdf() {
    if (!state.doc) return toast('Abra um PDF primeiro.', 'error');
    const button = els.save;
    button.disabled = true;
    try {
      /* Trabalha numa cópia: os itens continuam editáveis no editor. */
      const bytes = await state.doc.save();
      const out = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      /* Fontkit habilita embutir TTF (Google Fonts) com subsetting. */
      if (window.fontkit) out.registerFontkit(window.fontkit);
      const fonts = {};
      const embedded = {};

      for (const item of state.overlays) {
        if (item.page >= out.getPageCount()) continue;
        const page = out.getPage(item.page);
        const size = page.getSize();

        if (item.type === 'text') {
          /* Texto que já veio no PDF (item.orig): só mexeu = apaga o trecho
             original com retângulo branco e redesenha na nova posição.
             Sem dirty, o original fica intocado na folha. */
          const dirty = item.orig ? item.dirty : true;
          if (!dirty) continue;
          if (item.orig) {
            page.drawRectangle({
              x: item.orig.x,
              y: size.height - item.orig.yTop - item.orig.h,
              width: item.orig.w,
              height: item.orig.h,
              color: PDFLib.rgb(1, 1, 1),
            });
          }
          if (!item.text || !item.text.trim()) continue; // apagado de propósito
          const font = await embedFontFor(out, item, fonts);
          /* Linha a linha: o drawText do pdf-lib 1.17 só aceita string —
             array derruba a exportação inteira. */
          const lineHeight = item.size * 1.2;
          const firstBaseline = item.orig
            ? item.yTop - item.baseOffset
            : item.yTop - font.heightAtSize(item.size);
          pdfSafe(item.text).split('\n').forEach((line, i) => {
            if (!line) return;
            page.drawText(line, {
              x: item.x,
              y: firstBaseline - i * lineHeight,
              size: item.size,
              font,
              color: hexToRgb(item.color),
            });
          });
        } else {
          const img = state.images.find((im) => im.id === item.imgId);
          if (!img) continue;
          if (!embedded[img.id]) {
            embedded[img.id] = await embedImage(out, img);
          }
          page.drawImage(embedded[img.id], {
            x: item.x,
            y: size.height - item.yTop,
            width: item.w,
            height: item.h,
          });
        }
      }

      const final = await out.save();
      downloadBlob(final, state.name + '-editado.pdf', 'application/pdf');
      toast('PDF baixado.');
    } catch (err) {
      toast('Erro ao exportar: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      button.disabled = false;
    }
  }

  /** PNG da página aberta, com os itens desenhados por cima. */
  async function exportPagePng() {
    if (!state.pdf) return toast('Abra um PDF primeiro.', 'error');
    const page = await state.pdf.getPage(state.page + 1);
    const scale = 2; // 144 dpi — legível para print e para mandar no chat
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    await paintOverlays(ctx, scale);

    canvas.toBlob((blob) => {
      if (!blob) return toast('Não consegui gerar o PNG.', 'error');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = state.name + '-pagina-' + (state.page + 1) + '.png';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast('Página ' + (state.page + 1) + ' salva como imagem.');
    }, 'image/png');
  }

  /** Reproduz os itens no canvas do PNG, na mesma geometria do PDF. */
  async function paintOverlays(ctx, scale) {
    const size = pageSize();
    const items = overlaysOf(state.page);
    if (!items.length) return;

    const images = {};
    /* Só as imagens usadas nesta página entram na conta: a biblioteca
       pode ter dezenas de fotos pesadas. */
    const used = items.filter((it) => it.type === 'image').map((it) => it.imgId);
    await Promise.all(state.images.filter((im) => used.indexOf(im.id) !== -1).map((img) => {
      images[img.id] = null;
      return new Promise((resolve) => {
        const el = new Image();
        el.onload = () => { images[img.id] = el; resolve(); };
        el.onerror = resolve;
        el.src = img.dataUrl;
      });
    }));

    for (const item of items) {
      if (item.type === 'image') {
        const el = images[item.imgId];
        if (!el) continue;
        ctx.drawImage(el, item.x * scale, (size.height - item.yTop) * scale, item.w * scale, item.h * scale);
      } else {
        /* Mesma regra do PDF: item do texto original só entra se mexido. */
        if (item.orig) {
          if (!item.dirty) continue;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(
            item.orig.x * scale,
            (size.height - item.orig.yTop) * scale,
            item.orig.w * scale,
            item.orig.h * scale
          );
        }
        if (!item.text) continue;
        const family = FAMILIES[item.family] || FAMILIES.Helvetica;
        const style = item.italic ? 'italic ' : '';
        const weight = item.bold ? '700 ' : '';
        ctx.font = style + weight + item.size * scale + 'px ' + family.css;
        ctx.fillStyle = item.color;
        ctx.textBaseline = 'alphabetic';

        const probe = ctx.measureText('M');
        const ascent = item.orig
          ? item.baseOffset * scale
          : probe.fontBoundingBoxAscent || item.size * scale * 0.8;
        const lineHeight = item.size * scale * 1.2;
        const baseline = (size.height - item.yTop) * scale + ascent;
        item.text.split('\n').forEach((line, i) => {
          ctx.fillText(line, item.x * scale, baseline + i * lineHeight);
        });
      }
    }
  }

  /* ---------------------------------------------------------
     Liga tudo
     --------------------------------------------------------- */
  function bindToolbar() {
    const pick = (input) => input.click();

    els.open.addEventListener('click', () => pick(els.pdfInput));
    els.open2.addEventListener('click', () => pick(els.pdfInput));
    els.pdfInput.addEventListener('change', async () => {
      const file = els.pdfInput.files && els.pdfInput.files[0];
      els.pdfInput.value = '';
      if (!file) return;
      if (state.doc && !window.confirm('Substituir o PDF atual por "' + file.name + '"?')) return;
      openPdfBytes(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.pdf$/i, ''));
    });

    els.save.addEventListener('click', exportPdf);
    els.png.addEventListener('click', exportPagePng);

    els.addText.addEventListener('click', () => {
      const size = pageSize();
      addText(state.page, size.width * 0.2, size.height * 0.9);
    });
    els.del.addEventListener('click', deleteSelected);

    /* Botão "Editar texto"/"Concluir" da barra: alterna a edição do item
       de texto selecionado (inclusive o texto nativo do PDF). */
    els.edit.addEventListener('click', () => {
      if (state.editing) return stopEditing();
      const item = selectedItem();
      if (item && item.type === 'text') startEditing(item.id);
    });

    /* Liga/desliga a camada com o texto que já vem no PDF. */
    els.layer.addEventListener('click', () => {
      state.showPdfText = !state.showPdfText;
      els.layer.classList.toggle('is-on', state.showPdfText);
      els.layer.setAttribute('aria-pressed', String(state.showPdfText));
      els.overlay.classList.toggle('hide-pdf-text', !state.showPdfText);
    });

    /* Setais acima e abaixo da folha (fora do papel, no fluxo). */
    els.prevPage.addEventListener('click', () => goToPage(state.page - 1));
    els.nextPage.addEventListener('click', () => goToPage(state.page + 1));

    /* Scroll do mouse dá zoom no cursor (sem barra de rolagem no palco);
       mover a folha é arrastando o fundo, com o limite fixado nas bordas. */
    els.stage.addEventListener('wheel', (event) => {
      if (!state.pdf) return;
      event.preventDefault();
      const rect = els.stage.getBoundingClientRect();
      stepZoom(event.deltaY < 0 ? 1 : -1, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    els.font.addEventListener('change', () => patchSelected({ family: els.font.value }));
    els.size.addEventListener('change', () => {
      const value = clamp(Number(els.size.value) || 16, 4, 280);
      els.size.value = String(value);
      patchSelected({ size: value });
    });
    els.color.addEventListener('input', () => patchSelected({ color: els.color.value }, 'color'));
    els.bold.addEventListener('click', () => {
      const item = selectedItem();
      patchSelected({ bold: !(item && item.type === 'text' ? item.bold : state.defaults.bold) });
    });
    els.italic.addEventListener('click', () => {
      const item = selectedItem();
      patchSelected({ italic: !(item && item.type === 'text' ? item.italic : state.defaults.italic) });
    });

    els.zoom.addEventListener('change', () => {
      setZoom(els.zoom.value);
    });

    els.addBlank.addEventListener('click', () => addBlankPage(state.page));
    els.addImg.addEventListener('click', () => els.imgInput.click());
    els.imgInput.addEventListener('change', () => {
      /* FileList do input é "live": zerar o value esvazia a lista na hora,
         então os arquivos são copiados antes de resetar o campo. */
      const files = Array.prototype.slice.call(els.imgInput.files || []);
      els.imgInput.value = '';
      addImagesToLibrary(files, false);
    });

    document.addEventListener('keydown', (event) => {
      /* Ctrl+Z desfazer / Ctrl+Shift+Z refazer — roda ANTES do guard de
         digitação: desfazer tem que funcionar em cima do texto em edição
         também. Sem histórico, o navegador faz o undo nativo dele. */
      const k = (event.key || '').toLowerCase();
      if ((event.ctrlKey || event.metaKey) && k === 'z') {
        if (event.shiftKey) {
          if (state.redo.length) {
            event.preventDefault();
            redo();
          }
          return;
        }
        if (state.undo.length || state.editPending) {
          event.preventDefault();
          undo();
        }
        return;
      }
      if (window.MD.isTyping(document.activeElement)) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selected) {
        event.preventDefault();
        deleteSelected();
      }
      if (event.key === 'Escape') deselect();
    });
  }

  function cacheEls() {
    els.bar = $('#pe-bar');
    els.open = $('#pe-open');
    els.open2 = $('#pe-open-2');
    els.save = $('#pe-save');
    els.png = $('#pe-png');
    els.addText = $('#pe-add-text');
    els.font = $('#pe-font');
    els.size = $('#pe-size');
    els.bold = $('#pe-bold');
    els.italic = $('#pe-italic');
    els.color = $('#pe-color');
    els.del = $('#pe-del');
    els.edit = $('#pe-edit');
    els.layer = $('#pe-layer');
    els.zoom = $('#pe-zoom');
    els.stage = $('#pe-stage');
    els.empty = $('#pe-empty');
    els.pageWrap = $('#pe-page-wrap');
    els.page = $('#pe-page');
    els.prevPage = $('#pe-prev-page');
    els.nextPage = $('#pe-next-page');
    els.canvas = $('#pe-canvas');
    els.overlay = $('#pe-overlay');
    els.thumbs = $('#pe-thumbs');
    els.pageCount = $('#pe-pagecount');
    els.imgGrid = $('#pe-img-grid');
    els.imgCount = $('#pe-imgcount');
    els.layers = $('#pe-layers');
    els.layerCount = $('#pe-layercount');
    els.drawer = $('#pe-drawer');
    els.drawerToggle = $('#pe-drawer-toggle');
    els.addBlank = $('#pe-add-blank');
    els.addImg = $('#pe-add-img');
    els.pdfInput = $('#pe-pdf-input');
    els.imgInput = $('#pe-img-input');
  }

  function init() {
    if (!pdfjsLib || !PDFLib) {
      toast('As bibliotecas de PDF não carregaram. Recarregue a página.', 'error');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = window.PE_WORKER || '/vendor/pdf.worker.min.js';
    cacheEls();
    updateToolbar();
    renderImages();
    bindToolbar();
    bindStageDrag();
    bindThumbs();
    bindImageCards();
    bindLayers();
    bindDrawer();
    bindFileDrops();
    renderLayers();

    const onResize = window.MD.debounce(() => {
      if (state.pdf && state.zoom === 'fit') renderStage();
    }, 160);
    window.addEventListener('resize', onResize);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
