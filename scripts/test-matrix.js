'use strict';

/**
 * Roda a matriz de presets, temas e formatos de numeração para garantir
 * que nenhuma configuração quebra a geração do PDF.
 * Uso: node scripts/test-matrix.js
 */
const { renderPdf } = require('../src/lib/pdf');
const shared = require('../public/js/shared-settings.js');

function sampleMarkdown() {
  return [
    '---',
    'title: Documento de Verificação',
    'author: Markdown Studio',
    '---',
    '',
    '# Título principal',
    '',
    'Parágrafo com **negrito**, *itálico*, `código inline`, ~~riscado~~ e',
    'um [link](https://example.com). Palavras compridas como',
    'antepenultimamente', 'e', 'supercalifragilisticexpialidocious', 'para',
    'testar a quebra de linha e o recuo pendente das listas.',
    '',
    '## Lista',
    '',
    '- Item com um texto razoavelmente longo para ocupar mais de uma linha',
    '- Outro item',
    '  - Subitem aninhado',
    '',
    '1. Ordenado um',
    '2. Ordenado dois',
    '',
    '> Citação em bloco com **formatação**.',
    '',
    '```js',
    'const soma = (a, b) => a + b; // comentário',
    '```',
    '',
    '| Coluna A | Coluna B |',
    '|:---------|---------:|',
    '| um       |      123 |',
    '| dois     |      456 |',
    '',
    '---',
    '',
    Array.from({ length: 12 }, (_, i) => 'Parágrafo ' + (i + 1) + ' para ocupar páginas.').join('\n\n'),
  ].join('\n');
}

const source = sampleMarkdown();

function pageCount(buffer) {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
}

async function check(label, overrides) {
  const settings = Object.assign(shared.applyPreset('artigo'), { showToc: true, pageNumbers: true }, overrides);
  const buffer = await renderPdf(source, settings, {});
  const pages = pageCount(buffer);
  console.log(
    (label + '                        ').slice(0, 24) +
      String((buffer.length / 1024).toFixed(0) + ' KB').padStart(8) +
      String(pages).padStart(4) + ' páginas'
  );
  return buffer;
}

async function main() {
  for (const name of Object.keys(shared.PRESETS)) await check('preset: ' + name);
  for (const theme of Object.keys(shared.THEMES)) await check('tema: ' + theme, { theme });
  for (const format of ['arabic', 'arabic-total', 'roman']) {
    await check('numeração: ' + format, { pageNumberFormat: format, pageNumberPosition: 'header-right' });
  }
  await check('hifenização', { hyphenation: true, textAlign: 'justify' });
  await check('texto grande', { fontSize: 26, margins: { top: 5, right: 5, bottom: 5, left: 5 } });
  await check('texto pequeno', { fontSize: 7, paragraphSpacing: 0, lineHeight: 1.05 });
  await check('paisagem A5', { pageSize: 'A5', orientation: 'landscape' });
  await check('sumário h6', { showToc: true, tocDepth: 6 });
  await check('sem numeração', { pageNumbers: false, runningTitle: '' });
  await check('recuo 40mm', { firstLineIndent: 40, textAlign: 'justify' });
  await check('caixa alta mono', { fontFamily: 'mono', headingFontFamily: 'mono', listStyle: 'dash' });

  /* Casos-limite: não devem lançar erro. */
  console.log('\nCasos-limite:');
  await renderPdf('', shared.applyPreset('artigo'), {}).then((b) => console.log('  documento vazio ok'));
  await renderPdf('# Só um título', shared.applyPreset('artigo'), {}).then(() => console.log('  só título ok'));
  await renderPdf('| a | b |\n|---|---|\n| 1 | 2 |', shared.applyPreset('artigo'), {}).then(() => console.log('  só tabela ok'));
  await renderPdf('```\ncódigo sem linguagem\n```', shared.applyPreset('artigo'), {}).then(() => console.log('  código sem lang ok'));
  await renderPdf('![x](http://localhost:9/nao-existe.png)', shared.applyPreset('artigo'), {})
    .then(() => console.log('  imagem indisponível ok'));
  await renderPdf('<div>html puro</div>', shared.applyPreset('artigo'), {}).then(() => console.log('  html bruto ok'));
  await renderPdf('#'.repeat(200), shared.applyPreset('artigo'), {}).then(() => console.log('  entrada estranha ok'));

  console.log('\nTodas as configurações passaram.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});