'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'data', 'biblioteca.json');
const MAX_ITEMS = 60;
const MAX_SIZE = 4 * 1024 * 1024;

/**
 * Biblioteca de documentos salvos em disco (JSON simples).
 * Não exige banco de dados: o objetivo é apenas persistir o que o
 * usuário salva para não perder trabalho ao fechar o navegador.
 */
const store = {
  file: FILE,

  ensure() {
    if (!fs.existsSync(path.dirname(FILE))) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
    }
    if (!fs.existsSync(FILE)) {
      fs.writeFileSync(FILE, '[]\n', 'utf8');
    }
  },

  read() {
    try {
      store.ensure();
      const raw = fs.readFileSync(FILE, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[biblioteca] leitura falhou:', err.message);
      return [];
    }
  },

  async write(items) {
    store.ensure();
    await fsp.writeFile(FILE, JSON.stringify(items.slice(0, MAX_ITEMS), null, 2), 'utf8');
  },

  /** Lista resumida (sem o conteúdo completo). */
  list() {
    return store
      .read()
      .map((item) => ({
        id: item.id,
        title: item.title,
        kind: item.kind,
        updatedAt: item.updatedAt,
        words: item.words || 0,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },

  get(id) {
    return store.read().find((item) => item.id === id) || null;
  },

  async save({ title, content, kind, settings }) {
    const items = store.read();
    const text = String(content == null ? '' : content);
    if (text.length > MAX_SIZE) {
      const error = new Error('Documento grande demais para salvar na biblioteca');
      error.status = 413;
      throw error;
    }

    const now = new Date().toISOString();
    const id = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 7);
    const item = {
      id,
      title: String(title || 'Sem título').slice(0, 120),
      kind: kind === 'pdf' ? 'pdf' : 'viewer',
      content: text,
      settings: settings && typeof settings === 'object' ? settings : null,
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      updatedAt: now,
    };

    items.unshift(item);
    await store.write(items);
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      updatedAt: item.updatedAt,
      words: item.words,
    };
  },

  async remove(id) {
    const items = store.read();
    const next = items.filter((item) => item.id !== id);
    await store.write(next);
    return next.length !== items.length;
  },
};

module.exports = { store };