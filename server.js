'use strict';

const path = require('node:path');

/* Antes de qualquer leitura de `process.env`: o `.env` alimenta PORT/HOST e a
   escolha do gerador de PDF (USER_CHROME/DIR_CHROME). */
require('./src/lib/env').loadEnv();

const express = require('express');

const pagesRouter = require('./src/routes/pages');
const apiRouter = require('./src/routes/api');
const fontStore = require('./src/lib/fonts');
const { store } = require('./src/lib/library');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

/* Limite generoso: documentos com muitas imagens em base64. */
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false, limit: '25mb' }));

// `must-revalidate` faz o navegador pedir o arquivo de novo a cada visita em
// vez de confiar numa cópia antiga por uma hora. As URLs de js/css já levam um
// carimbo de versão (ver src/views/layout.js), então o custo é só o 304.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.md')) {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      } else if (/\.(js|css|html|svg)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.use('/api', apiRouter);

/* Arquivos das fontes externas: a prévia no navegador carrega daqui. Os nomes
   são gerados por nós (slug da família + variação), nunca vêm do usuário, e
   `index.json` fica de fora — a lista de fontes já sai por /api/fonts. */
fontStore.ensure();
app.use('/fonts', (req, res, next) => {
  if (!/\.(ttf|otf)$/i.test(req.path)) {
    return res.status(404).send('Arquivo de fonte não encontrado');
  }
  return next();
});
app.use(
  '/fonts',
  express.static(path.join(__dirname, 'data', 'fonts'), {
    index: false,
    fallthrough: false,
    immutable: true,
    maxAge: '30d',
  })
);

app.use('/', pagesRouter);

/* 404 */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Recurso não encontrado' });
  }
  return res.status(404).send('Página não encontrada');
});

/* Tratamento de erros (inclui o do gerador de PDF). */
app.use((err, req, res, next) => {
  console.error('[erro]', err.stack || err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: err.message || 'Erro interno' });
  }
  return res.status(status).send(err.message || 'Erro interno');
});

store.ensure();

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Markdown Studio');
  console.log('  ---------------------------------------------');
  console.log('  Início      http://localhost:' + PORT + '/');
  console.log('  Visualizar  http://localhost:' + PORT + '/visualizar');
  console.log('  PDF         http://localhost:' + PORT + '/pdf');
  console.log('');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));

module.exports = app;