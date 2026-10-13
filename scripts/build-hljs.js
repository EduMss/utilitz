'use strict';
/**
 * Monta o highlight.js para o navegador em `public/vendor/hljs.js`.
 *
 * O projeto já depende do highlight.js no servidor (realce de código do
 * markdown), mas o pacote npm só publica CommonJS. A página de formatação
 * colore o código no navegador, então os módulos precisam virar um único
 * arquivo estático — do mesmo jeito que `public/vendor/paged.js` é um bundle
 * versionado do Paged.js.
 *
 * O bundler aqui é propositalmente pequeno: cada módulo vira uma função com
 * `module`, `exports` e um `require` que resolve por id dentro do registro.
 * Não há minificação nem transformação de sintaxe — o código do highlight.js
 * entra como está, apenas com os `require('...')` reescritos.
 *
 * Uso: node scripts/build-hljs.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG = path.join(ROOT, 'node_modules', 'highlight.js', 'package.json');
const ENTRY = path.join(ROOT, 'node_modules', 'highlight.js', 'lib', 'common.js');
const BASE = path.dirname(ENTRY);
const OUT = path.join(ROOT, 'public', 'vendor', 'hljs.js');

const REQUIRE_RE = /require\(\s*(['"])([^'"]+)\1\s*\)/g;

function fail(message) {
  console.error('[build-hljs] ' + message);
  process.exit(1);
}

/** Caminho do módulo em relação a `lib/`, com `/` (independe do sistema). */
function idOf(file) {
  return path.relative(BASE, file).split(path.sep).join('/');
}

/** Resolve um `require(spec)` partindo do arquivo que o chamou. */
function resolve(from, spec) {
  if (!spec.startsWith('.')) {
    fail('require sem caminho relativo: ' + spec + ' (em ' + idOf(from) + ')');
  }
  let target = path.resolve(path.dirname(from), spec);
  if (!fs.existsSync(target) && fs.existsSync(target + '.js')) target += '.js';
  if (!fs.existsSync(target)) {
    fail('não encontrei ' + spec + ' (resolvido em ' + target + ')');
  }
  return target;
}

const modules = new Map();

/** Percorre o grafo a partir da entrada e guarda a fonte de cada módulo. */
function collect(file) {
  const id = idOf(file);
  if (modules.has(id)) return id;

  const source = fs.readFileSync(file, 'utf8');
  /* registro antes de descer: um ciclo devolve o id e o loader resolve na hora */
  modules.set(id, { id, source });

  REQUIRE_RE.lastIndex = 0;
  let match;
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    collect(resolve(file, match[2]));
  }

  return id;
}

/** Troca cada `require('<relativo>')` pelo id equivalente no registro. */
function rewrite(entry) {
  REQUIRE_RE.lastIndex = 0;
  return entry.source.replace(REQUIRE_RE, (full, _quote, spec) => {
    const target = resolve(path.join(BASE, entry.id), spec);
    return 'require(' + JSON.stringify(idOf(target)) + ')';
  });
}

function build() {
  if (!fs.existsSync(ENTRY)) fail('highlight.js não instalado (falta ' + ENTRY + ')');
  const version = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;

  const entryId = collect(ENTRY);
  const ids = Array.from(modules.keys()).sort();

  const body = ids
    .map((id) => {
      const entry = modules.get(id);
      return '    ' + JSON.stringify(id) + ': function (module, exports, require) {\n' +
        rewrite(entry) +
        '\n    }';
    })
    .join(',\n');

  const banner =
    '/* highlight.js v' + version + ' (conjunto common) — arquivo gerado.\n' +
    '   Não edite à mão: rode `node scripts/build-hljs.js` para reconstruir.\n' +
    '   Origem: node_modules/highlight.js/lib/common.js */\n';

  const output =
    banner +
    '(function (global) {\n' +
    "  'use strict';\n" +
    '  var registry = {\n' +
    body +
    '\n  };\n' +
    '  var cache = {};\n' +
    '  function load(id) {\n' +
    '    if (cache[id]) return cache[id].exports;\n' +
    '    var factory = registry[id];\n' +
    "    if (!factory) throw new Error('módulo desconhecido: ' + id);\n" +
    '    var module = { exports: {} };\n' +
    '    cache[id] = module;\n' +
    '    factory(module, module.exports, load);\n' +
    '    return module.exports;\n' +
    '  }\n' +
    '  global.hljs = load(' + JSON.stringify(entryId) + ');\n' +
    "})(typeof window !== 'undefined' ? window : this);\n";

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output, 'utf8');

  const kb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(0);
  console.log(
    '[build-hljs] highlight.js v' + version + ' → ' +
    path.relative(ROOT, OUT).replace(/\\/g, '/') + ' (' + ids.length +
    ' módulos, ' + kb + ' KB)'
  );
}

build();
