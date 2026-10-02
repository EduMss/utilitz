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

/**
 * Espessura da grade da tabela, em pt. Espelha o `border` das células no
 * preview (`TABLE_BORDER` em public/js/pdf.js); os dois precisam andar
 * juntos, senão a prévia mostra uma malha e o PDF outra.
 */
const TABLE_BORDER = 0.35;


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
    /* Margem de bloco ainda não aplicada (ver `margin`/`flush`). */
    this.pending = 0;
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
    this.pending = 0;
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
        lineGap: Math.max(0, lineHeight - doc.currentLineHeight(true)),
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
    let quoteDepth = 0;

    while (index < tokens.length) {
      const token = tokens[index];

      /* `doc.text` deixa `doc.x` no fim do trecho desenhado. Listas,
         tabelas e títulos reposicionam o cursor e nunca devolvem, então
         o bloco seguinte herdaria o recuo (uma tabela de 4 colunas
         empurraria o texto para o meio da página). Todo bloco volta
         para a margem esquerda, respeitando citações aninhadas. */
      if (token.type !== 'inline') doc.x = this.left(doc) + quoteDepth * 14;

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
            doc.x = this.left(doc) + quoteDepth * 14 + markerWidth;
            markerContext = { marker, hanging: markerWidth, quoteDepth };
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
          /* `ul, ol { margin-bottom: <gap> }`: o CSS colapsa com a margem
             do último `li`, então só a maior vale. */
          if (listStack.length === 0) this.margin(this.gap());
          index += 1;
          continue;

        case 'blockquote_open':
          quoteDepth += 1;
          this.flush(doc, this.gap() / 2);
          index += 1;
          continue;

        case 'blockquote_close':
          quoteDepth = Math.max(0, quoteDepth - 1);
          this.margin(this.gap() / 2);
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
            /* O preview zera a margem do último parágrafo da citação
               (`blockquote p:last-child { margin-bottom: 0 }`); sem isso
               a margem dele se somava à da própria citação. */
            const fecha = tokens[index + 1];
            const ultimoDaCitacao =
              quoteDepth > 0 &&
              fecha &&
              fecha.type === 'paragraph_close' &&
              tokens[index + 2] &&
              tokens[index + 2].type === 'blockquote_close';

            this.renderParagraph(doc, token, Object.assign({ noGap: ultimoDaCitacao }, markerContext || {}));
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
    /* Mesmo CSS do preview: h1 não ganha margem superior, h2+ ganham
       gap/3 * 1.8, e todas fecham com gap/3 * 0.7. */
    const before = level === 1 ? 0 : (this.gap() / 3) * 1.8;
    const after = (this.gap() / 3) * 0.7;

    this.flush(doc, before);

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

    this.margin(after);

    if (level === 1) {
      const ruleColor = mix(colors.accent, colors.background, 0.55);
      doc.save()
        .rect(this.left(doc), doc.y, this.contentWidth(doc), 0.9)
        .fill(ruleColor)
        .restore();
      /* h1 tem `padding-bottom: 6pt` no preview, que é o que empurra a régua
         para baixo do texto. */
      this.margin(6);
    }
  }

  renderParagraph(doc, inline, ctx = {}) {
    const { settings, colors, fonts } = this;
    const marker = ctx.marker || null;

    /* `p { margin-top: 0 }`: só a margem pendente do bloco anterior. */
    this.flush(doc, 0);
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
      this.margin(this.blockGap(ctx, marker));
      return;
    }

    /* Imagem misturada com texto: a figura vem antes do texto. */
    images.forEach((image) => this.renderImage(doc, image));

    let width = this.contentWidth(doc);
    let firstIndent = this.mmToPt(settings.firstLineIndent);

    /* Marcador de lista: desenhado fora do fluxo para as linhas seguintes
       ficarem alinhadas no mesmo recuo (hanging indent). */
    if (marker) {
      /* O `LineWrapper` do PDFKit pula de pagina sozinho quando a proxima
         linha nao cabe (pdfkit.js:4010). Como o marcador e desenhado
         antes, ele ficava orfao no fim da pagina anterior e o texto do
         item aparecia sozinho na seguinte. */
      const lineHeight = this.fontHeight(fonts.body.normal, settings.fontSize) + this.lineGap();
      if (doc.y + lineHeight > this.bottomLimit(doc)) doc.addPage();

      const hanging = ctx.hanging || 16;
      const base = this.left(doc) + (ctx.quoteDepth || 0) * 14;
      doc.font(fonts.body.normal).fontSize(settings.fontSize).fillColor(colors.text);
      doc.text(marker.text, base, doc.y, { lineBreak: false, align: 'left' });
      doc.x = base + hanging;
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
      this.margin(this.blockGap(ctx, marker));
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

    /* Item de lista recebe `li { margin: 0.6mm 0 }`, bem menor que a
       margem de parágrafo. */
    this.margin(this.blockGap(ctx, marker));
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

  /**
   * Quebra as linhas de codigo em linhas visuais que cabem em `util`.
   *
   * `lineBreak: false` nao desliga a quebra: ele so pula o calculo
   * automatico da largura (pdfkit.js:4442). Como `width` era informado,
   * o `LineWrapper` ainda era criado (pdfkit.js:4192) e cortava a linha
   * sozinho — a cauda do token descia com a entrelinha da fonte e caia
   * em cima da linha seguinte. Aqui a quebra e feita antes, e o desenho
   * acontece sem `width`, caminho que nao cria wrapper (pdfkit.js:4202).
   */
  wrapCodeRuns(doc, linhas, util, size, font) {
    doc.font(font).fontSize(size);

    const cache = new Map();
    const largura = (t) => {
      let w = cache.get(t);
      if (w === undefined) {
        w = doc.widthOfString(t);
        cache.set(t, w);
      }
      return w;
    };

    const visuais = [];
    let atual = [];
    let x = 0;
    let quebrou = false;

    linhas.forEach((runs) => {
      atual = [];
      x = 0;
      quebrou = false;

      const fechar = () => {
        visuais.push(atual);
        atual = [];
        x = 0;
        quebrou = true;
      };

      runs.forEach((run) => {
        /* `split` com grupo preserva os espacos, para poderem ser
           descartados na quebra. */
        run.text.split(/(\s+)/).forEach((parte) => {
          if (!parte) return;

          /* Espaco nunca abre linha nem fica pendurado na margem. A
             indentacao da linha de origem e preservada. */
          if (!parte.trim()) {
            if (quebrou && !atual.length) return;
            if (x + largura(parte) > util) return;
            atual.push({ text: parte, color: run.color });
            x += largura(parte);
            return;
          }

          const w = largura(parte);

          if (x + w <= util) {
            atual.push({ text: parte, color: run.color });
            x += w;
            quebrou = false;
            return;
          }

          /* Token curto vai inteiro para a proxima linha. */
          if (w <= util) {
            if (atual.length) fechar();
            atual.push({ text: parte, color: run.color });
            x = w;
            quebrou = false;
            return;
          }

          /* Token mais largo que a coluna (URL, GUID): comeca numa linha
             vazia e e cortado por caractere. */
          if (atual.length) fechar();

          let resto = parte;
          while (resto.length) {
            let n = 0;
            let soma = 0;

            /* `n` garante progresso: nem um unico caractere e infinitamente
               largo, entao o laco sempre termina. */
            while (n < resto.length) {
              const cw = largura(resto[n]);
              if (n && x + soma + cw > util) break;
              soma += cw;
              n += 1;
            }

            atual.push({ text: resto.slice(0, n), color: run.color });
            x += largura(resto.slice(0, n));
            resto = resto.slice(n);
            quebrou = false;
            if (resto) fechar();
          }
        });
      });

      visuais.push(atual);
    });

    return visuais;
  }

  renderCodeBlock(doc, content, info) {
    const { settings, colors, fonts } = this;
    const language = String(info || '').trim().split(/\s+/)[0];
    const source = highlightLines(content, language, settings.syntaxHighlight);
    const size = Math.max(6.5, settings.fontSize * 0.82);
    const lineHeight = size * 1.4;
    const padX = 8;
    const padY = 5;
    const boxWidth = this.contentWidth(doc);
    const util = boxWidth - padX * 2;
    const left = this.left(doc);

    this.flush(doc, this.gap() / 2);

    const lines = this.wrapCodeRuns(doc, source, util, size, fonts.code.normal);

    let cursor = 0;
    let guard = 0;

    while (cursor < lines.length && guard < 5000) {
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
        doc.font(fonts.code.normal).fontSize(size);
        runs.forEach((run) => {
          if (!run.text) return;
          doc.fillColor(run.color);
          /* Sem `width`: e o caminho que nao cria `LineWrapper`. A
             posicao ja foi calculada acima. */
          doc.text(run.text, x, y, { lineBreak: false, align: 'left', characterSpacing: 0 });
          x += doc.widthOfString(run.text);
        });
        y += lineHeight;
      });

      doc.y = top + boxHeight;
      cursor += chunk.length;
    }

    this.margin(this.gap() / 2);
  }

  renderRule(doc) {
    const { colors } = this;
    /* `hr { margin: <gap> * 1.4 0 }` no preview. */
    const around = this.gap() * 1.4;
    this.flush(doc, around);
    doc.save().rect(this.left(doc), doc.y, this.contentWidth(doc), 0.8).fill(colors.border).restore();
    this.margin(around);
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
    /* `th, td { padding: 3pt 4pt }` no preview. */
    const padX = 4;
    const padY = 3;
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

    /* Bordas verticais: uma por coluna, mais as duas externas. */
    const verticais = [left];
    let acumulado = left;
    finalWidths.forEach((w) => {
      acumulado += w;
      verticais.push(acumulado);
    });
    verticais[verticais.length - 1] = left + width;

    /* `table { margin: <gap>/2 0 }` no preview. */
    this.flush(doc, this.gap() / 2);

    /* Y do ultimo horizontal desenhado, para nao trancar em dobro o
       limite entre duas linhas. */
    let ultimoHorizontal = null;

    rows.forEach((r, rowIndex) => {
      const isHeader = r.cells.some((c) => c.header);
      const size = settings.fontSize * (isHeader ? 0.98 : 0.95);
      const heights = r.cells.map((cell, ci) => {
        const text = this.plainText(cell.runs);
        const cellWidth = finalWidths[ci] || width / columns;
        const util = cellWidth - padX * 2;

        /* Celula com fonte mista (negrito, codigo) quebra em um numero
           de linhas diferente conforme a fonte. Medir com a fonte mais
           larga entre as usadas nunca subestima a altura. */
        const fontes = this.cellFonts(cell, fonts.body);
        const height = Math.max.apply(
          null,
          fontes.map((font) =>
            doc
              .font(font)
              .fontSize(size)
              .heightOfString(text, { width: util, lineGap: this.lineGap(size, font) })
          )
        );

        return Math.max(size * settings.lineHeight, height) + padY * 2;
      });
      const rowHeight = Math.max.apply(null, heights);

      /* Linha mais alta que a pagina inteira nao cabe em lugar nenhum.
         Sem o limite, a borda inferior era desenhada em y ~1487 numa
         pagina de 842 e a grade saia do papel. */
      const alturaUtil = this.bottomLimit(doc) - this.geo.margins.top;
      const altura = Math.min(rowHeight, alturaUtil);

      if (doc.y + altura > this.bottomLimit(doc)) {
        doc.addPage();
        ultimoHorizontal = null;
      }

      const top = doc.y;

      if (isHeader) doc.save().rect(left, top, width, altura).fill(colors.accentSoft).restore();
      else if (rowIndex % 2 === 1) doc.save().rect(left, top, width, altura).fill(colors.stripe).restore();

      let x = left;
      r.cells.forEach((cell, ci) => {
        const cellWidth = finalWidths[ci] || width / columns;
        if (cell.runs.length) {
          const groups = this.groupRuns(cell.runs);
          const align = cell.align === 'center' ? 'center' : cell.align === 'right' ? 'right' : 'left';

          /* O cursor e posicionado uma vez so. Passar x/y em cada `text`
             reinicia `doc.y` (pdfkit.js:4439) e zera o `continuedX` apos
             cada quebra, entao um trecho em negrito no fim da celula era
             desenhado por cima do texto normal, na mesma linha. Sem
             coordenadas, os grupos fluem pelo wrapper do PDFKit, como em
             `renderParagraph`. */
          doc.x = x + padX;
          doc.y = top + padY;

          groups.forEach((group, gi) => {
            const font = this.pickFont(group, fonts.body);
            doc.font(font).fontSize(size);
            doc.fillColor(isHeader ? colors.heading : colors.text);
            doc.text(
              group.runs.map((run) => run.text).join(''),
              {
                width: cellWidth - padX * 2,
                align,
                indent: 0,
                /* Mesma entrelinha do preview: sem isso a celula saia a
                   ~1.11 em e as linhas do texto encostavam. */
                lineGap: this.lineGap(size, font),
                characterSpacing: 0,
                continued: gi < groups.length - 1,
              }
            );
          });
        }
        x += cellWidth;
      });

      /* Grade completa, como o preview: `border-collapse: collapse` com
         `border` em `th`/`td` (public/js/pdf.js:468) junta tudo numa
         malha. Sao os 4 lados da linha mais um separador por coluna. A
         cor do texto contrasta com o fundo; `borderColor` (#d4d4d8) era
         claro demais e a tabela terminava no branco. */
      doc.save().lineWidth(TABLE_BORDER).strokeColor(colors.text);

      /* O limite entre duas linhas e a base de uma e o topo da outra.
         Trancado duas vezes ficava mais escuro que o resto da malha, entao
         so o topo e desenhado quando ainda nao foi feito. */
      if (ultimoHorizontal === null || Math.abs(ultimoHorizontal - top) > 0.01) {
        doc.moveTo(left, top).lineTo(left + width, top).stroke();
      }
      doc.moveTo(left, top + altura).lineTo(left + width, top + altura).stroke();
      ultimoHorizontal = top + altura;

      verticais.forEach((bx) => {
        doc.moveTo(bx, top).lineTo(bx, top + altura).stroke();
      });
      doc.restore();

      doc.y = top + altura;
    });

    this.margin(this.gap() / 2);
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

  /** Fontes usadas por uma celula de tabela, sem repetir. */
  cellFonts(cell, family) {
    const fontes = this.groupRuns(cell.runs).map((group) => this.pickFont(group, family));
    return fontes.length ? fontes : [family.normal];
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
      /* `includeGap = true` é obrigatório: o PDFKit avança a linha com
         `currentLineHeight(true) + lineGap`. Medindo sem o gap da fonte o
         entrelinhamento saía ~13% maior que o configurado. */
      return this.measureDoc().font(font).fontSize(size).currentLineHeight(true);
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

  /**
   * Entrelinhamento entre linhas, em pt. O preview herda `line-height` do
   * container (`public/js/pdf.js:414`) em todos os blocos, então células
   * de tabela e blocos de código também precisam disso: com `lineGap: 0`
   * o texto saía a ~1.11 em em vez de 1.5 e as linhas encostavam.
   */
  lineGap(size, font) {
    const s = size || this.settings.fontSize;
    return Math.max(0, s * this.settings.lineHeight - this.fontHeight(font || this.fonts.body.normal, s));
  }

  mmToPt(value) {
    return Number(value || 0) * (72 / 25.4);
  }

  /**
   * Espaçamento entre blocos, em pontos. `paragraphSpacing` já é em pt
   * (é assim que o rótulo da tela e o CSS da prévia o usam); passar por
   * `mmToPt` inflava tudo em 2,8x. As frações reproduzem exatamente as
   * regras `#preview-pages` geradas em public/js/pdf.js.
   */
  gap() {
    return Math.max(0, Number(this.settings.paragraphSpacing) || 0);
  }

  /** Margem de lista: `li { margin: 0.6mm 0 }` no preview. */
  listItemGap() {
    return this.mmToPt(0.6);
  }

  /**
   * Margem que um bloco deixa para o seguinte. Não move o cursor: o CSS
   * colapsa margens vizinhas (fica a maior), então quem desenha decide
   * com `flush`.
   */
  margin(amount) {
    this.pending = Math.max(this.pending || 0, Math.max(0, amount || 0));
  }

  /**
   * Aplica a margem pendente antes de desenhar, colapsada com a margem
   * superior do bloco (`top`). A margem superior é ignorada no topo da
   * página, onde não há conteúdo acima para separar.
   */
  flush(doc, top) {
    const pending = this.pending || 0;
    this.pending = 0;
    const topMargin = doc.y > this.geo.margins.top + 0.01 ? top || 0 : 0;
    doc.y += Math.max(topMargin, pending);
  }

  /** Margem que um bloco deixa para o seguinte. */
  blockGap(ctx, marker) {
    if (ctx.noGap) return 0;
    return marker ? this.listItemGap() : this.gap();
  }
}

module.exports = { renderPdf, parseFrontMatter, resolveTitle };