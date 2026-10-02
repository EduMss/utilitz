'use strict';

/**
 * Roda a matriz de presets, temas e formatos de numeração para garantir
 * que nenhuma configuração quebra a geração do PDF.
 * Uso: node scripts/test-matrix.js
 */
const { renderPdf } = require('../src/lib/pdf');
const shared = require('../public/js/shared-settings.js');
const { normalize, geometry } = require('../src/lib/settings');
const zlib = require('node:zlib');

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

function hexToText(hex) {
  let out = '';
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return out;
}

/**
 * Lê a posição real de cada trecho de texto desenhado no PDF (operador
 * `Tm`). Sem isso não dá para provar que um bloco saiu no lugar certo:
 * o PDFKit não reclama quando o cursor fica deslocado.
 *
 * `keepBlank` preserva trechos só com espaço. O marcador de lista (`•`,
 * byte 0x95 em WinAnsi) conta como espaço para `trim`, então sem esta
 * opção ele some da leitura.
 */
function textPositions(buffer, options) {
  const keepBlank = Boolean(options && options.keepBlank);
  const raw = buffer.toString('latin1');
  const out = [];
  let cursor = 0;
  let page = 1;

  while (cursor < raw.length) {
    const start = raw.indexOf('stream', cursor);
    if (start < 0) break;
    const from = raw.indexOf('\n', start) + 1;
    const to = raw.indexOf('endstream', from);
    if (to < 0) break;

    try {
      const stream = zlib.inflateSync(buffer.slice(from, to)).toString('latin1');
      stream.split('BT').slice(1).forEach((bloco) => {
        const tm = /1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/.exec(bloco);
        if (!tm) return;
        const size = /\/(\w+) ([\d.]+) Tf/.exec(bloco);
        const text = (bloco.match(/<([0-9a-f]+)>/g) || []).map((h) => hexToText(h.slice(1, -1))).join('');
        if (!keepBlank && !text.trim()) return;
        out.push({
          page,
          x: parseFloat(tm[1]),
          y: parseFloat(tm[2]),
          size: size ? parseFloat(size[2]) : 0,
          text,
        });
      });
    } catch (err) {
      /* página sem stream comprimido */
    }

    cursor = to + 9;
    page += 1;
  }

  return out;
}

/** Fluxos de conteúdo descomprimidos, para inspecionar traços e cores. */
function contentStreams(buffer) {
  const raw = buffer.toString('latin1');
  const out = [];
  let cursor = 0;

  while (cursor < raw.length) {
    const start = raw.indexOf('stream', cursor);
    if (start < 0) break;
    const from = raw.indexOf('\n', start) + 1;
    const to = raw.indexOf('endstream', from);
    if (to < 0) break;

    try {
      out.push(zlib.inflateSync(buffer.slice(from, to)).toString('latin1'));
    } catch (err) {
      /* página sem stream comprimido */
    }

    cursor = to + 9;
  }

  return out;
}

/**
 * Regressão: `doc.text` deixa `doc.x` no fim do trecho desenhado. Listas,
 * tabelas e blocos de código reposicionavam o cursor e nunca devolviam,
 * então o texto seguinte herdava o recuo e saía no meio da página.
 */
