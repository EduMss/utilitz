'use strict';
/**
 * Testes do núcleo de formatação da página /formatar.
 *
 * O núcleo mora em public/js/format-core.js de propósito: é o mesmo código
 * que roda no navegador, então os testes exercem o que a pessoa realmente
 * vê na tela. Confere também o bundle do highlight.js gerado para o
 * navegador, já que sem ele a prévia sai sem cor.
 *
 * Uso: node scripts/test-format.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const Format = require('../public/js/format-core.js');

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

/** Formata com uma família forçada e devolve o resultado. */
function run(text, type, options) {
  return Format.format(text, Object.assign({ type }, options || {}));
}

console.log('\n== formatação ==');

/* ---------------------------------------------------------- *
 * JSON
 * ---------------------------------------------------------- */
check('JSON de uma linha só vira várias linhas', () => {
  const result = run('{"a":1,"b":[2,3],"c":{"d":"x"}}', 'json', { indent: '2' });
  assert.strictEqual(result.error, null, 'não deveria ter erro');
  assert.ok(result.changed, 'o texto deveria mudar');
  assert.strictEqual(
    result.text,
    '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ],\n  "c": {\n    "d": "x"\n  }\n}'
  );
});

check('JSON formatado é idempotente', () => {
  const first = run('{"a":[1,2]}', 'json', { indent: '4' });
  const second = run(first.text, 'json', { indent: '4' });
  assert.strictEqual(second.text, first.text);
  assert.strictEqual(second.changed, false, 'a segunda passada não deveria mudar nada');
});

check('JSON recuado com tabulação sai com tabulação', () => {
  const result = run('{"a":{"b":1}}', 'json', { indent: 'tab' });
  assert.strictEqual(result.text, '{\n\t"a": {\n\t\t"b": 1\n\t}\n}');
});

check('JSON inválido aponta linha e coluna e mantém o original', () => {
  const source = '{\n  "nome": "Ana",\n  "idade": ,\n}';
  const result = run(source, 'json');
  assert.ok(result.error, 'deveria reportar o erro');
  assert.strictEqual(result.error.line, 3);
  assert.strictEqual(result.error.column, 12);
  assert.strictEqual(result.text, source, 'o texto original fica intacto');
  assert.strictEqual(result.changed, false);
});

check('JSON com BOM é aceito', () => {
  const result = run('\uFEFF{"a":1}', 'json', { indent: '2' });
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.text, '{\n  "a": 1\n}');
});

check('JSON: remover 1 nível de escape desembrulha o texto', () => {
  const result = run('{\\"nome\\":\\"Ana\\",\\"ativo\\":true}', 'json', {
    removeEscapes: true, indent: '2',
  });
  assert.strictEqual(result.error, null, 'deveria virar JSON válido');
  assert.strictEqual(result.text, '{\n  "nome": "Ana",\n  "ativo": true\n}');
});

