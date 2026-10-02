'use strict';

const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/common');

/**
 * Configuração única do markdown-it. Usada tanto pela visualização em tela
 * quanto pelo gerador de PDF, para que o HTML e o PDF fiquem idênticos.
 */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: true,
  // mesmo com o higienizador no final, links perigosos não viram <a>
  validateLink(url) {
    const compact = String(url || '').replace(/[\u0000-\u0020\u007f-\u00a0]/g, '').toLowerCase();
    if (/^(javascript|vbscript|data):/.test(compact)) {
      return /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/.test(compact);
    }
    return true;
  },
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    try {
      return (
        '<pre class="md-pre"><code class="hljs language-' +
        escapeAttr(language) +
        '">' +
        hljs.highlight(code, { language, ignoreIllegals: true }).value +
        '</code></pre>'
      );
    } catch (err) {
      return '<pre class="md-pre"><code class="hljs">' + md.utils.escapeHtml(code) + '</code></pre>';
    }
  },
});

/* ------------------------------------------------------------------ *
 * Regras extras de renderização
 * ------------------------------------------------------------------ */

/** Converte um título em um slug seguro para âncoras. */
function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64) || 'secao';
}

function escapeAttr(value) {
  return String(value).replace(/"/g, '&quot;');
}

/** Gera âncoras nos títulos para links internos. */
md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const level = Number(String(token.tag).slice(1)) || 1;
  const inline = tokens[idx + 1];
  const base = inline && inline.type === 'inline' ? slugify(inline.content) : 'secao';

  // âncoras únicas mesmo com títulos repetidos
  const used = env.headings || (env.headings = []);
  let id = base;
  let n = 2;
  while (used.some((h) => h.id === id)) id = base + '-' + n++;

  used.push({ level, text: inline ? inline.content : '', id });
  token.attrSet('id', id);
  return self.renderToken(tokens, idx, options);
};

/** Links externos abrem em nova aba. */
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const href = tokens[idx].attrGet('href') || '';
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, idx, options);
};

/** Imagens responsivas e com carregamento adiado. */
md.renderer.rules.image = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const src = token.attrGet('src') || '';
  const alt = token.content ? md.utils.escapeHtml(token.content) : '';
  const title = token.attrGet('title');
  return (
    '<img class="md-img" src="' +
    escapeAttr(src) +
    '" alt="' +
    alt +
    '"' +
    (title ? ' title="' + escapeAttr(title) + '"' : '') +
    ' loading="lazy">'
  );
};

/** Tabelas ganham wrapper para permitir rolagem horizontal no celular. */
md.renderer.rules.table_open = function () {
  return '<div class="md-table-wrap"><table>';
};
md.renderer.rules.table_close = function () {
  return '</table></div>';
};

/** Remove o wrapper padrão do p-level em itens de lista (CSS cuida do recuo). */
const defaultParagraphOpen =
  md.renderer.rules.paragraph_open ||
  function (tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };

md.renderer.rules.paragraph_open = function (tokens, idx, options, env, self) {
  const parent = tokens[idx - 1] ? tokens[idx - 1].type : '';
  const inList = parent === 'list_item_open' || parent === 'blockquote_open';
  return inList ? '' : defaultParagraphOpen(tokens, idx, options, env, self);
};

/* ------------------------------------------------------------------ *
 * Higienização do HTML
 *
 * O markdown aceita HTML bruto (html:true), então o resultado precisa ser
 * higienizado antes de ir para o navegador.
 * ------------------------------------------------------------------ */

/** Tags cujas tags e conteúdo são descartados por inteiro. */
const VOIDED_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'applet', 'form', 'noscript', 'template'];

/** Tags cujo conteúdo é preservado, mas a tag em si é removida. */
const UNWRAP_TAGS = ['html', 'head', 'body', 'link', 'meta', 'base', 'title', 'font', 'marquee'];

/** Atributos que podem carregar URLs perigosas. */
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'data', 'poster', 'background', 'xlink:href', 'srcset'];

// svg+xml fica de fora de propósito: um SVG embutido pode carregar script.
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$/i;

function isSafeUrl(value, tagName) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  // remove espaços/bytes de controle para barrar "java\tscript:"
  const compact = raw.replace(/[\u0000-\u0020\u007f-\u00a0]/g, '').toLowerCase();

  // qualquer data: precisa passar pela lista de imagens permitidas
  if (compact.startsWith('data:')) {
    return tagName === 'img' && SAFE_DATA_IMAGE.test(compact);
  }

  return !/^(javascript|vbscript):/.test(compact);
}

function sanitizeHtml(html) {
  let out = String(html);

  // 1. remove blocos perigosos (tag + conteúdo), incluindo variantes com barra
  for (const tag of VOIDED_TAGS) {
    out = out.replace(new RegExp('<' + tag + '(?:\\s[^>]*)?>[\\s\\S]*?<\\/' + tag + '\\s*>', 'gi'), '');
    out = out.replace(new RegExp('<' + tag + '(?:\\s[^>]*)?\\/?>', 'gi'), '');
  }

  // 2. remove handlers inline e atributos de URL perigosos
  out = out.replace(/<([a-z][a-z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/gi, (match, tag, attrs, slash) => {
    let clean = attrs.replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

    for (const name of URL_ATTRS) {
      const re = new RegExp('(\\s' + name + '\\s*=\\s*)("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'gi');
      clean = clean.replace(re, (m, prefix, _all, dq, sq, bare) => {
        const value = dq !== undefined ? dq : sq !== undefined ? sq : bare || '';
        if (isSafeUrl(value, tag.toLowerCase())) return m;
        return prefix + '""';
      });
    }
    return '<' + tag + clean + slash + '>';
  });

  // 3. remove tags soltas que só adicionam risco, preservando o texto interno
  for (const tag of UNWRAP_TAGS) {
    out = out.replace(new RegExp('</?' + tag + '(?:\\s[^>]*)?\\/?>', 'gi'), '');
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * API pública
 * ------------------------------------------------------------------ */

/**
 * Renderiza markdown em HTML.
 * @param {string} source
 * @param {{ headings?: boolean }} opts quando headings:true devolve {html, headings}
 */
function render(source, opts = {}) {
  const env = {};
  const html = sanitizeHtml(md.render(String(source || ''), env));
  if (opts.headings) return { html, headings: env.headings || [] };
  return html;
}

/** Extrai apenas a lista de títulos (sumário). */
function headings(source) {
  // precisa renderizar: a lista é montada pela regra `heading_open`.
  const env = {};
  md.render(String(source || ''), env);
  return env.headings || [];
}

/** Conta palavras e blocos, usado no status bar do front-end. */
function stats(source) {
  const text = String(source || '');
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const found = headings(text);
  return {
    words,
    characters: text.length,
    headings: found.length,
    readingTime: Math.max(1, Math.round(words / 200)),
  };
}

module.exports = { render, headings, stats, slugify, sanitizeHtml };