async function checkIndents() {
  const preset = Object.assign(shared.applyPreset('artigo'), { firstLineIndent: 0 });
  const margem = geometry(normalize(preset)).margins.left;
  const casos = [
    ['lista', '- item\n\nparagrafo', 'paragrafo', 0],
    ['tabela', '| a | b |\n|---|---|\n| 1 | 2 |\n\nparagrafo', 'paragrafo', 0],
    ['tabela 4 colunas', '| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n\nparagrafo', 'paragrafo', 0],
    ['código', '```\nx\n```\n\nparagrafo', 'paragrafo', 0],
    ['citação', '> texto\n\nparagrafo', 'paragrafo', 0],
    ['citação mantém recuo', '> texto', 'texto', 14],
    ['título após tabela', '| a |\n|---|\n| 1 |\n\n## Titulo', 'Titulo', 5],
  ];

  const falhas = [];

  for (const [label, source, alvo, recuo] of casos) {
    const buffer = await renderPdf(source, preset, {});
    const line = textPositions(buffer).find((l) => l.text.indexOf(alvo) === 0);
    const esperado = margem + recuo;
    if (!line) {
      falhas.push(label + ': trecho "' + alvo + '" não encontrado no PDF');
      continue;
    }
    if (Math.abs(line.x - esperado) > 1) {
      falhas.push(label + ': "' + alvo + '" saiu em x=' + line.x.toFixed(1) + ', esperado ' + esperado.toFixed(1));
    }
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') +
      'recuos horizontais entre blocos (' + casos.length + ' casos)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: espaçamento vertical entre blocos.
 *
 * O preview aplica as margens de `public/js/pdf.js` em CSS, onde elas
 * colapsam (vence a maior). O PDF precisa reproduzir exatamente isso, e
 * `paragraphSpacing` está em pontos — tratá-lo como mm inflava tudo em
 * 2,835x. Em vez de comparar distâncias absolutas (que dependem da
 * geometria da tabela, do padding do código etc), medimos a mesma
 * distância com dois valores de `paragraphSpacing` e conferimos o
 * coeficiente: se a margem é `k * paragraphSpacing`, a distância muda
 * `k * delta`.
 */
async function checkVerticalSpacing() {
  const DELTA = 18;
  const PS1 = 9;
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.6,
    textAlign: 'left',
    showToc: false,
    firstLineIndent: 0,
  });

  /* [nome, markdown, coeficiente esperado, de qual par de blocos medir]
     'topo' usa os dois primeiros, 'base' os dois últimos. Necessário
     quando o markdown tem mais de dois blocos. */
  const casos = [
    ['parágrafo -> parágrafo', 'alfa\n\nbeta', 1],
    ['item -> item', '- alfa\n- beta', 0],
    ['parágrafo -> item', 'alfa\n\n- beta', 1],
    ['item -> parágrafo', '- alfa\n\nbeta', 1],
    ['item -> subitem', '- alfa\n  - beta', 0],
    ['lista -> parágrafo', '- a\n- b\n\nc', 1, 'base'],
    ['citação -> parágrafo', '> alfa\n\nbeta', 0.5],
    ['parágrafo -> citação', 'alfa\n\n> beta', 1],
    ['parágrafo -> código', 'alfa\n\n```\nx\n```', 1],
    ['tabela -> parágrafo', '| a |\n|---|\n| 1 |\n\nbeta', 0.5, 'base'],
    ['parágrafo -> tabela', 'alfa\n\n| a |\n|---|\n| 1 |', 1],
    ['parágrafo -> régua', 'alfa\n\n---\n\nbeta', 2.8],
    ['h2 -> parágrafo', '## alfa\n\nbeta', 0.7 / 3],
    ['parágrafo -> h2', 'alfa\n\n## beta', 1],
    ['h2 -> h2', '## alfa\n\n## beta', 1.8 / 3],
  ];

  /* Bases de texto dentro da área de conteúdo, medidas de cima para
     baixo. Dedup por y porque o marcador e o texto do item caem na mesma
     linha; o rodapé/cabeçalho fica fora da área e é descartado. */
  const geo = geometry(normalize(base));
  const altura = geo.heightPt;

  function bases(buffer) {
    const ys = new Set();
    textPositions(buffer).forEach((l) => {
      const topo = altura - l.y;
      if (topo < geo.margins.top - 4 || topo > altura - geo.margins.bottom + 4) return;
      ys.add(+topo.toFixed(2));
    });
    return Array.from(ys).sort((a, b) => a - b);
  }

  async function distancia(source, ps, lado) {
    const ys = bases(await renderPdf(source, Object.assign({}, base, { paragraphSpacing: ps }), {}));
    if (ys.length < 2) throw new Error('poucas linhas em ' + JSON.stringify(source));
    return lado === 'base' ? ys[ys.length - 1] - ys[ys.length - 2] : ys[1] - ys[0];
  }

  const falhas = [];

  for (const [nome, source, coef, lado] of casos) {
    const d1 = await distancia(source, PS1, lado);
    const d2 = await distancia(source, PS1 + DELTA, lado);
    const medido = (d2 - d1) / DELTA;
    if (Math.abs(medido - coef) > 0.02) {
      falhas.push(nome + ': coeficiente ' + medido.toFixed(3) + ', esperado ' + coef.toFixed(3));
    }
  }

  /* `lineHeight` também é afetado pelo gap da fonte: o PDFKit avança a
     linha com `currentLineHeight(true) + lineGap`. */
  for (const lh of [1.2, 1.6, 2]) {
    const ys = bases(
      await renderPdf('palavra '.repeat(40), Object.assign({}, base, { lineHeight: lh, paragraphSpacing: 0 }), {})
    );
    const alturas = [...new Set(ys.slice(1).map((y, i) => (y - ys[i]).toFixed(2)))];
    const esperado = (base.fontSize * lh).toFixed(2);
    if (alturas.length !== 1 || alturas[0] !== esperado) {
      falhas.push('lineHeight ' + lh + ': entrelinha ' + (alturas.join(', ') || 'nenhuma') + ', esperado ' + esperado);
    }
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') +
      'espaçamento vertical entre blocos (' + (casos.length + 3) + ' casos)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: entrelinhamento dentro das células de tabela.
 *
 * `#preview-pages` herda `line-height` do container, então uma descrição
 * longa quebra com o mesmo espaçamento do resto do documento. O PDF
 * passava `lineGap: 0`, o que dava ~1.11 em em vez de 1.5: as linhas da
 * célula ficavam espremidas e pareciam empilhadas.
 */
async function checkTableLineHeight() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    textAlign: 'left',
    showToc: false,
    firstLineIndent: 0,
  });
  const geo = geometry(normalize(base));
  const altura = geo.heightPt;

  /* Uma coluna so: todas as linhas do PDF pertencem a uma unica celula,
     entao nao ha como confundir entrelinha com gap entre linhas. O texto
     e longo de proposito para a celula quebrar em varias linhas. */
  const descricao = [
    'Especificacao OpenAPI gerada automaticamente durante o build da aplicacao.',
    'Ela e servida apenas no ambiente de Development e nunca em producao.',
    'Se o arquivo nao existir no disco o endpoint responde 404.',
  ].join(' ');
  const source = ['| Descricao |', '|---|', '| ' + descricao + ' |'].join('\n');

  const falhas = [];

  for (const lh of [1.2, 1.5, 2]) {
    const ys = new Set();
    textPositions(await renderPdf(source, Object.assign({}, base, { lineHeight: lh }), {})).forEach((l) => {
      const topo = altura - l.y;
      if (topo < geo.margins.top - 4 || topo > altura - geo.margins.bottom + 4) return;
      ys.add(+topo.toFixed(2));
    });
    const ordenadas = Array.from(ys).sort((a, b) => a - b);
    const alturas = ordenadas.slice(1).map((y, i) => +(y - ordenadas[i]).toFixed(2));
    const alvo = +(base.fontSize * 0.95 * lh).toFixed(2);

    /* A celula de dados usa 0.95 do tamanho da fonte e quebra em varias
       linhas; o cabecalho usa 0.98 e o salto ate a primeira linha de
       dados e o gap da linha da tabela, nao entrelinha. */
    const repeticoes = alturas.filter((h) => Math.abs(h - alvo) <= 0.7).length;
    if (repeticoes < 2) {
      falhas.push(
        'lineHeight ' + lh + ': esperado ' + alvo + 'pt entre as linhas da celula, medido [' +
          alturas.join(', ') + ']'
      );
    }
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') + 'entrelinhamento dentro da celula de tabela (3 casos)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: trechos com fontes diferentes dentro da mesma célula.
 *
 * `renderTable` passava `x`/`y` explícitos para cada trecho, e o PDFKit
 * reinicia `doc.y` nesse caso (pdfkit.js:4439) e zera o `continuedX` após
 * cada quebra de linha. Resultado: um trecho em negrito no fim da célula
 * era desenhado na mesma linha do texto normal, por cima dele.
 */
async function checkMixedFontCells() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    textAlign: 'left',
    showToc: false,
    firstLineIndent: 0,
  });
  const geo = geometry(normalize(base));

  /* Descricao curta o bastante para quebrar em varias linhas, com o
     trecho em negrito no fim — o caso reportado. */
  const cabecalho = ['| Metodo | Rota | Autenticacao | Requer token | Descricao |', '|---|---|---|---|---|'];
  const descricao = 'Especificacao OpenAPI gerada — **so em Development**';
  const casos = [
    ['negrito no fim', descricao],
    ['negrito no meio', 'Especificacao **OpenAPI** gerada — so em Development'],
    ['so negrito', '**Especificacao OpenAPI gerada so em Development**'],
    ['codigo no fim', 'Especificacao OpenAPI gerada — so em `Development`'],
    ['negrito e codigo', 'Especificacao **OpenAPI** gerada — so em `Development`'],
  ];

  const falhas = [];

  for (const [nome, texto] of casos) {
    const source = cabecalho
      .concat('| GET | /openapi/v1.json | Nao necessaria | Nao | ' + texto + ' |')
      .concat('| POST | /auth/login | Nao necessaria | Nao | Autentica |')
      .join('\n');

    const altura = geo.heightPt;
    const ys = textPositions(await renderPdf(source, base, {}));

    /* Na coluna da descricao, dois trechos nao podem ter a mesma posicao:
       mesma x e mesma baseline e um estar desenhado sobre o outro.
       (Trechos lado a lado na mesma linha tem x diferentes e podem ter
       baselines AtOffset de até 1pt por causa do ascender da fonte.) */
    const coluna = ys.filter((l) => {
      const topo = altura - l.y;
      return topo > geo.margins.top - 4 && topo <= altura - geo.margins.bottom + 4 && l.x > geo.widthPt - geo.margins.right - 140;
    });

    let achou = false;
    for (let i = 0; i < coluna.length && !achou; i += 1) {
      for (let j = i + 1; j < coluna.length; j += 1) {
        if (Math.abs(coluna[i].x - coluna[j].x) < 1 && Math.abs(coluna[i].y - coluna[j].y) < 2) {
          falhas.push(
            nome + ': "' + coluna[i].text.slice(0, 18) + '" desenhado sobre "' + coluna[j].text.slice(0, 18) + '"'
          );
          achou = true;
          break;
        }
      }
    }
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') + 'celula com fonte mista nao sobrepoe (' + casos.length + ' casos)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: blocos de código.
 *
 * `htmlToRuns` lia os grupos da regex na ordem errada, entao `text` era
 * sempre `undefined`, todo texto era descartado e o bloco saia em branco
 * (o retangulo aparecia, o codigo nao).
 */
async function checkCodeBlocks() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    showToc: false,
    firstLineIndent: 0,
  });
  const geo = geometry(normalize(base));
  const altura = geo.heightPt;

  const casos = [
    ['json', '{', '"type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",', '"status": 400', '}'],
    ['javascript', 'const x = 1;', 'function f() {', '  return x;', '}'],
    ['bash', '#!/bin/bash', 'set -euo pipefail', 'curl -s "$URL"'],
    ['sql', 'SELECT id', 'FROM users', 'WHERE id = 1;'],
    ['python', 'def f(x):', '    return x * 2'],
    ['diff', '- old', '+ new'],
    ['shell', 'ls -la'],
  ];

  const falhas = [];

  for (const [linguagem, ...esperadas] of casos) {
    const source = ['```' + linguagem].concat(esperadas).concat('```').join('\n');
    const ys = textPositions(await renderPdf(source, base, {}));

    /* Os trechos coloridos sao runs separados; remontar por baseline. */
    const porLinha = new Map();
    ys.forEach((l) => {
      const topo = altura - l.y;
      if (topo <= geo.margins.top - 4 || topo >= altura - geo.margins.bottom + 4) return;
      const k = topo.toFixed(1);
      if (!porLinha.has(k)) porLinha.set(k, []);
      porLinha.get(k).push(l);
    });

    /* `textPositions` descarta runs so com espacos (o realcador emite um
       run separado para cada espaco entre tokens), entao a comparacao
       ignora espacos. */
    const desenhado = Array.from(porLinha.values())
      .sort((a, b) => a[0].x - b[0].x)
      .map((itens) =>
        itens
          .sort((a, b) => a.x - b.x)
          .map((i) => i.text)
          .join('')
          .replace(/\s+/g, '')
      )
      .filter(Boolean);

    /* Cada linha do codigo precisa aparecer no PDF. */
    for (const linha of esperadas) {
      const alvo = linha.replace(/\s+/g, '');
      if (!alvo) continue;
      const achou = desenhado.some((t) => t.indexOf(alvo) >= 0);
      if (!achou) falhas.push(linguagem + ': linha "' + linha.trim() + '" nao apareceu no PDF');
    }

    if (!desenhado.length) falhas.push(linguagem + ': bloco de codigo saiu vazio');
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') + 'bloco de codigo renderiza o texto (' + casos.length + ' linguagens)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: linha de codigo mais larga que a caixa.
 *
 * `lineBreak: false` nao desliga a quebra: como `width` era informado, o
 * `LineWrapper` ainda cortava a linha (pdfkit.js:4192) e a cauda do token
 * descia com a entrelinha da fonte, caindo em cima da linha seguinte. O
 * resto da linha tambem passava da margem direita.
 */
async function checkCodeBlockWrap() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    showToc: false,
    firstLineIndent: 0,
  });
  const geo = geometry(normalize(base));
  const altura = geo.heightPt;
  const direita = geo.widthPt - geo.margins.right;

  const linhas = [
    '{',
    '  "name" : "wa-discservice_cde12686-8cc1-4ec3-8dec-1a772aed724a_3f2a1b8c-0000-4000-8000-000000000000 "token" : "cde12686-8cc1-4ec3-8dec-1a772aed724a" ,',
    '  "ok" : true',
    '}',
  ];
  const source = ['```json'].concat(linhas).concat('```').join('\n');

  const ys = textPositions(await renderPdf(source, base, {})).filter((l) => {
    const topo = altura - l.y;
    return topo > geo.margins.top - 4 && topo < altura - geo.margins.bottom + 4;
  });

  const falhas = [];

  /* Nada pode passar da margem direita. */
  ys.forEach((l) => {
    if (l.x > direita + 1) {
      falhas.push('trecho fora da margem (x=' + l.x.toFixed(1) + '): "' + l.text.slice(0, 24) + '"');
    }
  });

  /* Baselines com passo constante: um trecho dentro do passo e a cauda
     quebrada pelo PDFKit caindo entre duas linhas gerenciadas. */
  const topos = Array.from(new Set(ys.map((l) => +(altura - l.y).toFixed(1)))).sort((a, b) => a - b);
  if (topos.length < 3) falhas.push('a linha longa nao foi quebrada (' + topos.length + ' baselines)');
  const passo = topos.length > 1 ? topos[1] - topos[0] : 0;
  for (let i = 1; i < topos.length; i += 1) {
    const sep = topos[i] - topos[i - 1];
    if (Math.abs(sep - passo) > 1) {
      falhas.push('baselines irregulares: ' + sep.toFixed(1) + 'pt (passo ' + passo.toFixed(1) + 'pt)');
    }
  }

  /* Nenhum caractere perdido na quebra. */
  const desenhado = ys.map((l) => l.text).join('').replace(/\s+/g, '');
  const esperado = linhas.join('').replace(/\s+/g, '');
  if (desenhado.indexOf(esperado) < 0) falhas.push('texto do codigo perdido ou reordenado na quebra');

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') + 'linha de codigo larga quebra dentro da caixa'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: marcador de lista órfão no fim da página.
 *
 * O `LineWrapper` do PDFKit checa `doc.y + lineHeight > page.maxY()`
 * antes de cada linha e pula de página sozinho (pdfkit.js:4010). O
 * marcador é desenhado fora desse fluxo, então quando o item nascia
 * colado no rodapé ele ficava sozinho na página anterior e o texto
 * aparecia sem marcador na seguinte.
 */
