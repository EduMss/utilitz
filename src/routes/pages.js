'use strict';

const express = require('express');

const { home } = require('../views/home');
const { viewer } = require('../views/viewer');
const { pdf } = require('../views/pdf');
const { images } = require('../views/images');
const { format } = require('../views/format');
const { logs } = require('../views/logs');
const { notas } = require('../views/notas');
const { drive } = require('../views/drive');
const { salas } = require('../lib/salas');
const { htmlpdf } = require('../views/htmlpdf');
const { pdfedit } = require('../views/pdfedit');

const router = express.Router();

/**
 * As páginas são montadas a cada visita e carregam scripts versionados por
 * mtime. Cachear o HTML deixaria a pessoa presa a um retrato antigo da página
 * — com botões que o JS carregado não conhece mais.
 */
function page(res, html) {
  res.set('Cache-Control', 'no-cache');
  return res.type('html').send(html);
}

router.get('/', (req, res) => {
  page(res, home());
});

router.get('/visualizar', (req, res) => {
  page(res, viewer());
});

router.get('/pdf', (req, res) => {
  page(res, pdf());
});

router.get('/imagens', (req, res) => {
  page(res, images());
});

router.get('/formatar', (req, res) => {
  page(res, format());
});

router.get('/logs', (req, res) => {
  page(res, logs());
});

router.get('/html-pdf', (req, res) => {
  page(res, htmlpdf());
});

router.get('/editar-pdf', (req, res) => {
  page(res, pdfedit());
});

/* Salas compartilhadas: a mesma view serve para a página de criar e para a
   sala aberta (`/notas/abc123`) — o cliente JS lê a URL e mostra o painel. */
router.get('/notas', (req, res) => {
  page(res, notas({ ttlMs: salas.cfg.ttlNotaMs }));
});

router.get('/notas/:id', (req, res) => {
  page(res, notas({ ttlMs: salas.cfg.ttlNotaMs }));
});

router.get('/drive', (req, res) => {
  page(res, drive({ tamMaxBytes: salas.cfg.tamMaxBytes, ttlMs: salas.cfg.ttlArquivoMs }));
});

router.get('/drive/:id', (req, res) => {
  page(res, drive({ tamMaxBytes: salas.cfg.tamMaxBytes, ttlMs: salas.cfg.ttlArquivoMs }));
});

module.exports = router;