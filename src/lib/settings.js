'use strict';

const shared = require('../../public/js/shared-settings.js');

const DEFAULTS = shared.DEFAULTS;
const PAGE_SIZES = shared.PAGE_SIZES;

/** Converte milímetros em pontos (1 mm = 2,834645 pt). */
const mm = (value) => (Number(value) || 0) * (72 / 25.4);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function num(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function str(value, allowed, fallback) {
  return allowed && allowed.indexOf(value) !== -1 ? value : fallback;
}

function hex(value, fallback) {
  const cleaned = String(value || '').trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(cleaned) ? cleaned.toLowerCase() : fallback;
}

/**
 * Aceita uma chave de fonte: as três do PDFKit (`serif`, `sans`, `mono`), o
 * `inherit` dos títulos ou uma fonte externa instalada (`gf:lora`).
 *
 * A chave externa é validada só pelo formato aqui. Se o arquivo tiver sumido,
 * `resolveFonts` cai na família do mesmo gênero — um documento nunca sai sem
 * fonte por causa de uma chave velha no rascunho salvo.
 */
function fontKey(value, fallback) {
  const cleaned = String(value == null ? '' : value).trim();
  if (cleaned === 'inherit') return 'inherit';
  if (Object.prototype.hasOwnProperty.call(shared.FONT_FAMILIES, cleaned)) return cleaned;
  if (/^gf:[a-z0-9]+(-[a-z0-9]+)*$/.test(cleaned)) return cleaned;
  return fallback;
}

/** Converte "#rrggbb" em [r, g, b]. */
function toRgb(color) {
  let value = String(color).replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/** Mistura duas cores (weight = peso da primeira, de 0 a 1). */
function mix(a, b, weight) {
  const ca = toRgb(a);
  const cb = toRgb(b);
  const w = clamp(weight, 0, 1);
  const channel = (i) => Math.round(ca[i] * w + cb[i] * (1 - w));
  return '#' + [channel(0), channel(1), channel(2)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Recebe as configurações vindas do navegador (não confiável) e devolve um
 * objeto completo, com limites respeitados.
 */
function normalize(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const themeName = str(input.theme, Object.keys(shared.THEMES), DEFAULTS.theme);
  const theme = shared.THEMES[themeName];

  const settings = {
    /* página */
    pageSize: str(input.pageSize, Object.keys(PAGE_SIZES), DEFAULTS.pageSize),
    orientation: str(input.orientation, ['portrait', 'landscape'], DEFAULTS.orientation),
    margins: {
      top: num(input.margins && input.margins.top, 5, 80, DEFAULTS.margins.top),
      right: num(input.margins && input.margins.right, 5, 80, DEFAULTS.margins.right),
      bottom: num(input.margins && input.margins.bottom, 5, 80, DEFAULTS.margins.bottom),
      left: num(input.margins && input.margins.left, 5, 80, DEFAULTS.margins.left),
    },

    /* tipografia */
    fontFamily: fontKey(input.fontFamily, DEFAULTS.fontFamily),
    headingFontFamily: fontKey(input.headingFontFamily, DEFAULTS.headingFontFamily),
    fontSize: num(input.fontSize, 6, 28, DEFAULTS.fontSize),
    lineHeight: num(input.lineHeight, 1, 3, DEFAULTS.lineHeight),
    letterSpacing: num(input.letterSpacing, -0.5, 3, DEFAULTS.letterSpacing),
    textAlign: str(input.textAlign, ['left', 'justify', 'center', 'right'], DEFAULTS.textAlign),
    firstLineIndent: num(input.firstLineIndent, 0, 40, DEFAULTS.firstLineIndent),
    paragraphSpacing: num(input.paragraphSpacing, 0, 60, DEFAULTS.paragraphSpacing),
    headingScale: num(input.headingScale, 0.8, 2.5, DEFAULTS.headingScale),
    headingLetterSpacing: num(input.headingLetterSpacing, -1, 4, DEFAULTS.headingLetterSpacing),

    /* cores (partem do tema, mas podem ser sobrescritas) */
    theme: themeName,
    textColor: hex(input.textColor, theme.textColor),
    headingColor: hex(input.headingColor, theme.headingColor),
    accentColor: hex(input.accentColor, theme.accentColor),
    codeColor: hex(input.codeColor, theme.codeColor),
    linkColor: hex(input.linkColor, theme.linkColor),
    backgroundColor: hex(input.backgroundColor, theme.backgroundColor),
    borderColor: hex(input.borderColor, theme.borderColor),
    codeBackground: hex(input.codeBackground, theme.codeBackground),
    blockquoteBackground: hex(input.blockquoteBackground, theme.blockquoteBackground),
    tableStripe: hex(input.tableStripe, theme.tableStripe),

    /* blocos */
    imageMaxWidth: num(input.imageMaxWidth, 20, 100, DEFAULTS.imageMaxWidth),
    figureCaption: input.figureCaption === false ? false : DEFAULTS.figureCaption,
    listStyle: str(input.listStyle, Object.keys(shared.LIST_STYLES), DEFAULTS.listStyle),
    syntaxHighlight: input.syntaxHighlight === false ? false : DEFAULTS.syntaxHighlight,
    hyphenation: input.hyphenation === true,

    /* comportamento */
    pageNumbers: input.pageNumbers === false ? false : DEFAULTS.pageNumbers,
    pageNumberPosition: str(
      input.pageNumberPosition,
      Object.keys(shared.POSITIONS),
      DEFAULTS.pageNumberPosition
    ),
    pageNumberFormat: str(
      input.pageNumberFormat,
      ['arabic', 'arabic-total', 'roman'],
      DEFAULTS.pageNumberFormat
    ),
    runningTitle: typeof input.runningTitle === 'string' ? input.runningTitle.slice(0, 120) : DEFAULTS.runningTitle,
    showToc: input.showToc === true,
    tocDepth: num(input.tocDepth, 1, 6, DEFAULTS.tocDepth),
  };

  /* Aplica a cor do tema em campos que o cliente não enviado. */
  if (input.theme && input.textColor === undefined) settings.textColor = theme.textColor;

  return settings;
}

/** Famílias de fontes padrão do PDF (sem incorporate de arquivos). */
const FONT_SETS = {
  serif: {
    normal: 'Times-Roman',
    bold: 'Times-Bold',
    italic: 'Times-Italic',
    boldItalic: 'Times-BoldItalic',
  },
  sans: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italic: 'Helvetica-Oblique',
    boldItalic: 'Helvetica-BoldOblique',
  },
  mono: {
    normal: 'Courier',
    bold: 'Courier-Bold',
    italic: 'Courier-Oblique',
    boldItalic: 'Courier-BoldItalic',
  },
};

const CODE_FONTS = FONT_SETS.mono;

/** Ordem com que o gerenciador de fontes devolve as famílias. */
const FAMILY_KEYS = ['serif', 'sans', 'mono'];

/** Índice por chave de fonte externa: `gf:lora` -> descritor. */
function registryMap(installed) {
  const map = new Map();
  const list = Array.isArray(installed) ? installed : [];
  for (const item of list) {
    if (item && typeof item.key === 'string' && item.key.indexOf('gf:') === 0) {
      map.set(item.key, item);
    }
  }
  return map;
}

/**
 * Nomes das quatro variações de uma chave de fonte.
 *
 * Para fonte externa o nome é `gf:lora:bold` e precisa estar registrado no
 * documento antes do desenho — é o que `registerOnDoc` faz. Chave que não
 * está no registro cai na família do mesmo gênero, para não devolver um nome
 * que o PDFKit não conhece e derrubar o documento inteiro.
 */
function variantsFor(key, registry) {
  if (Object.prototype.hasOwnProperty.call(FONT_SETS, key)) return FONT_SETS[key];

  if (key.indexOf('gf:') === 0) {
    const found = registry.get(key);
    if (found) {
      return {
        normal: key + ':normal',
        bold: key + ':bold',
        italic: key + ':italic',
        boldItalic: key + ':boldItalic',
      };
    }
    const kind = FAMILY_KEYS.includes(key.slice(3)) ? key.slice(3) : 'serif';
    return FONT_SETS[kind];
  }

  return FONT_SETS.serif;
}

/**
 * Conjuntos de fontes do documento: corpo, títulos e código.
 * @param {object} settings ajustes já normalizados
 * @param {Array<object>} installed descritores das fontes externas em disco
 */
function resolveFonts(settings, installed) {
  const registry = registryMap(installed);

  const body = variantsFor(settings.fontFamily, registry);
  const headingFamily =
    settings.headingFontFamily === 'inherit'
      ? settings.fontFamily
      : settings.headingFontFamily;
  const heading = headingFamily === 'inherit' ? body : variantsFor(headingFamily, registry);

  /* Código precisa de proporção fixa. Quando a pessoa escolhe uma
     monoespaçada externa para o texto, ela vale para os blocos também;
     nas demais situações fica o Courier, que todo mundo tem. */
  const chosen = registry.get(settings.fontFamily);
  const code = chosen && chosen.catalog === 'mono' ? body : CODE_FONTS;

  return { body, heading, code, registry };
}

/** Descrição geométrica da página em pontos. */
function geometry(settings) {
  const size = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.A4;
  const landscape = settings.orientation === 'landscape';
  const widthPt = mm(landscape ? size.height : size.width);
  const heightPt = mm(landscape ? size.width : size.height);
  const margins = {
    top: mm(settings.margins.top),
    right: mm(settings.margins.right),
    bottom: mm(settings.margins.bottom),
    left: mm(settings.margins.left),
  };
  return {
    widthPt,
    heightPt,
    margins,
    contentWidth: widthPt - margins.left - margins.right,
    contentHeight: heightPt - margins.top - margins.bottom,
    size,
    landscape,
  };
}

/** Paleta final, já com as misturas derivadas. */
function palette(settings) {
  return {
    text: settings.textColor,
    heading: settings.headingColor,
    accent: settings.accentColor,
    code: settings.codeColor,
    link: settings.linkColor,
    background: settings.backgroundColor,
    border: settings.borderColor,
    codeBackground: settings.codeBackground,
    quoteBackground: settings.blockquoteBackground,
    stripe: settings.tableStripe,
    muted: mix(settings.textColor, settings.backgroundColor, 0.45),
    accentSoft: mix(settings.accentColor, settings.backgroundColor, 0.14),
    quoteBar: mix(settings.accentColor, settings.backgroundColor, 0.65),
  };
}

/** Gera um nome de arquivo seguro a partir do título do documento. */
function slugFilename(title, fallback = 'documento') {
  const base = String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return base || fallback;
}

module.exports = {
  shared,
  DEFAULTS,
  normalize,
  geometry,
  palette,
  resolveFonts,
  mix,
  toRgb,
  mm,
  slugFilename,
};