async function checkListMarkerOrphan() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    textAlign: 'justify',
    showToc: false,
    pageNumberPosition: 'footer-center',
  });
  const geo = geometry(normalize(base));
  const esquerda = geo.margins.left;
  const BOLA = String.fromCharCode(0x95);

  const longo =
    'Expiracao do token: definida por Jwt:ExpiresInMinutes no appsettings.json ' +
    '(hoje 10080=7 dias). Nao ha refresh token nem revogacao: um token emitido vale ate expirar.';

  const falhas = [];
  let orfaos = 0;
  let itens = 0;

  /* Varia o preenchimento para varrer todas as posicoes do item na
     pagina; so uma delas cai exatamente junto ao rodape. */
  for (let n = 20; n <= 38; n += 1) {
    const source2 =
      '## Notas\n\n' +
      'linha de enchimento.\n\n'.repeat(n) +
      '- ' + longo + '\n- dial-wa-api-integracao — Endpoints Disponiveis\n';

    const ls = textPositions(await renderPdf(source2, base, {}), { keepBlank: true });

    ls.forEach((m) => {
      /* O PDFKit escreve o glifo como byte simples: 0x95 = '•' em
         WinAnsi, 0x2d = '-' do estilo decimal. */
      if (Math.abs(m.x - esquerda) > 1.5) return;
      if (m.text !== BOLA && m.text !== '-') return;

      itens += 1;
      const texto = ls.find(
        (l) => l.page === m.page && Math.abs(l.y - m.y) < 6 && l.x > m.x + 2 && l.text.trim()
      );
      if (!texto) {
        orfaos += 1;
        falhas.push('marcador orfao na pagina ' + m.page + ' (y=' + m.y.toFixed(1) + ', preenchimento ' + n + ')');
      }
    });
  }

  if (!itens) falhas.push('nenhum marcador de lista foi encontrado para verificar');

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') +
      'marcador de lista nunca fica orfao (' + itens + ' marcadores)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: a tabela precisa de malha completa e fina.
 *
 * O preview declara `border-collapse: collapse` com `border` em
 * `th`/`td` (public/js/pdf.js:468), o que junta tudo numa malha: os 4
 * lados de cada linha mais um separador por coluna. O PDF só desenhava a
 * linha de cima e a do cabeçalho, então a tabela terminava no branco e se
 * confundia com o texto seguinte.
 */
