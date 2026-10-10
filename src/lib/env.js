'use strict';

/**
 * Leitor mínimo de `.env`.
 *
 * O projeto não depende de nenhum pacote para isto e quer continuar assim:
 * um arquivo `KEY=value` por linha é suficiente para as chaves do app. As
 * variáveis já presentes no ambiente (Docker, shell, CI) sempre ganham, para
 * que o `.env` não sobrescreva quem configurou de fora.
 */

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');

/** Remove aspas simples ou duplas ao redor do valor. */
function unquote(value) {
  const text = value.trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Carrega o `.env` para `process.env` sem sobrescrever o que já existe.
 * @param {string} [file] caminho do arquivo (padrão: `.env` na raiz)
 * @returns {boolean} true quando o arquivo foi lido
 */
function loadEnv(file = ENV_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return false;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    process.env[key] = unquote(trimmed.slice(eq + 1));
  }

  return true;
}

module.exports = { loadEnv, ENV_FILE };
