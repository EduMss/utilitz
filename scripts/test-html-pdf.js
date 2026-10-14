'use strict';
/**
 * Testes do conversor de HTML para PDF (página /html-pdf).
 *
 * Duas partes: o montador de documento (`buildHtmlDocument`) roda sempre,
 * porque é puro; a impressão de verdade (`renderHtmlPdf`) só roda quando há
 * Chrome/Chromium/Edge instalado — sem ele, a API responde 503 e a página
 * oferece a impressão pelo próprio navegador.
 *
 * Uso: node scripts/test-html-pdf.js
 */
const assert = require('node:assert');

const chrome = require('../src/lib/chrome.js');
const shared = require('../public/js/shared-settings.js');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n         ' + (err && err.message));
  }
}

console.log('\n== html -> pdf ==');

check('pedaço solto vira um documento inteiro', () => {
  const doc = chrome.buildHtmlDocument('<h1>Olá</h1>', { title: 'Recibo', pageSize: 'A5' });
  assert.ok(doc.startsWith('<!doctype html>'), 'falta o doctype');
  assert.ok(doc.indexOf('<meta charset="utf-8">') >= 0, 'falta o charset');
  assert.ok(doc.indexOf('<title>Recibo</title>') >= 0, 'falta o título');
  assert.ok(doc.indexOf('<h1>Olá</h1>') >= 0, 'o conteúdo precisa entrar no corpo');
  assert.ok(doc.indexOf('size: 148mm 210mm') >= 0, 'A5 tem que sair no @page: ' + doc.slice(0, 300));
  assert.ok(doc.indexOf('data-pdf-ready') >= 0, 'sem o sinal de prontidão o Chrome imprime cedo');
});

check('orientação paisagem inverte o papel', () => {
  const doc = chrome.buildHtmlDocument('<p>x</p>', { pageSize: 'A4', orientation: 'paisagem' });
  assert.ok(doc.indexOf('size: 297mm 210mm') >= 0, 'A4 deitado é 297 x 210');
});

check('margens aceitam preset, objeto e nome inventado', () => {
  const preset = chrome.buildHtmlDocument('<p>x</p>', { margins: 'nenhuma' });
  assert.ok(preset.indexOf('margin: 0mm 0mm 0mm 0mm') >= 0, 'preset nenhuma');

  const custom = chrome.buildHtmlDocument('<p>x</p>', { margins: { top: 5, left: 30 } });
  assert.ok(custom.indexOf('margin: 5mm 15mm 15mm 30mm') >= 0, 'o que não veio cai no padrão');

  const unknown = chrome.buildHtmlDocument('<p>x</p>', { margins: 'inventada' });
  assert.ok(unknown.indexOf('margin: 15mm 15mm 15mm 15mm') >= 0, 'preset desconhecido cai no padrão');
});

check('página inteira é preservada e o @page dela vale mais', () => {
  const source = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<style>@page { size: 100mm 100mm; margin: 30mm; }</style></head>' +
    '<body><p>texto</p></body></html>';
  const doc = chrome.buildHtmlDocument(source, { pageSize: 'A4', margins: 'estreitas' });

  assert.ok(doc.indexOf('<p>texto</p>') >= 0, 'o corpo não pode sumir');
  const mine = doc.indexOf('data-html-pdf-print');
  const theirs = doc.indexOf('@page { size: 100mm');
  assert.ok(mine >= 0, 'o CSS de impressão não entrou');
  assert.ok(theirs > mine, 'o @page da página tem que vir depois para valer mais');
  assert.ok(doc.indexOf('data-pdf-ready') >= 0, 'faltou o sinal de prontidão');
});

check('título com caractere perigoso sai escapado', () => {
  const doc = chrome.buildHtmlDocument('<p>x</p>', { title: '<b>negrito</b>' });
  assert.ok(doc.indexOf('<title>&lt;b&gt;negrito&lt;/b&gt;</title>') >= 0, 'o título precisa sair escapado');
});

check('a folha impressa tem cor de fundo disponível', () => {
  const doc = chrome.buildHtmlDocument('<p>x</p>', {});
  assert.ok(doc.indexOf('print-color-adjust: exact') >= 0, 'sem isso o fundo sai branco');
});

check('os catálogos da página e do servidor são os mesmos', () => {
  assert.ok(shared.PAGE_SIZES.A4 && shared.MARGIN_PRESETS.padrao, 'catálogo ausente no shared-settings');
  const doc = chrome.buildHtmlDocument('<p>x</p>', { pageSize: 'Letter', margins: 'largas' });
  assert.ok(doc.indexOf('size: 215.9mm 279.4mm') >= 0, 'Carta em milímetros');
  assert.ok(doc.indexOf('margin: 25mm 25mm 25mm 25mm') >= 0, 'largas em milímetros');
});

/* ---------------------------------------------------------- *
 * Impressão de verdade (só com navegador instalado)
 * ---------------------------------------------------------- */
(async () => {
  if (!chrome.resolveChrome()) {
    console.log('\n  -- Chrome/Edge não encontrado: impressão ao vivo pulada\n');
  } else {
    await (async () => {
      try {
        const buffer = await chrome.renderHtmlPdf(
          '<h1>Teste de impressão</h1><p style="background:#ddeeff;padding:8px">fundo colorido</p>',
          { pageSize: 'A5', margins: 'estreitas', title: 'Teste' }
        );
        assert.strictEqual(buffer.slice(0, 5).toString('latin1'), '%PDF-', 'o arquivo não começa como PDF');
        assert.ok(buffer.length > 1000, 'PDF suspeito de tamanho');
        pass++;
        console.log('  ok   renderHtmlPdf devolve um PDF de verdade (' + buffer.length + ' bytes)');
      } catch (err) {
        failures.push('renderHtmlPdf devolve um PDF de verdade');
        console.log('  FAIL renderHtmlPdf devolve um PDF de verdade\n         ' + (err && err.message));
      }
    })();
  }

  console.log('\n' + pass + ' verificação(ões) ok, ' + failures.length + ' falha(s)\n');
  process.exit(failures.length ? 1 : 0);
})();
