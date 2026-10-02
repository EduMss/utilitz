'use strict';

const PDFDocument = require('pdfkit');
const fontStore = require('./fonts');
const MarkdownIt = require('markdown-it');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { normalize, geometry, palette, resolveFonts, mix } = require('./settings');
const { highlightLines } = require('./syntax');

/* Instância usada apenas para tokenizar (o HTML usa markdown.js). */
const tokenizer = new MarkdownIt({ html: true, linkify: true, typographer: true });

const HEADING_SCALE = [2.05, 1.58, 1.3, 1.14, 1.02, 0.95];
const LIST_MARKERS = {
  disc: ['•', '◦', '▪'],
  circle: ['◦', '·', '▪'],
  square: ['▪', '◦', '•'],
  dash: ['–', '‣', '·'],
  asterisk: ['*', '+', '·'],
};

const ROMAN = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function toRoman(value) {
  let remaining = Math.max(1, Math.floor(value));
  let out = '';
  ROMAN.forEach(([amount, symbol]) => {
    while (remaining >= amount) {
      out += symbol;
      remaining -= amount;
    }
  });
  return out;
}

/** Lê um bloco simples de metadados (front matter) no início do texto. */
function parseFrontMatter(source) {
  const text = String(source || '').replace(/^\uFEFF/, '');
  const match = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!match) return { meta: {}, body: text };

  const meta = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) return;
    let value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      value = new Date(value + 'T00:00:00Z').toLocaleDateString('pt-BR');
    }
    meta[kv[1].toLowerCase()] = value;
  });

  return { meta, body: text.slice(match[0].length) };
}