async function checkTableBorder() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    showToc: false,
  });

  const colunas = 3;
  const linhas = [
    '| Coluna A | Coluna B | Coluna C |',
    '|:---------|---------:|----------:|',
    '| um       |      123 |      abc |',
    '| dois     |      456 |      def |',
  ].join('\n');

  const flux = contentStreams(await renderPdf(linhas, base, {})).join('\n');
  const tracos = (flux.match(/[\d.-]+ [\d.-]+ m\n[\d.-]+ [\d.-]+ l\nS/g) || []);
  /* Num vertical o x do `l` e igual ao do `m`. */
  const verticais = (flux.match(/([\d.-]+) [\d.-]+ m\n\1 [\d.-]+ l\nS/g) || []);
  const espessura = /([\d.]+) w/.exec(flux);

  const linhasDaTabela = 3;
  /* N linhas dão N+1 horizontais (o topo da primeira mais a base de cada
     uma) e N verticais por separador de coluna, mais as duas externas. */
  const esperadoHorizontal = linhasDaTabela + 1;
  const esperadoVertical = linhasDaTabela * (colunas + 1);
  const esperado = esperadoHorizontal + esperadoVertical;
  const falhas = [];

  if (tracos.length !== esperado) {
    falhas.push(
      'esperados ' + esperado + ' lados (' + esperadoHorizontal + ' horizontais, ' +
        esperadoVertical + ' verticais), vieram ' + tracos.length
    );
  }

  if (verticais.length !== esperadoVertical) {
    falhas.push('esperados ' + esperadoVertical + ' verticais, vieram ' + verticais.length);
  }

  /* Fina: 0.35pt, espelhando o `border` do preview. */
  if (!espessura || Math.abs(parseFloat(espessura[1]) - 0.35) > 0.01) {
    falhas.push('espessura da borda saiu ' + (espessura ? espessura[1] : 'nenhuma'));
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') +
      'tabela tem malha completa (' + tracos.length + ' lados, ' + verticais.length + ' verticais)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
}

