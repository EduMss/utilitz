'use strict';

/**
 * Fontes além das 14 padrão do PDFKit.
 *
 * O PDFKit só embarca Times, Helvetica e Courier com suas quatro variações. Para
 * oferecer uma família de verdade — Roboto, Inter, Lora — é preciso baixar o
 * arquivo da fonte e registrá-la no documento. O mesmo arquivo serve para a
 * prévia no navegador, então basta uma cópia.
 *
 * O Google Fonts entrega arquivos diferentes conforme o User-Agent: para
 * navegadores atuais ele responde WOFF2, e para um agente antigo responde
 * TTF. Pedimos TTF de propósito — é o formato que o PDFKit embute sem dor de
 * cabeça, e que todo navegador aceita na prévia.
 *
 * Os arquivos ficam em data/fonts/, com um índice em index.json.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FONT_DIR = path.join(ROOT, 'data', 'fonts');
const INDEX_FILE = path.join(FONT_DIR, 'index.json');

/** Limite de download: uma fonte legítima tem poucos MB. */
const MAX_BYTES = 12 * 1024 * 1024;

/**
 * Agente deliberadamente genérico: o Google Fonts escolhe o formato da
 * resposta pelo User-Agent. Pedir com um navegador moderno devolve WOFF2; com
 * um antigo como o Safari 5 vem WOFF; e com o IE 6 vem EOT, que nenhum leitor
 * de fonte entende. Um "Mozilla/5.0" sem detalhes cai no caminho do TTF, que é
 * o formato que o PDFKit embute sem esforço e que todo navegador aceita.
 */
const LEGACY_UA = 'Mozilla/5.0';

/* ------------------------------------------------------------------ *
 * Catálogo
 * ------------------------------------------------------------------ */

/**
 * Famílias oferecidas na lista. Não baixa nada por conta própria: o arquivo só
 * é buscado quando a pessoa escolhe a fonte.
 */
const CATALOG = [
  { family: 'Inter', label: 'Inter', kind: 'sans' },
  { family: 'Roboto', label: 'Roboto', kind: 'sans' },
  { family: 'Open Sans', label: 'Open Sans', kind: 'sans' },
  { family: 'Montserrat', label: 'Montserrat', kind: 'sans' },
  { family: 'Work Sans', label: 'Work Sans', kind: 'sans' },
  { family: 'Lora', label: 'Lora', kind: 'serif' },
  { family: 'Merriweather', label: 'Merriweather', kind: 'serif' },
  { family: 'Playfair Display', label: 'Playfair Display', kind: 'serif' },
  { family: 'Crimson Pro', label: 'Crimson Pro', kind: 'serif' },
  { family: 'Source Serif 4', label: 'Source Serif 4', kind: 'serif' },
  { family: 'EB Garamond', label: 'EB Garamond', kind: 'serif' },
  { family: 'IBM Plex Sans', label: 'IBM Plex Sans', kind: 'sans' },
  { family: 'IBM Plex Serif', label: 'IBM Plex Serif', kind: 'serif' },
  { family: 'IBM Plex Mono', label: 'IBM Plex Mono', kind: 'mono' },
  { family: 'Source Code Pro', label: 'Source Code Pro', kind: 'mono' },
  { family: 'JetBrains Mono', label: 'JetBrains Mono', kind: 'mono' },
  { family: 'Fira Code', label: 'Fira Code', kind: 'mono' },
];

/** Variações pedidas ao Google Fonts, na ordem usada pelo CSS. */
const VARIANTS = [
  { key: 'normal', weight: 400, style: 'normal' },
  { key: 'bold', weight: 700, style: 'normal' },
  { key: 'italic', weight: 400, style: 'italic' },
  { key: 'boldItalic', weight: 700, style: 'italic' },
];

/** Chave estável para a fonte dentro das configurações. */
function keyFor(family) {
  return (
    'gf:' +
    String(family)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  );
}

/* ------------------------------------------------------------------ *
 * Índice em disco
 * ------------------------------------------------------------------ */

async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

