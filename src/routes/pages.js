'use strict';

const express = require('express');

const { home } = require('../views/home');
const { viewer } = require('../views/viewer');
const { pdf } = require('../views/pdf');
const { images } = require('../views/images');

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

module.exports = router;