check('JSON: remover 1 nível de escape abre a string que envolve o JSON', () => {
  const result = run('"{\\"a\\":[1,2]}"', 'json', { removeEscapes: true, indent: '2' });
  assert.strictEqual(result.error, null, 'deveria virar JSON válido');
  assert.strictEqual(result.text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
});

check('JSON: remove só um nível — barra dobrada vira barra simples', () => {
  const result = run('{\\"a\\": \\"x\\\\ny\\"}', 'json', { removeEscapes: true, indent: '2' });
  assert.strictEqual(result.error, null, 'o resultado ainda é JSON válido');
  assert.strictEqual(result.text, '{\n  "a": "x\\ny"\n}');
});

check('JSON escapado sem a opção continua dando erro', () => {
  const source = '{\\"a\\":1}';
  const result = run(source, 'json');
  assert.ok(result.error, 'sem a opção o texto escapado não é JSON');
  assert.strictEqual(result.text, source, 'o original fica intacto');
});

check('JSON: a opção não mexe em JSON que já é válido', () => {
  const result = run('{"caminho":"C:\\\\tmp\\\\x"}', 'json', { removeEscapes: true, indent: '2' });
  assert.strictEqual(result.error, null);
  assert.strictEqual(result.text, '{\n  "caminho": "C:\\\\tmp\\\\x"\n}');
});

check('JSON: sem virar JSON, mantém o texto sem escape e aponta o erro', () => {
  const result = run('"só uma frase"', 'json', { removeEscapes: true });
  assert.ok(result.error, 'o valor não é um documento JSON');
  assert.strictEqual(result.text, 'só uma frase');
  assert.strictEqual(result.changed, true);
});

/* ---------------------------------------------------------- *
 * XML / HTML
 * ---------------------------------------------------------- */
check('XML de uma linha só ganha uma tag por linha', () => {
  const result = run(
    '<agenda><pessoa nome="Ana"><fone>11 1</fone></pessoa><pessoa nome="Bia"/></agenda>',
    'xml',
    { indent: '2' }
  );
  assert.strictEqual(
    result.text,
    '<agenda>\n  <pessoa nome="Ana">\n    <fone>11 1</fone>\n  </pessoa>\n' +
      '  <pessoa nome="Bia" />\n</agenda>'
  );
});

check('HTML mantém texto curto junto da tag', () => {
  const result = run('<div><p>Olá <b>mundo</b></p><p>Fim</p></div>', 'html', { indent: '2' });
  assert.strictEqual(
    result.text,
    '<div>\n  <p>Olá <b>mundo</b></p>\n  <p>Fim</p>\n</div>'
  );
});

check('HTML não recua o conteúdo de <pre>', () => {
  const source = '<pre>\n  um\n    dois\n</pre>';
  const result = run(source, 'html', { indent: '2' });
  assert.ok(result.text.indexOf('\n  um\n    dois\n') >= 0, 'o conteúdo do pre deve ficar como estava');
});

check('HTML sem par é fechado no fim sem perder a raiz', () => {
  const result = run('<ul><li>um<li>dois', 'html', { indent: '2' });
  assert.ok(result.text.indexOf('<li>um</li>') >= 0, result.text);
  assert.ok(result.text.indexOf('<li>dois</li>') >= 0, result.text);
});

check('XML deixa comentários e prólogo em linha própria', () => {
  const result = run('<?xml version="1.0"?><!-- nota --><a><b>x</b></a>', 'xml', { indent: '2' });
  assert.strictEqual(result.text, '<?xml version="1.0"?>\n<!-- nota -->\n<a>\n  <b>x</b>\n</a>');
});

check('XML: remover 1 nível de escape desembrulha o texto', () => {
  const result = run('<agenda>\\n<pessoa nome=\\"Ana\\"/>\\n</agenda>', 'xml', {
    removeEscapes: true, indent: '2',
  });
  assert.strictEqual(result.error, null, 'não deveria ter erro');
  assert.strictEqual(result.text, '<agenda>\n  <pessoa nome="Ana" />\n</agenda>');
});

check('XML: remover 1 nível de escape abre a string que envolve o XML', () => {
  const result = run('"<agenda>\\n<pessoa nome=\\"Ana\\"/>\\n</agenda>"', 'xml', {
    removeEscapes: true, indent: '2',
  });
  assert.strictEqual(result.error, null, 'não deveria ter erro');
  assert.strictEqual(result.text, '<agenda>\n  <pessoa nome="Ana" />\n</agenda>');
});

check('XML escapado sem a opção mantém o texto escapado', () => {
  const result = run('<agenda>\\n<pessoa/>\\n</agenda>', 'xml', { indent: '2' });
  assert.ok(result.text.indexOf('\\n') >= 0, 'o \\n literal deveria continuar no lugar');
});

check('HTML: a opção de remover escape não mexe nele', () => {
  const result = run('<div>\\n<span>a</span>\\n</div>', 'html', { removeEscapes: true, indent: '2' });
  assert.strictEqual(result.changed, false, 'o HTML não tem remoção de escape');
});

/* ---------------------------------------------------------- *
 * Markdown
 * ---------------------------------------------------------- */
check('Markdown arruma títulos, listas e linhas em branco', () => {
  const source = '#Titulo   \n\n\n\n* item\n1) outro\n';
  const result = run(source, 'markdown');
  assert.strictEqual(result.text, '# Titulo\n\n- item\n1. outro');
});

check('Markdown converte título setext em ATX', () => {
  const result = run('Título\n======\n\nSegundo\n------\n', 'markdown');
  assert.strictEqual(result.text, '# Título\n\n## Segundo');
});

check('Markdown preserva o conteúdo dentro das cercas de código', () => {
  const source = '```python\n*nao mexer*   \n# comentario\n```\n';
  const result = run(source, 'markdown');
  assert.strictEqual(result.text, '```python\n*nao mexer*   \n# comentario\n```');
});

check('Markdown não confunde o front matter com título', () => {
  const source = '---\ntitle: Doc\n---\n\n# Depois\n';
  const result = run(source, 'markdown');
  assert.strictEqual(result.text, '---\ntitle: Doc\n---\n\n# Depois');
});

check('Markdown deixa o título cercado de linha em branco', () => {
  const result = run('texto\n# Título\nmais texto\n', 'markdown');
  assert.strictEqual(result.text, 'texto\n\n# Título\n\nmais texto');
});

check('Markdown mantém a quebra dura de duas linhas', () => {
  const result = run('linha um  \nlinha dois\n', 'markdown');
  assert.strictEqual(result.text, 'linha um  \nlinha dois');
});

/* ---------------------------------------------------------- *
 * Texto
 * ---------------------------------------------------------- */
check('Texto: \\n literal só vira quebra quando a opção está ligada', () => {
  const source = 'um\\ndois\\ntres';
  const off = run(source, 'text');
  assert.strictEqual(off.text, 'um\\ndois\\ntres');
  assert.strictEqual(off.changed, false);

  const on = run(source, 'text', { unescapeNewlines: true });
  assert.strictEqual(on.text, 'um\ndois\ntres');
});

check('Texto: \\r\\n literal não deixa um \\r solto', () => {
  const result = run('um\\r\\ndois', 'text', { unescapeNewlines: true });
  assert.strictEqual(result.text, 'um\ndois');
});

check('Texto limpa fim de linha e junta linhas vazias', () => {
  const result = run('a   \n\n\n\nb   \n', 'text');
  assert.strictEqual(result.text, 'a\n\nb');
});

check('Texto: virar string de uma linha escapa quebras e aspas', () => {
  const result = run('a: "x"\nb: c', 'text', { escapeToOneLine: true });
  assert.strictEqual(result.text, 'a: \\"x\\"\\nb: c');
  assert.strictEqual(result.text.indexOf('\n'), -1, 'nada de quebra de linha real');
});

check('Texto: virar string de uma linha escapa barra invertida e tabulação', () => {
  const result = run('c:\\nova\tpasta', 'text', { escapeToOneLine: true });
  assert.strictEqual(result.text, 'c:\\\\nova\\tpasta');
  assert.strictEqual(result.text.indexOf('\n'), -1);
});

check('Texto: a limpeza acontece antes de virar string', () => {
  const result = run('fim   \noutro', 'text', { escapeToOneLine: true });
  assert.strictEqual(result.text, 'fim\\noutro');
});

check('Texto: as duas opções juntas ainda saem em uma linha só', () => {
  const result = run('um\\ndois', 'text', { unescapeNewlines: true, escapeToOneLine: true });
  assert.strictEqual(result.text, 'um\\ndois');
  assert.strictEqual(result.text.indexOf('\n'), -1);
});

/* ---------------------------------------------------------- *
 * CSV
 * ---------------------------------------------------------- */
check('CSV vira tabela markdown com as colunas alinhadas', () => {
  const result = run('nome;idade\nAna;30\nBruno;220\n', 'csv');
  assert.strictEqual(
    result.text,
    '| nome  | idade |\n| ----- | ----- |\n| Ana   | 30    |\n| Bruno | 220   |'
  );
});

check('CSV respeita aspas com o delimitador por dentro', () => {
  const result = run('a;b\n"x;y";2\n', 'csv');
  assert.ok(result.text.indexOf('| x;y') >= 0, result.text);
  assert.strictEqual(result.warnings.length, 0, result.warnings.join(', '));
});

check('CSV avisa quando uma linha tem outra quantidade de colunas', () => {
  const result = run('a;b;c\n1;2;3\n4;5\n', 'csv');
  assert.ok(result.warnings.some((w) => w.indexOf('Linha 3') >= 0), result.warnings.join(' | '));
});

check('CSV sem coluna nenhuma explica o problema', () => {
  const result = run('só um texto qualquer\noutra linha sem separador\nmais uma linha\n', 'csv');
  assert.ok(result.error, 'deveria dar erro');
  assert.ok(/CSV/.test(result.error.message), result.error.message);
});

/* ---------------------------------------------------------- *
 * Código
 * ---------------------------------------------------------- */
check('Código: tabs viram espaços, CRLF vira LF e o fim da linha limpa', () => {
  const source = 'def foo():\r\n\tif x:\r\n\t\treturn 1   \r\n';
  const result = run(source, 'python', { indent: '4' });
  assert.strictEqual(result.text, 'def foo():\n    if x:\n        return 1\n');
  assert.ok(result.text.indexOf('\r') === -1);
  assert.ok(result.text.indexOf('\t') === -1);
});

check('Código: recuo recalculado arredonda para a unidade', () => {
  const source = 'if (x) {\n   y();\n      z();\n}';
  const result = run(source, 'c', { indent: '4', reindent: true });
  assert.strictEqual(result.text, 'if (x) {\n    y();\n    z();\n}');
});

check('Código sem a opção de recalcular mantém os níveis', () => {
  const source = 'if (x) {\n   y();\n}';
  const result = run(source, 'c', { indent: '4' });
  assert.strictEqual(result.text, source);
});

check('A opção de outra família é ignorada', () => {
  const source = '```py\n\tindented = 1\n```';
  const result = run(source, 'markdown', { indent: 'tab', reindent: true, unescapeNewlines: true });
  assert.strictEqual(result.text, source, 'o markdown não deve sofrer conversão de recuo');

  const json = run('{"a": 1}', 'json', { escapeToOneLine: true });
  assert.strictEqual(json.text, '{\n  "a": 1\n}', 'a virada de string não mexe no JSON');

  const text = run('a: "x"', 'text', { removeEscapes: true });
  assert.strictEqual(text.text, 'a: "x"', 'a remoção de escape não mexe no texto');
});

/* ---------------------------------------------------------- *
 * Detecção
 * ---------------------------------------------------------- */
check('Detecção usa a extensão do arquivo', () => {
  const cases = [
    ['dados.json', 'json'],
    ['pagina.html', 'html'],
    ['leia-me.md', 'markdown'],
    ['tabela.csv', 'csv'],
    ['notas.txt', 'text'],
    ['app.py', 'python'],
    ['Program.cs', 'csharp'],
    ['Main.java', 'java'],
    ['server.js', 'javascript'],
    ['Dockerfile', 'shell'],
    ['Makefile', 'makefile'],
  ];
  for (const [name, expected] of cases) {
    const result = Format.format('', { type: 'auto', filename: name });
    assert.strictEqual(result.type, expected, name + ' detectou ' + result.type);
  }
});

check('Detecção cai para o conteúdo quando a extensão não ajuda', () => {
  const cases = [
    ['{"a": 1}', 'json'],
    ['<?xml version="1.0"?><a/>', 'xml'],
    ['<!DOCTYPE html><html><body></body></html>', 'html'],
    ['# Título\n\ntexto\n', 'markdown'],
    ['a,b,c\n1,2,3\n4,5,6\n', 'csv'],
    ['def foo():\n    return 1\n', 'python'],
    ['using System;\nnamespace App { }\n', 'csharp'],
    ['Anotações da reunião de terça.\nFalamos do prazo.\n', 'text'],
  ];
  for (const [text, expected] of cases) {
    const result = Format.format(text, { type: 'auto' });
    assert.strictEqual(result.type, expected, JSON.stringify(text.slice(0, 30)) + ' detectou ' + result.type);
  }
});

check('Detecção de conteúdo explica o motivo', () => {
  const result = Format.format('{"a":1}', { type: 'auto' });
  assert.ok(result.reason, 'deveria ter motivo');
  assert.ok(result.label === 'JSON', result.label);
});

check('Arquivo vazio é texto e não quebra', () => {
  const result = Format.format('', { type: 'auto' });
  assert.strictEqual(result.type, 'text');
  assert.strictEqual(result.text, '');
  assert.strictEqual(result.changed, false);
});

check('O catálogo não tem valor repetido', () => {
  const values = Format.CATALOG.map((item) => item.value);
  assert.strictEqual(new Set(values).size, values.length, 'valores repetidos');
  for (const item of Format.CATALOG) {
    assert.ok(item.label, 'rótulo vazio em ' + item.value);
    assert.ok(Format.languageOf(item.value), 'linguagem vazia em ' + item.value);
  }
});

/* ---------------------------------------------------------- *
 * Bundle do highlight.js usado pela prévia
 * ---------------------------------------------------------- */
check('public/vendor/hljs.js existe e colore código', () => {
  const file = path.join(ROOT, 'public', 'vendor', 'hljs.js');
  assert.ok(fs.existsSync(file), 'rode: node scripts/build-hljs.js');

  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: 'hljs.js' });

  const hljs = context.window.hljs;
  assert.ok(hljs && typeof hljs.highlight === 'function', 'window.hljs não foi definido');

  const python = hljs.highlight('def foo():', { language: 'python' }).value;
  assert.ok(python.indexOf('hljs-keyword') >= 0, 'sem classe de destaque: ' + python);

  for (const language of ['json', 'xml', 'markdown', 'csharp', 'java', 'python', 'plaintext']) {
    assert.ok(hljs.getLanguage(language), 'linguagem ausente: ' + language);
  }
});

console.log('\n' + pass + ' verificação(ões) ok, ' + failures.length + ' falha(s)\n');
process.exit(failures.length ? 1 : 0);
