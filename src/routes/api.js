'use strict';

const express = require('express');

const { render, stats } = require('../lib/markdown');
const { renderPdf } = require('../lib/pdf');
const chrome = require('../lib/chrome');
const { shared, normalize, slugFilename } = require('../lib/settings');
const { store } = require('../lib/library');
const fonts = require('../lib/fonts');

const router = express.Router();

/** Acrescenta as regras `@font-face` que a prévia precisa. */
function withFaces(descriptor) {
  return Object.assign({}, descriptor, { faces: fonts.faceCss(descriptor, '/fonts/') });
}

/* ------------------------------------------------------------------ *
 * Markdown -> HTML
 * ------------------------------------------------------------------ */
router.post('/render', (req, res) => {
  const markdown = String((req.body && req.body.markdown) || '');
  const sourceMap = !!(req.body && req.body.sourceMap);
  const result = render(markdown, { headings: true, sourceMap });
  res.json({ html: result.html, headings: result.headings, stats: stats(markdown) });
});

/** Só as estatísticas, para a barra de status (resposta leve). */
router.post('/stats', (req, res) => {
  const markdown = String((req.body && req.body.markdown) || '');
  res.json(stats(markdown));
});

/* ------------------------------------------------------------------ *
 * Markdown -> PDF
 * ------------------------------------------------------------------ */
router.post('/pdf', async (req, res, next) => {
  try {
    const body = req.body || {};
    const markdown = String(body.markdown || '');
    const settings = normalize(body.settings || {});
    const filename = slugFilename(body.title || settings.runningTitle, 'documento');

    const options = {
      fallbackName: body.title || 'documento',
      metadata: body.metadata,
    };

    /* `USER_CHROME` liga o renderizador do Chrome. Sem Chrome instalado, ou
       se ele falhar, o PDF sai pelo gerador atual (PDFKit) em vez de virar
       erro na tela. */
    let buffer;
    let engine = 'pdfkit';
    if (chrome.chromeEnabled()) {
      if (chrome.resolveChrome()) {
        try {
          buffer = await chrome.renderPdf(markdown, body.settings || {}, options);
          engine = 'chrome';
        } catch (err) {
          console.warn('[pdf] falha no Chrome, voltando para o PDFKit:', err.message);
        }
      } else {
        console.warn('[pdf] USER_CHROME ativo, mas nenhum Chrome/Chromium foi encontrado; usando o PDFKit.');
      }
    }

    if (!buffer) {
      buffer = await renderPdf(markdown, body.settings || {}, options);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Pdf-Engine', engine);
    res.setHeader(
      'Content-Disposition',
      (body.inline ? 'inline' : 'attachment') + '; filename="' + filename + '.pdf"'
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(buffer);
  } catch (err) {
    next(err);
  }
});

/** Configurações e presets disponíveis (fonte única de verdade). */
router.get('/settings', (req, res) => {
  res.json({
    defaults: shared.DEFAULTS,
    presets: shared.PRESETS,
    themes: shared.THEMES,
    pageSizes: shared.PAGE_SIZES,
    fontFamilies: shared.FONT_FAMILIES,
    listStyles: shared.LIST_STYLES,
    positions: shared.POSITIONS,
  });
});

/* ------------------------------------------------------------------ *
 * Biblioteca de documentos
 * ------------------------------------------------------------------ */
router.get('/library', (req, res) => {
  res.json(store.list());
});

router.get('/library/:id', (req, res) => {
  const item = store.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Documento não encontrado' });
  return res.json(item);
});

router.post('/library', async (req, res, next) => {
  try {
    const body = req.body || {};
    const saved = await store.save({
      title: body.title,
      content: body.content == null ? body.markdown : body.content,
      kind: body.kind,
      settings: body.settings,
    });
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

router.delete('/library/:id', async (req, res, next) => {
  try {
    const removed = await store.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Documento não encontrado' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------------------------------------------ *
 * Fontes externas (Google Fonts)
 * ------------------------------------------------------------------ */

/**
 * Catálogo do que é oferecido e o que já está baixado.
 *
 * O catálogo é só uma lista de nomes: nada é baixado até a pessoa escolher.
 * Cada descritor vem com `faces`, as regras `@font-face` para a prévia — montadas
 * aqui para o servidor ser o único lugar com essa lógica.
 */
router.get('/fonts', async (req, res, next) => {
  try {
    const installed = await fonts.list();
    res.json({
      catalog: fonts.CATALOG,
      installed: installed.map((item) => withFaces(item)),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Baixa uma família e passa a oferecer na lista.
 *
 * Aceita o nome da família (`Lora`) ou o link do Google Fonts. Responde 400 com
 * uma frase em português quando o endereço não serve — a mensagem vai direto
 * para a tela, então ela precisa ser útil e não um stack trace.
 */
router.post('/fonts', async (req, res) => {
  const body = req.body || {};
  const asked = String(body.url || body.family || body.name || '').trim();
  if (!asked) {
    return res.status(400).json({
      error: 'Informe o nome da fonte (ex.: Lora) ou o link do Google Fonts.',
    });
  }

  try {
    const descriptor = await fonts.install(asked);
    return res.status(201).json(withFaces(descriptor));
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Não consegui baixar essa fonte.' });
  }
});

module.exports = router;