/** Título do documento: front matter > primeiro H1 > nome do arquivo. */
function resolveTitle(markdown, meta, fallback) {
  if (meta && meta.title) return meta.title;
  const heading = String(markdown).match(/^#\s+(.+)$/m);
  return heading ? heading[1].replace(/[*_`#]/g, '').trim() : fallback;
}

/**
 * Converte markdown em PDF respeitando as configurações do cliente.
 * @param {string} source
 * @param {object} rawSettings
 * @param {{ fallbackName?: string, metadata?: object }} options
 * @returns {Promise<Buffer>}
 */
async function renderPdf(source, rawSettings = {}, options = {}) {
  const settings = normalize(rawSettings);
  const geo = geometry(settings);
  const colors = palette(settings);
  const fonts = resolveFonts(settings, await fontStore.list());
  const { meta, body } = parseFrontMatter(source);
  const title = resolveTitle(body, meta, options.fallbackName || 'Documento');
  const tokens = tokenizer.parse(body || '', {});

  const renderer = new PdfRenderer({
    settings,
    geo,
    colors,
    fonts,
    tokens,
    title,
    meta,
    runningTitle: settings.runningTitle || title,
    imageCache: await preloadImages(tokens),
    options: options || {},
  });

  return renderer.build();
}

/* ------------------------------------------------------------------ *
 * Imagens: baixadas/ lidas antes de começar, para o renderizador
 * poder desenhar de forma síncrona.
 * ------------------------------------------------------------------ */

function collectImageSources(tokens) {
  const sources = new Set();
  const walk = (list) => {
    list.forEach((token) => {
      if (token.type === 'image') {
        const src = token.attrGet('src');
        if (src) sources.add(src);
      }
      if (token.children) walk(token.children);
    });
  };
  walk(tokens);
  return Array.from(sources);
}

async function loadImageBuffer(src) {
  if (!src) return null;

  if (/^(https?:)?\/\//i.test(src)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(src, {
        signal: controller.signal,
        headers: { accept: 'image/*' },
      });
      clearTimeout(timer);
      if (!response.ok) return null;
      const type = response.headers.get('content-type') || '';
      if (type && !/image\//.test(type)) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      return null;
    }
  }

  if (/^data:/i.test(src)) {
    try {
      const base64 = src.slice(src.indexOf(',') + 1);
      return Buffer.from(base64, 'base64');
    } catch (err) {
      return null;
    }
  }

  try {
    const file = path.resolve(String(src).replace(/^file:\/\//i, ''));
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 15 * 1024 * 1024) return null;
    return await fsp.readFile(file);
  } catch (err) {
    return null;
  }
}

/** Lê largura e altura usando o próprio leitor do PDFKit. */
function imageSize(buffer) {
  try {
    const doc = new PDFDocument({ autoFirstPage: true, bufferPages: false });
    const info = doc.openImage(buffer);
    if (!info || !info.width || !info.height) return null;
    return { width: info.width, height: info.height };
  } catch (err) {
    return null;
  }
}

async function preloadImages(tokens) {
  const sources = collectImageSources(tokens);
  const cache = {};

  await Promise.all(
    sources.map(async (src) => {
      const buffer = await loadImageBuffer(src);
      if (!buffer) return;
      const dims = imageSize(buffer);
      if (!dims) return;
      cache[src] = { buffer, width: dims.width, height: dims.height };
    })
  );

  return cache;
}

class PdfRenderer {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.headingEntries = [];
    this.headingPages = 0;
    this.imageCache = ctx.imageCache || {};
  }

  /* ================================================================ *
   * Documento
   * ================================================================ */

  build() {
    /* 1ª passagem: renderiza só o corpo para saber em que página cada
       título cai. É o que permite impressir números de página no sumário. */
    if (this.settings.showToc) {
      const probe = this.newDoc();
      this.renderBody(probe);
      this.headingPages = probe.bufferedPageRange().count;
      probe.end();
    }

    /* Documento final. */
    const doc = this.newDoc();
    this.headingEntries = [];
    if (this.settings.showToc) this.renderToc(doc);
    this.renderBody(doc);
    this.decoratePages(doc, this.runningTitle);

    return this.collect(doc);
  }

  newDoc() {
    const doc = new PDFDocument({
      size: [this.geo.widthPt, this.geo.heightPt],
      margins: {
        top: this.geo.margins.top,
        bottom: this.geo.margins.bottom,
        left: this.geo.margins.left,
        right: this.geo.margins.right,
      },
      bufferPages: true,
      autoFirstPage: true,
      lang: 'pt-BR',
    });

    /* O tema define a cor de fundo: pinta a primeira página e todas
       as que forem criadas depois. */
    const paint = () => {
      doc.rect(0, 0, this.geo.widthPt, this.geo.heightPt).fill(this.colors.background);
    };
    paint();
    doc.on('pageAdded', paint);

    /* Fontes externas precisam existir no documento antes de qualquer
       `doc.font(nome)`: o PDFKit só conhece as 14 padrão. */
    this.registerFonts(doc);

    doc.info.Title = this.title;
    doc.info.Author = this.meta.author || (this.options.metadata && this.options.metadata.author) || 'Markdown Studio';
    doc.info.Subject = this.meta.subject || 'Gerado com Markdown Studio';
    doc.info.Creator = 'Markdown Studio';
    doc.info.Producer = 'Markdown Studio';

    return doc;
  }

  collect(doc) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  /* ================================================================ *
   * Sumário
   * ================================================================ */

  renderToc(doc) {
    const { settings, colors, fonts } = this;

    doc.font(fonts.body.bold).fontSize(settings.fontSize * 1.5).fillColor(colors.heading);
    doc.text('Sumário', { align: 'left', lineGap: 2 });
    doc.moveDown(0.6);

    let lastLevel = null;
    let lastWasSub = false;

    this.headingEntries.forEach((entry) => {
      if (entry.level > settings.tocDepth) return;
      const indent = Math.max(0, entry.level - 1) * 14;
      const isSub = lastLevel !== null && entry.level > lastLevel;
      lastLevel = entry.level;

      const size = settings.fontSize * (isSub ? 0.94 : 1);
      const lineHeight = size * 1.6;
      if (doc.y + lineHeight > this.bottomLimit(doc)) doc.addPage();

      doc.x = this.left(doc) + indent;
      doc.font(entry.level <= 1 ? fonts.body.bold : fonts.body.normal)
        .fontSize(size)
        .fillColor(entry.level <= 1 ? colors.heading : colors.text);

      const prefix = isSub ? '•  ' : '';
      doc.text(prefix + entry.text, {
        width: this.contentWidth(doc) - indent,
        indent: 0,
        align: 'left',
        lineBreak: true,
        characterSpacing: 0,
        lineGap: lineHeight - doc.currentLineHeight(),
        paragraphGap: lastWasSub ? 0 : 3,
      });

      lastWasSub = isSub;
    });

    doc.addPage();
  }

  /* ================================================================ *
   * Corpo
   * ================================================================ */

  renderBody(doc) {
    const { tokens, settings, fonts } = this;
    const listStack = [];
    let index = 0;
    let markerContext = null;

    while (index < tokens.length) {
      const token = tokens[index];

      switch (token.type) {
        case 'heading_open':
          this.renderHeading(doc, tokens[index + 1], Number(token.tag.slice(1)));
          index += 3;
          continue;

        case 'paragraph_open':
          if (listStack.length) {
            const marker = this.buildMarker(listStack);
            const font = fonts.body.normal;
            const markerWidth = Math.max(
              14,
              this.measure(marker.text, font, settings.fontSize) + 8
            );
            doc.x = this.left(doc) + markerWidth;
            markerContext = { marker, hanging: markerWidth };
          } else {
            markerContext = null;
          }
          index += 1;
          continue;

        case 'paragraph_close':
          markerContext = null;
          index += 1;
          continue;

        case 'bullet_list_open':
        case 'ordered_list_open': {
          const ordered = token.type === 'ordered_list_open';
          const start = ordered ? Number(token.attrGet('start') || 1) : 1;
          listStack.push({ ordered, counter: start - 1 });
          if (listStack.length === 1) this.space(doc, this.mmToPt(this.settings.paragraphSpacing) * 0.6);
          index += 1;
          continue;
        }

        case 'list_item_open':
          if (listStack.length && listStack[listStack.length - 1].ordered) {
            listStack[listStack.length - 1].counter += 1;
          }
          index += 1;
          continue;

        case 'bullet_list_close':
        case 'ordered_list_close':
          listStack.pop();
          if (listStack.length === 0) this.space(doc, this.mmToPt(this.settings.paragraphSpacing) * 0.6);
          index += 1;
          continue;

        case 'blockquote_open':
          doc.x += 14;
          index += 1;
          continue;

        case 'blockquote_close':
          doc.x = this.left(doc);
          this.space(doc, this.mmToPt(this.settings.paragraphSpacing) * 0.5);
          index += 1;
          continue;

        case 'fence':
        case 'code_block':
          this.renderCodeBlock(doc, token.content, token.info || '');
          index += 1;
          continue;

        case 'hr':
          this.renderRule(doc);
          index += 1;
          continue;

        case 'table_open':
          index = this.renderTable(doc, tokens, index);
          continue;

        case 'html_block':
          this.renderRawHtml(doc, token.content);
          index += 1;
          continue;

        case 'inline':
          if (tokens[index - 1] && tokens[index - 1].type === 'paragraph_open') {
            this.renderParagraph(doc, token, markerContext || {});
            markerContext = null;
          }
          index += 1;
          continue;

        default:
          index += 1;
      }
    }
  }

  buildMarker(listStack) {
    const list = listStack[listStack.length - 1];
    const depth = listStack.length - 1;
    if (list.ordered) return { text: list.counter + '.', depth, width: 7 + depth * 2 };
    const markers = LIST_MARKERS[this.settings.listStyle] || LIST_MARKERS.disc;
    return { text: markers[depth % markers.length], depth, width: 7 + depth * 2 };
  }

  /* ================================================================ *
   * Blocos
   * ================================================================ */

  renderHeading(doc, inline, level) {
    const { settings, colors, fonts } = this;
    const size = settings.fontSize * HEADING_SCALE[level - 1] * settings.headingScale;
    const lineHeight = size * 1.25;
    const before = this.mmToPt(settings.paragraphSpacing) * (level === 1 ? 1.9 : 1.5);
    const after = this.mmToPt(settings.paragraphSpacing) * 0.9;

    if (doc.y > this.geo.margins.top) this.space(doc, before);

    /* Não deixa um título sozinho no fim da página. */
    if (this.bottomLimit(doc) - doc.y < lineHeight * 2.1) doc.addPage();

    if (this.settings.showToc) {
      this.headingEntries.push({ level, text: (inline.content || '').trim() });
    }

    const runs = this.inlineRuns(inline);
    const options = {
      width: this.contentWidth(doc),
      align: 'left',
      lineBreak: true,
      indent: Math.max(0, level - 1) * 5,
      characterSpacing: level <= 2 ? settings.headingLetterSpacing : 0,
      lineGap: Math.max(0, size * 0.25 - this.fontHeight(fonts.heading.bold, size)),
    };

    const groups = this.groupRuns(runs);
    groups.forEach((group, gi) => {
      doc.font(this.pickFont(group, fonts.heading));
      doc.fontSize(size).fillColor(colors.heading);
      doc.text(
        group.runs.map((run) => run.text).join(''),
        Object.assign({}, options, { continued: gi < groups.length - 1 })
      );
    });

    this.space(doc, after);

    if (level === 1) {
      const ruleColor = mix(colors.accent, colors.background, 0.55);
      doc.save()
        .rect(this.left(doc), doc.y, this.contentWidth(doc), 0.9)
        .fill(ruleColor)
        .restore();
      this.space(doc, this.mmToPt(settings.paragraphSpacing) * 0.8);
    }
  }

  renderParagraph(doc, inline, ctx = {}) {
    const { settings, colors, fonts } = this;
    const marker = ctx.marker || null;
    const images = [];
    const runs = [];

    (inline.children || []).forEach((child) => {
      if (child.type === 'image') {
        images.push(child);
        return;
      }
      if (child.type === 'softbreak' || child.type === 'hardbreak') {
        runs.push({ text: ' ' });
        return;
      }
      if (child.type === 'code_inline') {
        runs.push({ text: child.content, code: true });
        return;
      }
      if (child.type === 'text') {
        runs.push({ text: child.content });
      }
    });

    /* Parágrafo só com imagem. */
    if (images.length && !runs.length) {
      images.forEach((image) => this.renderImage(doc, image));
      this.space(doc, this.mmToPt(settings.paragraphSpacing) * 0.8);
      return;
    }

    /* Imagem misturada com texto: a figura vem antes do texto. */
    images.forEach((image) => this.renderImage(doc, image));

    let width = this.contentWidth(doc);
    let firstIndent = this.mmToPt(settings.firstLineIndent);

    /* Marcador de lista: desenhado fora do fluxo para as linhas seguintes
       ficarem alinhadas no mesmo recuo (hanging indent). */
    if (marker) {
      const hanging = ctx.hanging || 16;
      doc.font(fonts.body.normal).fontSize(settings.fontSize).fillColor(colors.text);
      doc.text(marker.text, this.left(doc), doc.y, { lineBreak: false, align: 'left' });
      doc.x = this.left(doc) + hanging;
      width -= hanging;
      firstIndent = 0;
    }

    const baseOptions = {
      width,
      align: settings.textAlign,
      lineGap: this.lineGap(),
      characterSpacing: settings.letterSpacing,
      paragraphGap: 0,
    };

    const groups = this.groupRuns(runs);
    if (!groups.length) {
      this.space(doc, this.mmToPt(settings.paragraphSpacing));
      return;
    }

    groups.forEach((group, gi) => {
      const isFirst = gi === 0;
      const isLast = gi === groups.length - 1;
      const text = group.runs.map((run) => run.text).join('');

      doc.font(this.pickFont(group, fonts.body));
      doc.fontSize(settings.fontSize);
      doc.fillColor(group.run && group.run.code ? colors.code : colors.text);

      const options = Object.assign({}, baseOptions, {
        continued: !isLast,
        indent: isFirst ? firstIndent : 0,
        underline: Boolean(group.link),
        link: group.link || undefined,
      });

      this.emitText(doc, text, options, isLast);
    });

    this.space(doc, this.mmToPt(settings.paragraphSpacing));
  }

  /**
   * Escreve texto no PDF, quebrando com hífen as palavras longas demais
   * para a linha (o PDFKit não faz hifenização de português).
   */
  emitText(doc, text, options, isFinal) {
    if (!text) return;

    if (!this.settings.hyphenation || this.settings.textAlign !== 'justify') {
      doc.text(text, options);
      return;
    }

    const width = options.width - (options.indent || 0);
    let rest = text.trim();
    let current = options;

    while (rest) {
      if (doc.widthOfString(rest) <= width) {
        doc.text(rest, Object.assign({}, current, { continued: !isFinal }));
        rest = '';
        break;
      }

      let cut = rest.lastIndexOf(' ');
      if (cut <= 0) cut = rest.length;

      let head = rest.slice(0, cut);
      while (head.length > 4 && doc.widthOfString(head + '-') > width) {
        head = head.slice(0, -1);
      }

      if (head.length <= 4) {
        doc.text(rest, Object.assign({}, current, { continued: !isFinal }));
        break;
      }

      doc.text(head + '-', Object.assign({}, current, { indent: 0, continued: true }));
      rest = rest.slice(head.length).replace(/^\s+/, '');
      current = Object.assign({}, current, { indent: 0, continued: true });
    }
  }

  renderCodeBlock(doc, content, info) {
    const { settings, colors, fonts } = this;
    const language = String(info || '').trim().split(/\s+/)[0];
    const lines = highlightLines(content, language, settings.syntaxHighlight);
    const size = Math.max(6.5, settings.fontSize * 0.82);
    const lineHeight = size * 1.4;
    const padX = 8;
    const padY = 6;
    const boxWidth = this.contentWidth(doc);
    const left = this.left(doc);

    this.space(doc, this.mmToPt(settings.paragraphSpacing) * 0.8);

    let cursor = 0;
    let guard = 0;

    while (cursor < lines.length && guard < 400) {
      guard += 1;
      const available = this.bottomLimit(doc) - doc.y - padY * 2;
      if (available < lineHeight) {
        doc.addPage();
        continue;
      }

      const perChunk = Math.max(1, Math.floor(available / lineHeight));
      const chunk = lines.slice(cursor, cursor + perChunk);
      const boxHeight = chunk.length * lineHeight + padY * 2;
      const top = doc.y;

      doc.save().rect(left, top, boxWidth, boxHeight).fill(colors.codeBackground).restore();

      let y = top + padY;
      chunk.forEach((runs) => {
        let x = left + padX;
        doc.fontSize(size).font(fonts.code.normal);
        runs.forEach((run) => {
          doc.fillColor(run.color);
          doc.text(run.text, x, y, {
            lineBreak: false,
            align: 'left',
            width: boxWidth - padX * 2,
            characterSpacing: 0,
          });
          x += doc.widthOfString(run.text) + doc.widthOfString(' ');
        });
        y += lineHeight;
      });

      doc.y = top + boxHeight;
      cursor += chunk.length;
    }

    this.space(doc, this.mmToPt(settings.paragraphSpacing) * 0.8);
  }

  renderRule(doc) {
    const { settings, colors } = this;
    this.space(doc, this.mmToPt(settings.paragraphSpacing));
    doc.save().rect(this.left(doc), doc.y, this.contentWidth(doc), 0.8).fill(colors.border).restore();
    this.space(doc, this.mmToPt(settings.paragraphSpacing));
  }

  renderRawHtml(doc, html) {
    const text = String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!text) return;

    const parts = text.split(/\n{2,}/).filter(Boolean);
    parts.forEach((part) => {
      const tokens = tokenizer.parseInline(part.replace(/\n/g, ' '));
      this.renderParagraph(doc, tokens[0] || { children: [] }, {});
    });
  }

  /* ================================================================ *
   * Tabelas
   * ================================================================ */

  renderTable(doc, tokens, start) {
    const { settings, colors, fonts } = this;
    const rows = [];
    let i = start + 1;
    let row = null;
    let cell = null;

    while (i < tokens.length && tokens[i].type !== 'table_close') {
      const token = tokens[i];
      if (token.type === 'tr_open') row = { cells: [] };
      else if (token.type === 'tr_close') {
        if (row && row.cells.length) rows.push(row);
        row = null;
      } else if (token.type === 'th_open' || token.type === 'td_open') {
        cell = { header: token.type === 'th_open', align: this.readAlign(token), runs: [] };
      } else if (token.type === 'th_close' || token.type === 'td_close') {
        if (row && cell) row.cells.push(cell);
        cell = null;
      } else if (token.type === 'inline' && cell) {
        cell.runs = this.inlineRuns(token);
      }
      i += 1;
    }

    if (!rows.length) return i + 1;

    const width = this.contentWidth(doc);
    const left = this.left(doc);
    const padX = 6;
    const padY = 5;
    const columns = Math.max.apply(null, rows.map((r) => r.cells.length));

    /* Proporção de largura a partir do conteúdo de cada coluna. */
    const weights = new Array(columns).fill(8);
    rows.forEach((r) => {
      r.cells.forEach((cell, ci) => {
        const text = this.plainText(cell.runs);
        const size = settings.fontSize * (cell.header ? 0.98 : 0.95);
        const longestWord = String(text).split(/\s+/).reduce((max, word) => Math.max(max, this.measure(word, fonts.body.normal, size)), 6);
        weights[ci] = Math.max(weights[ci], Math.min(longestWord, width * 0.3));
      });
    });

    const totalWeight = weights.reduce((a, b) => a + b, 0) || columns;
    const finalWidths = weights.map((w) => (w / totalWeight) * width);

    this.space(doc, this.mmToPt(settings.paragraphSpacing) * 0.8);

    rows.forEach((r, rowIndex) => {
      const isHeader = r.cells.some((c) => c.header);
      const size = settings.fontSize * (isHeader ? 0.98 : 0.95);
      const heights = r.cells.map((cell, ci) => {
        const text = this.plainText(cell.runs);
        const font = this.pickFontForRuns(cell.runs, fonts.body) || fonts.body.normal;
        const cellWidth = finalWidths[ci] || width / columns;
        const height = doc.font(font).fontSize(size).heightOfString(text, { width: cellWidth - padX * 2 });
        return Math.max(size * 1.6, height) + padY * 2;
      });
      const rowHeight = Math.max.apply(null, heights);

      if (doc.y + rowHeight > this.bottomLimit(doc)) doc.addPage();

      const top = doc.y;

      if (isHeader) doc.save().rect(left, top, width, rowHeight).fill(colors.accentSoft).restore();
      else if (rowIndex % 2 === 1) doc.save().rect(left, top, width, rowHeight).fill(colors.stripe).restore();

      let x = left;
      r.cells.forEach((cell, ci) => {
        const cellWidth = finalWidths[ci] || width / columns;
        if (cell.runs.length) {
          const groups = this.groupRuns(cell.runs);
          const align = cell.align === 'center' ? 'center' : cell.align === 'right' ? 'right' : 'left';
          groups.forEach((group, gi) => {
            doc.font(this.pickFont(group, fonts.body)).fontSize(size);
            doc.fillColor(isHeader ? colors.heading : colors.text);
            doc.text(
              group.runs.map((run) => run.text).join(''),
              x + padX,
              top + padY,
              {
                width: cellWidth - padX * 2,
                align,
                indent: 0,
                lineGap: 0,
                characterSpacing: 0,
                continued: gi < groups.length - 1,
              }
            );
          });
        }
        x += cellWidth;
      });

      doc.save().lineWidth(0.6).strokeColor(colors.border).moveTo(left, top).lineTo(left + width, top).stroke();
      if (isHeader) {
        doc.moveTo(left, top + rowHeight).lineTo(left + width, top + rowHeight).stroke();
      }
      doc.restore();

      doc.y = top + rowHeight;
    });

    this.space(doc, this.mmToPt(settings.paragraphSpacing));
    return i + 1;
  }

  readAlign(token) {
    const style = token.attrGet('style') || '';
    const match = style.match(/text-align:\s*(left|center|right)/);
    return match ? match[1] : 'left';
  }

  /* ================================================================ *
   * Imagens (síncronas: o markdown já traz tudo pronto)
   * ================================================================ */

  renderImage(doc, token) {
    const { settings, colors, fonts } = this;
    const src = token.attrGet('src') || '';
    const data = this.imageCache[src];

    if (!data) {
      this.renderImagePlaceholder(doc, src);
      return;
    }

    const width = this.contentWidth(doc) * (settings.imageMaxWidth / 100);
    const height = Math.min(this.geo.contentHeight * 0.7, (width * data.height) / data.width);
    const drawWidth = (height * data.width) / data.height >= width ? width : (height * data.width) / data.height;
    const drawHeight = (drawWidth * data.height) / data.width;

    if (doc.y + drawHeight > this.bottomLimit(doc)) doc.addPage();

    const top = doc.y;
    const x = this.left(doc) + (width - drawWidth) / 2;

    try {
      doc.image(data.buffer, x, top, { width: drawWidth });
    } catch (err) {
      this.renderImagePlaceholder(doc, src);
      return;
    }

    doc.y = top + drawHeight + 2;

    const caption = token.attrGet('title') || '';
    if (settings.figureCaption && caption) {
      doc.font(fonts.body.italic)
        .fontSize(settings.fontSize * 0.82)
        .fillColor(colors.muted)
        .text(caption, {
          width: this.contentWidth(doc),
          align: 'center',
          lineBreak: true,
          lineGap: 2,
        });
    }
  }

  renderImagePlaceholder(doc, src) {
    const { settings, colors, fonts } = this;
    const width = this.contentWidth(doc);
    const height = 26;
    const top = doc.y;

    doc.save()
      .dash(3, { space: 2 })
      .lineWidth(0.8)
      .strokeColor(colors.border)
      .rect(this.left(doc), top, width, height)
      .fillAndStroke(colors.codeBackground, colors.border)
      .undash()
      .restore();

    doc.font(fonts.body.italic)
      .fontSize(settings.fontSize * 0.82)
      .fillColor(colors.muted)
      .text('imagem indisponível: ' + String(src).slice(0, 70), this.left(doc) + 8, top + 9, {
        width: width - 16,
        lineBreak: false,
        align: 'left',
      });

    doc.y = top + height;
  }

  /* ================================================================ *
   * Cabeçalho / rodapé / numeração
   * ================================================================ */

  decoratePages(doc, title) {
    const { settings, colors, fonts } = this;
    const onFooter = String(settings.pageNumberPosition).indexOf('footer') === 0;
    const align = String(settings.pageNumberPosition).split('-')[1] || 'center';

    const range = doc.bufferedPageRange();
    const total = range.count;
    const size = Math.max(6, settings.fontSize - 2.4);
    const left = this.geo.margins.left;
    const width = this.geo.widthPt - this.geo.margins.left - this.geo.margins.right;

    const headerY = Math.max(12, this.geo.margins.top - 18);
    const footerY = this.geo.heightPt - this.geo.margins.bottom + 14;

    for (let i = range.start; i < range.start + total; i += 1) {
      doc.switchToPage(i);
      this.drawFurniture(doc, this.pageNumberText(i - range.start + 1, total), headerY, footerY, onFooter, align, fonts, size);
      if (title) {
        const text = String(title).slice(0, 100);
        if (onFooter) {
          this.drawFurniture(doc, text, headerY, footerY, onFooter, 'left', fonts, size, 'italic');
        } else if (i - range.start + 1 !== 1) {
          this.drawFurniture(doc, text, headerY, footerY, onFooter, 'right', fonts, size, 'bold');
        }
      }
    }

    doc.flushPages();
  }

  /**
   * Desenha um texto curto na margem (cabeçalho/rodapé).
   * Sem `width` de propósito: é isso que impede o PDFKit de criar uma
   * página em branco ao escrever abaixo da margem inferior.
   */
  drawFurniture(doc, text, headerY, footerY, onFooter, align, fonts, size, style) {
    if (!text) return;
    const left = this.geo.margins.left;
    const width = this.geo.widthPt - this.geo.margins.left - this.geo.margins.right;
    const y = onFooter ? footerY : headerY;

    const family = style === 'italic' ? fonts.body.italic : style === 'bold' ? fonts.body.bold : fonts.body.normal;
    const color = style === 'bold' ? this.colors.heading : this.colors.muted;

    doc.font(family).fontSize(size).fillColor(color);

    const textWidth = doc.widthOfString(text);
    let x = left;
    if (align === 'center') x = left + (width - textWidth) / 2;
    else if (align === 'right') x = left + width - textWidth;

    const keepX = doc.x;
    const keepY = doc.y;
    doc.text(text, x, y, { lineBreak: false, align: 'left' });
    doc.x = keepX;
    doc.y = keepY;
  }

  pageNumberText(pageNumber, total) {
    const format = this.settings.pageNumberFormat;
    if (format === 'roman') return toRoman(pageNumber);
    if (format === 'arabic-total') return pageNumber + ' / ' + total;
    return String(pageNumber);
  }

  /* ================================================================ *
   * Texto inline
   * ================================================================ */

  inlineRuns(inline) {
    const runs = [];
    const state = { bold: false, italic: false, strike: false, link: null };

    (inline.children || []).forEach((child) => {
      switch (child.type) {
        case 'strong_open': state.bold = true; break;
        case 'strong_close': state.bold = false; break;
        case 'em_open': state.italic = true; break;
        case 'em_close': state.italic = false; break;
        case 's_open': state.strike = true; break;
        case 's_close': state.strike = false; break;
        case 'link_open': state.link = child.attrGet('href'); break;
        case 'link_close': state.link = null; break;
        case 'code_inline':
          runs.push({ text: child.content, code: true, bold: state.bold, italic: state.italic });
          break;
        case 'softbreak':
        case 'hardbreak':
          runs.push({ text: ' ' });
          break;
        case 'text':
          if (child.content) {
            runs.push({
              text: child.content,
              bold: state.bold,
              italic: state.italic,
              strike: state.strike,
              link: state.link,
            });
          }
          break;
        default:
          if (child.content && child.type !== 'image') {
            runs.push({ text: child.content, bold: state.bold, italic: state.italic, link: state.link });
          }
      }
    });

    return runs;
  }

  /** Agrupa trechos com o mesmo estilo (evita chamadas de texto demais). */
  groupRuns(runs) {
    const groups = [];
    runs.forEach((run) => {
      const key = [run.bold ? 'b' : '', run.italic ? 'i' : '', run.code ? 'c' : '', run.link || ''].join('|');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.runs.push(run);
      else groups.push({ key, runs: [run], run, link: run.link || null });
    });
    return groups;
  }

  pickFont(group, family) {
    const run = group.runs[0] || {};
    if (run.code) return this.fonts.code.normal;
    if (run.bold && run.italic) return family.boldItalic;
    if (run.bold) return family.bold;
    if (run.italic) return family.italic;
    return family.normal;
  }

  pickFontForRuns(runs, family) {
    return this.pickFont({ runs: [runs[0] || {}] }, family);
  }

  plainText(runs) {
    return runs.map((run) => run.text).join('');
  }

  /* ================================================================ *
   * Medidas e geometria
   * ================================================================ */

  measureDoc() {
    if (!this._measureDoc) {
      this._measureDoc = new PDFDocument({
        size: [this.geo.widthPt, this.geo.heightPt],
        autoFirstPage: true,
        bufferPages: false,
      });
      this.registerFonts(this._measureDoc);
    }
    return this._measureDoc;
  }

  /** Deixa as fontes externas disponíveis por nome neste documento. */
  registerFonts(doc) {
    if (!doc || !this.fonts) return;
    const registry = this.fonts.registry instanceof Map ? this.fonts.registry : new Map();
    for (const descriptor of registry.values()) {
      fontStore.registerOnDoc(doc, descriptor);
    }
  }

  measure(text, font, size) {
    try {
      return this.measureDoc().font(font).fontSize(size).widthOfString(String(text));
    } catch (err) {
      return String(text).length * size * 0.5;
    }
  }

  fontHeight(font, size) {
    try {
      return this.measureDoc().font(font).fontSize(size).currentLineHeight();
    } catch (err) {
      return size * 1.15;
    }
  }

  left(doc) {
    return doc.page.margins.left;
  }

  contentWidth(doc) {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  bottomLimit(doc) {
    return doc.page.height - doc.page.margins.bottom;
  }

  lineGap() {
    const size = this.settings.fontSize;
    return Math.max(0, size * this.settings.lineHeight - this.fontHeight(this.fonts.body.normal, size));
  }

  mmToPt(value) {
    return Number(value || 0) * (72 / 25.4);
  }

  space(doc, amount) {
    doc.y += Math.max(0, amount || 0);
  }
}

module.exports = { renderPdf, parseFrontMatter, resolveTitle };