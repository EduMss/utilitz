/*
 * Ajustes e presets compartilhados entre o servidor (Node) e o navegador.
 * Este arquivo é carregado como <script> no front-end e também via
 * require() no back-end, garantindo que ambos usem exatamente os mesmos
 * valores padrão.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MDShared = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Tamanhos de página em milímetros (largura x altura). */
  var PAGE_SIZES = {
    A4: { label: 'A4', width: 210, height: 297 },
    A3: { label: 'A3', width: 297, height: 420 },
    A5: { label: 'A5', width: 148, height: 210 },
    B5: { label: 'B5', width: 176, height: 250 },
    Letter: { label: 'Carta', width: 215.9, height: 279.4 },
    Legal: { label: 'Legal', width: 215.9, height: 355.6 },
  };

  /** Famílias tipográficas disponíveis nas três rotas (A4). */
  var FONT_FAMILIES = {
    serif: { label: 'Serifada (Times)', css: "'Times New Roman', Times, Georgia, serif" },
    sans: { label: 'Sem serifa (Helvetica)', css: "Helvetica, 'Segoe UI', Arial, sans-serif" },
    mono: { label: 'Monoespaçada (Courier)', css: "'Courier New', Courier, monospace" },
  };

  var DEFAULTS = {
    /* página */
    pageSize: 'A4',
    orientation: 'portrait',
    margins: { top: 20, right: 18, bottom: 20, left: 18 },

    /* tipografia */
    fontFamily: 'serif',
    headingFontFamily: 'inherit',
    fontSize: 11,
    lineHeight: 1.6,
    letterSpacing: 0,
    textAlign: 'justify',
    firstLineIndent: 0,
    paragraphSpacing: 9,
    headingScale: 1.25,
    headingLetterSpacing: 0,

    /* cores */
    theme: 'claro',
    textColor: '#1f2328',
    headingColor: '#0b1220',
    accentColor: '#1d4ed8',
    codeColor: '#b91c1c',
    linkColor: '#1d4ed8',
    backgroundColor: '#ffffff',
    borderColor: '#d4d4d8',

    /* blocos */
    codeBackground: '#f4f4f5',
    blockquoteBackground: '#f8fafc',
    tableStripe: '#f6f7f9',

    /* imagens e elementos */
    imageMaxWidth: 100,
    figureCaption: true,
    listStyle: 'disc',
    syntaxHighlight: true,

    /* comportamento */
    pageNumbers: true,
    pageNumberPosition: 'footer-center',
    runningTitle: '',
    showToc: false,
    tocDepth: 2,
    hyphenation: false,
  };

  var POSITIONS = {
    'footer-center': { label: 'Rodapé - centro', align: 'center', v: 'footer' },
    'footer-right': { label: 'Rodapé - direita', align: 'right', v: 'footer' },
    'footer-left': { label: 'Rodapé - esquerda', align: 'left', v: 'footer' },
    'header-center': { label: 'Cabeçalho - centro', align: 'center', v: 'header' },
    'header-right': { label: 'Cabeçalho - direita', align: 'right', v: 'header' },
  };

  var THEMES = {
    claro: {
      label: 'Claro',
      textColor: '#1f2328',
      headingColor: '#0b1220',
      accentColor: '#1d4ed8',
      codeColor: '#b91c1c',
      linkColor: '#1d4ed8',
      backgroundColor: '#ffffff',
      borderColor: '#d4d4d8',
      codeBackground: '#f4f4f5',
      blockquoteBackground: '#f8fafc',
      tableStripe: '#f6f7f9',
    },
    sepia: {
      label: 'Sépia',
      textColor: '#43342a',
      headingColor: '#2b1d14',
      accentColor: '#8a5a2b',
      codeColor: '#8c3b2e',
      linkColor: '#8a5a2b',
      backgroundColor: '#f7f1e3',
      borderColor: '#d9cbb2',
      codeBackground: '#efe6d3',
      blockquoteBackground: '#f1e9d8',
      tableStripe: '#f2ead9',
    },
    noite: {
      label: 'Noite',
      textColor: '#e2e8f0',
      headingColor: '#f8fafc',
      accentColor: '#7dd3fc',
      codeColor: '#fca5a5',
      linkColor: '#7dd3fc',
      backgroundColor: '#0f172a',
      borderColor: '#334155',
      codeBackground: '#1e293b',
      blockquoteBackground: '#162033',
      tableStripe: '#172033',
    },
  };

  var LIST_STYLES = {
    disc: { label: 'Círculo', css: 'disc' },
    circle: { label: 'Círculo vazado', css: 'circle' },
    square: { label: 'Quadrado', css: 'square' },
    dash: { label: 'Traço', css: '"– "' },
    asterisk: { label: 'Asterisco', css: '"* "' },
  };

  var PRESETS = {
    artigo: {
      label: 'Artigo',
      description: 'Times 11pt, texto justificado, margens clássicas.',
      values: {
        pageSize: 'A4',
        margins: { top: 25, right: 25, bottom: 25, left: 25 },
        fontFamily: 'serif',
        headingFontFamily: 'serif',
        fontSize: 11,
        lineHeight: 1.5,
        textAlign: 'justify',
        firstLineIndent: 6,
        paragraphSpacing: 4,
        headingScale: 1.2,
        theme: 'claro',
      },
    },
    relatorio: {
      label: 'Relatório',
      description: 'Sem serifa 10.5pt, títulos destacados, sem recuo.',
      values: {
        pageSize: 'A4',
        margins: { top: 20, right: 18, bottom: 20, left: 18 },
        fontFamily: 'sans',
        headingFontFamily: 'sans',
        fontSize: 10.5,
        lineHeight: 1.45,
        textAlign: 'left',
        firstLineIndent: 0,
        paragraphSpacing: 10,
        headingScale: 1.35,
        theme: 'claro',
      },
    },
    leitura: {
      label: 'Leitura / E-book',
      description: 'Serifada 13pt, linha arejada e ritmo de leitura.',
      values: {
        pageSize: 'A5',
        margins: { top: 20, right: 16, bottom: 22, left: 16 },
        fontFamily: 'serif',
        headingFontFamily: 'sans',
        fontSize: 13,
        lineHeight: 1.75,
        textAlign: 'justify',
        firstLineIndent: 0,
        paragraphSpacing: 12,
        headingScale: 1.3,
        theme: 'claro',
      },
    },
    minimal: {
      label: 'Minimalista',
      description: 'Monoespaçada 10pt, sóbrio e sem acentos coloridos.',
      values: {
        pageSize: 'A4',
        margins: { top: 22, right: 22, bottom: 22, left: 22 },
        fontFamily: 'mono',
        headingFontFamily: 'mono',
        fontSize: 10,
        lineHeight: 1.5,
        textAlign: 'left',
        firstLineIndent: 0,
        paragraphSpacing: 12,
        headingScale: 1.15,
        syntaxHighlight: false,
        theme: 'claro',
      },
    },
    slide: {
      label: 'Slide / Apostila',
      description: 'A4 paisagem, sem serifa grande e bastante ar.',
      values: {
        pageSize: 'A4',
        orientation: 'landscape',
        margins: { top: 16, right: 16, bottom: 16, left: 16 },
        fontFamily: 'sans',
        headingFontFamily: 'sans',
        fontSize: 12,
        lineHeight: 1.4,
        textAlign: 'left',
        firstLineIndent: 0,
        paragraphSpacing: 14,
        headingScale: 1.6,
        theme: 'claro',
      },
    },
  };

  /** Aplica um preset sobre os padrões. */
  function applyPreset(name) {
    var preset = PRESETS[name] || PRESETS.artigo;
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    Object.keys(preset.values).forEach(function (key) {
      out[key] = JSON.parse(JSON.stringify(preset.values[key]));
    });
    return out;
  }

  return {
    PAGE_SIZES: PAGE_SIZES,
    FONT_FAMILIES: FONT_FAMILIES,
    DEFAULTS: DEFAULTS,
    POSITIONS: POSITIONS,
    THEMES: THEMES,
    LIST_STYLES: LIST_STYLES,
    PRESETS: PRESETS,
    applyPreset: applyPreset,
  };
});