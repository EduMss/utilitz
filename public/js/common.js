/* =========================================================
   Utilitários compartilhados por todas as páginas
   ========================================================= */
(function (global) {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));

  function debounce(fn, wait) {
    let timer = null;
    return function debounced() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  let toastTimer = null;
  function toast(message, type) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', type === 'error');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ---------------------------------------------------------
     Chamadas ao servidor
     --------------------------------------------------------- */
  async function api(path, options) {
    const response = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, options));

    if (!response.ok) {
      let message = 'Erro ' + response.status;
      try {
        const data = await response.json();
        if (data && data.error) message = data.error;
      } catch (err) {
        /* resposta sem JSON */
      }
      throw new Error(message);
    }
    return response;
  }

  const render = (markdown, options) =>
    api('/api/render', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ markdown }, options || {})),
    }).then((r) => r.json());

  /* ---------------------------------------------------------
     Armazenamento local (rascunho das páginas)
     --------------------------------------------------------- */
  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        /* modo privado / cota cheia */
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (err) { /* ignore */ }
    },
  };

  /* ---------------------------------------------------------
     Arquivos .md
     --------------------------------------------------------- */
  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = $('#file-input');
      if (!input) return resolve(null);
      input.value = '';
      if (accept) input.accept = accept;
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, text: String(reader.result || '') });
        reader.onerror = () => resolve(null);
        reader.readAsText(file, 'utf-8');
      };
      input.click();
    });
  }

  function fileStem(name, fallback) {
    return String(name || '')
      .replace(/\.(md|markdown|txt)$/i, '')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .slice(0, 60) || fallback || 'documento';
  }

  /** Título provável de um markdown (front matter, 1º H1 ou 1ª linha). */
  function guessTitle(markdown) {
    const text = String(markdown || '');
    const front = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (front) {
      const title = front[1].match(/^title\s*:\s*(.+)$/m);
      if (title) return title[1].trim().replace(/^["']|["']$/g, '');
    }
    const heading = text.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].replace(/[*_`#]/g, '').trim();
    const first = text.trim().split('\n')[0];
    return (first || 'Sem título').slice(0, 80);
  }

  /* ---------------------------------------------------------
     Passagem de texto entre as páginas

     A home não pode gravar direto em `md:draft:viewer` / `md:draft:pdf`:
     essas chaves pertencem ao rascunho de cada ferramenta, que guarda uma
     string. A home precisa mandar um objeto com título e texto, e esse
     objeto fica numa chave à parte, consumida uma única vez.
     --------------------------------------------------------- */
  const HANDOFF_KEY = 'md:handoff';

  const handoff = {
    /** Deixa um texto pronto para a ferramenta `target` ('viewer' ou 'pdf'). */
    send(target, markdown, title) {
      storage.set(HANDOFF_KEY, {
        target,
        markdown: String(markdown == null ? '' : markdown),
        title: title ? String(title) : '',
        at: Date.now(),
      });
    },

    /** Consome o texto deixado para `target`, se houver. Remove da fila. */
    take(target) {
      const data = storage.get(HANDOFF_KEY, null);
      if (!data || typeof data !== 'object' || data.target !== target) return null;
      storage.remove(HANDOFF_KEY);
      return data;
    },
  };

  /**
   * Lê um rascunho de texto. Tudo que não for string é descartado: versões
   * antigas gravavam objetos nessa chave e o texto virava "[object Object]".
   */
  function draftText(key, fallback) {
    const value = storage.get(key, null);
    return typeof value === 'string' ? value : fallback || '';
  }

  /* ---------------------------------------------------------
     Atalhos de teclado
     --------------------------------------------------------- */
  function isTyping(element) {
    if (!element) return false;
    const tag = element.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT' || element.isContentEditable;
  }

  function onKeys(handler) {
    document.addEventListener('keydown', (event) => {
      handler(event);
    });
  }

  global.MD = {
    $, $$, debounce, toast, api, render,
    storage, handoff, draftText, downloadFile, pickFile, fileStem, guessTitle, isTyping, onKeys,
    shared: global.MDShared,
  };
})(window);