/**
 * Regressão: nenhuma borda da grade pode sair da caixa da página.
 *
 * Uma linha mais alta que a página inteira não cabe em lugar nenhum. Sem
 * limitar a altura, a borda inferior era desenhada em y ~1487 numa página
 * de 842 e sumia, e a linha seguinte nascia fora do papel.
 */
async function checkTableBordersInsidePage() {
  const base = Object.assign(shared.applyPreset('artigo'), {
    fontSize: 11,
    lineHeight: 1.5,
    showToc: false,
  });
  const geo = geometry(normalize(base));
  const topo = geo.margins.top;
  const baixo = geo.heightPt - geo.margins.bottom;

  const casos = [
    ['linha maior que a pagina', ['| A | B |', '|---|---|', '| ' + 'palavra '.repeat(900) + ' | x |', '| depois | y |']],
    ['celula enorme', ['| A | B | C |', '|---|---|---|', '| ' + 'x '.repeat(1500) + ' | ' + 'y '.repeat(1200) + ' | z |']],
  ];

  const falhas = [];

  for (const [nome, md] of casos) {
    const o = contentStreams(await renderPdf(md.join('\n'), base, {}))
      .join('\n')
      .split('\n');

    o.forEach((linha, i) => {
      if (!/^[\d.-]+ [\d.-]+ m$/.test(linha)) return;
      if (!/^[\d.-]+ [\d.-]+ l$/.test(o[i + 1])) return;
      if (o[i + 2] !== 'S') return;

      [linha, o[i + 1]].forEach((op) => {
        const y = parseFloat(op.split(' ')[1]);
        if (y < topo - 1 || y > baixo + 1) {
          falhas.push(nome + ': borda em y=' + y.toFixed(1) + ' fora de ' + topo.toFixed(1) + '..' + baixo.toFixed(1));
        }
      });
    });
  }

  console.log(
    (falhas.length ? '  FALHA ' : '  ok   ') + 'borda da tabela nunca sai da pagina (' + casos.length + ' casos)'
  );
  falhas.forEach((f) => console.log('        ' + f));
  if (falhas.length) process.exitCode = 1;
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

  console.log('\nLayout:');
  await checkIndents();
  await checkVerticalSpacing();
  await checkTableLineHeight();
  await checkMixedFontCells();
  await checkCodeBlocks();
  await checkCodeBlockWrap();
  await checkListMarkerOrphan();
  await checkTableBorder();
  await checkTableBordersInsidePage();

  console.log('\nTodas as configurações passaram.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});