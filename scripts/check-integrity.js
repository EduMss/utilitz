'use strict';
/**
 * Verifica o projeto inteiro em busca de:
 *  - bytes de controle / caracteres corrompidos
 *  - chaves CSS desbalanceadas
 *  - referências a arquivos que não existem no HTML
 * Uso: node scripts/check-integrity.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'vendor', 'package-lock.json']);
const TEXT = /\.(js|css|html|json|md|svg)$/i;

let problems = 0;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);

for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  // 1. bytes de controle inesperados ( CRLF e TAB são legítimos )
  const bad = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ok = code === 9 || code === 10 || code === 13 || code >= 32;
    if (!ok) bad.push({ i, code });
  }
  if (bad.length) {
    problems++;
    console.log('controle  ' + rel + ' -> ' + bad.slice(0, 5).map((b) => 'U+' + b.code.toString(16)).join(', '));
  }

  // 2. U+FFFD (substituto) indica decodificação errada
  if (text.includes('\ufffd')) {
    problems++;
    console.log('encoding ' + rel + ' -> ' + (text.match(/\ufffd/g) || []).length + ' caractere(s) de substituição');
  }

  // 3. chaves CSS balanceadas
  if (/\.css$/i.test(rel)) {
    const open = (text.match(/\{/g) || []).length;
    const close = (text.match(/\}/g) || []).length;
    if (open !== close) {
      problems++;
      console.log('css       ' + rel + ' -> { ' + open + ' x } ' + close);
    }
  }

  // 4. assets referenciados nas views existem em public/
  if (/src[\\/]views[\\/].*\.js$/i.test(rel.replace(/\\/g, '/'))) {
    for (const m of text.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
      const url = m[1];
      if (url.startsWith('/api')) continue;
      // URLs de página (/, /pdf, /visualizar) não são arquivos estáticos
      if (!/\.[a-z0-9]{2,5}$/i.test(url.split('?')[0])) continue;
      const target = path.join(ROOT, 'public', url.replace(/^\//, ''));
      if (!fs.existsSync(target)) {
        problems++;
        console.log('asset     ' + rel + ' -> falta ' + url);
      }
    }
  }
}

console.log('\n' + files.length + ' arquivos verificados, ' + problems + ' problema(s)\n');
process.exit(problems ? 1 : 0);