async function writeIndex(index) {
  await fsp.mkdir(FONT_DIR, { recursive: true });
  await fsp.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

/** Cria a pasta na subida do servidor, para o `express.static` ter o que servir. */
function ensure() {
  fs.mkdirSync(FONT_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * Leitura do CSS do Google Fonts
 * ------------------------------------------------------------------ */

/** Blocos `@font-face` com a fonte, peso e estilo de cada um. */
function parseFaceBlocks(css) {
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/gi;
  let match;
  while ((match = re.exec(css))) {
    const body = match[1];
    const pick = (prop) => {
      const m = new RegExp(prop + '\\s*:\\s*([^;]+);', 'i').exec(body);
      return m ? m[1].trim() : '';
    };
    const src = pick('src');
    const url = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(src);
    if (!url) continue;
    faces.push({
      family: (pick('font-family') || '').replace(/^['"]|['"]$/g, ''),
      weight: (pick('font-weight') || '400').trim(),
      style: (pick('font-style') || 'normal').trim(),
      range: pick('unicode-range'),
      url: url[2].trim(),
    });
  }
  return faces;
}

/**
 * Escolhe o bloco que cobre o alfabeto latino.
 *
 * O Google Fonts divide a fonte em recortes por `unicode-range`. Sem recortar,
 * o texto em português cai no bloco errado e sai com glifos ausentes. Entre os
 * candidatos prefers o que inclui o "A" (U+0041) e, na falta dele, o primeiro.
 */
function pickLatin(blocks) {
  if (!blocks.length) return null;
  const withA = blocks.find((b) => !b.range || /U\+0*4[01]/i.test(b.range));
  return withA || blocks[0];
}

function variantOf(face) {
  const weight = parseInt(face.weight, 10) || 400;
  const italic = /italic|oblique/i.test(face.style);
  const bold = weight >= 600;
  return VARIANTS.find((v) => v.weight === (bold ? 700 : 400) && (v.style === 'italic') === italic);
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': LEGACY_UA, Accept: 'text/css,*/*' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error('Google Fonts respondeu ' + res.status);
  return res.text();
}

async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': LEGACY_UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('arquivo de fonte respondeu ' + res.status);

  const length = Number(res.headers.get('content-length') || 0);
  if (length && length > MAX_BYTES) throw new Error('arquivo de fonte grande demais');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('arquivo de fonte grande demais');
  if (buffer.length < 512) throw new Error('arquivo de fonte veio vazio');
  return buffer;
}

/** Só https, e só de hosts de fonte: nada de o usuário apontar para o disco. */
function isTrustedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const ok =
    host === 'fonts.googleapis.com' ||
    host.endsWith('.googleapis.com') ||
    host === 'fonts.gstatic.com' ||
    host.endsWith('.gstatic.com');
  return ok ? url : null;
}

/** Aceita um link do Google Fonts, uma URL de família ou só o nome dela. */
function familyUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (/^https?:\/\//i.test(text)) {
    const url = isTrustedUrl(text);
    if (!url) return null;

    if (url.hostname.toLowerCase() === 'fonts.gstatic.com') return null;

    const css2 = url.pathname.indexOf('/css2') === 0;
    const family = url.searchParams.get('family');
    if (family) {
      // Ex.: Inter:ital,wght@0,400;0,700 -> Inter:ital,wght@0,400;0,700;1,400;1,700
      const base = url.origin + '/css2?family=' + family;
      return withAllVariants(family, base, css2);
    }
    if (css2) return url.toString();
    return null;
  }

  // Só o nome da família, com ou sem as variações do CSS2.
  const clean = text.replace(/\s*:\s*.*$/, '').trim();
  if (!clean || clean.length > 60) return null;
  const spec =
    encodeURIComponent(clean).replace(/%20/g, '+') +
    ':ital,wght@0,400;0,700;1,400;1,700';
  return 'https://fonts.googleapis.com/css2?family=' + spec;
}

/**
 * Garante as quatro variações no pedido.
 *
 * Se a pessoa colou só `family=Inter`, o Google devolve uma fonte de peso 400
 * e o PDF sai sem negrito. Reescrevemos o parâmetro pedindo os quatro pares.
 */
function withAllVariants(family, base, css2) {
  const name = family.split(':')[0].trim();
  if (css2) {
    return (
      base.replace(/family=[^&]*/, '') +
      'family=' +
      encodeURIComponent(name).replace(/%20/g, '+') +
      ':ital,wght@0,400;0,700;1,400;1,700'
    );
  }
  // API v1: Family=Name:400,700,400italic,700italic
  return base.replace(/family=[^&]*/, 'family=' + name + ':400,700,400italic,700italic');
}

/* ------------------------------------------------------------------ *
 * Instalação
 * ------------------------------------------------------------------ */

/**
 * Baixa uma família e a registra no índice.
 * @param {string} input nome da família ou link do Google Fonts
 * @returns {Promise<object>} descritor da fonte instalada
 */
async function install(input) {
  const url = familyUrl(input);
  if (!url) {
    throw new Error(
      'Informe o nome da fonte (ex.: Lora) ou o link do Google Fonts. Só são aceitos endereços fonts.googleapis.com.'
    );
  }

  const css = await fetchText(url);
  const faces = parseFaceBlocks(css);
  if (!faces.length) throw new Error('O Google Fonts não devolveu nenhuma fonte para esse endereço.');

  const family = faces[0].family;
  const key = keyFor(family);

  await fsp.mkdir(FONT_DIR, { recursive: true });

  const grouped = new Map();
  for (const face of faces) {
    const variant = variantOf(face);
    if (!variant) continue;
    const bucket = grouped.get(variant.key) || [];
    bucket.push(face);
    grouped.set(variant.key, bucket);
  }

  const files = {};
  await Promise.all(
    VARIANTS.map(async (variant) => {
      const bucket = grouped.get(variant.key);
      if (!bucket || !bucket.length) return;
      const chosen = pickLatin(bucket);
      if (!chosen) return;

      const buffer = await fetchBinary(chosen.url);
      const filename = key.slice(3) + '-' + variant.key + '.ttf';
      await fsp.writeFile(path.join(FONT_DIR, filename), buffer);
      files[variant.key] = filename;
    })
  );

  if (!files.normal) throw new Error('Não consegui baixar o arquivo principal da fonte.');

  const descriptor = {
    key,
    family,
    label: family,
    source: url,
    files,
    catalog: findInCatalog(family),
  };

  const index = await readIndex();
  index[key] = descriptor;
  await writeIndex(index);

  return descriptor;
}

function findInCatalog(family) {
  const found = CATALOG.find((c) => c.family.toLowerCase() === String(family).toLowerCase());
  return found ? found.kind : null;
}

/** Lista o que já está em disco. */
async function list() {
  const index = await readIndex();
  const out = [];
  for (const [key, item] of Object.entries(index)) {
    if (!item || !item.family) continue;
    // descarta entrada cujo arquivo sumiu
    const files = item.files || {};
    const ok = Object.values(files).every((file) => fs.existsSync(path.join(FONT_DIR, file)));
    if (!Object.keys(files).length || !ok) continue;
    out.push(item);
  }
  out.sort((a, b) => a.family.localeCompare(b.family));
  return out;
}

/** Descritor de uma chave `gf:...`, ou null. */
async function get(key) {
  if (typeof key !== 'string' || key.indexOf('gf:') !== 0) return null;
  const index = await readIndex();
  const item = index[key];
  return item && item.family ? item : null;
}

/* ------------------------------------------------------------------ *
 * PDF e navegador
 * ------------------------------------------------------------------ */

/**
 * Registra as fontes no documento do PDFKit.
 *
 * `resolveFonts` devolve nomes como `gf:lora:bold`; aqui eles viram arquivos de
 * verdade. Variação ausente cai na normal, senão o negrito some e o itálico
 * vira reto sem aviso.
 */
function registerOnDoc(doc, descriptor) {
  if (!descriptor || !descriptor.files) return;
  const files = descriptor.files;
  for (const variant of VARIANTS) {
    const file = files[variant.key] || files.normal;
    if (!file) continue;
    const name = descriptor.key + ':' + variant.key;
    try {
      doc.registerFont(name, path.join(FONT_DIR, file));
    } catch (err) {
      /* variante indisponível: o chamador cai na normal */
    }
  }
}

/** Regras `@font-face` para a prévia, apontando para os arquivos do servidor. */
function faceCss(descriptor, baseUrl) {
  if (!descriptor || !descriptor.files) return '';
  const weights = { normal: 400, bold: 700, italic: 400, boldItalic: 700 };
  const styles = { normal: 'normal', bold: 'normal', italic: 'italic', boldItalic: 'italic' };

  return Object.entries(descriptor.files)
    .map(([variant, file]) => {
      return (
        '@font-face{font-family:"' +
        descriptor.family +
        '";font-style:' +
        (styles[variant] || 'normal') +
        ';font-weight:' +
        (weights[variant] || 400) +
        ';font-display:swap;src:url("' +
        baseUrl +
        file +
        '") format("truetype")}'
      );
    })
    .join('\n');
}

module.exports = {
  CATALOG,
  VARIANTS,
  FONT_DIR,
  keyFor,
  familyUrl,
  parseFaceBlocks,
  ensure,
  install,
  list,
  get,
  registerOnDoc,
  faceCss,
};