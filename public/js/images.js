/* =========================================================
   Inserção de imagens nos editores de markdown

   Um único conjunto de funções atende à home, ao visualizador
   e ao conversor para PDF. A imagem é lida como Data URL
   (base64) e entra no texto como sintaxe markdown
   `![alt](data:image/...;base64,...)`, então aparece na
   pré-visualização e no PDF sem depender de hospedagem
   externa.

   Formas de inserir:
   - colar (Ctrl+V) com a imagem na área de transferência;
   - arrastar um arquivo de imagem para dentro da página
     (com overlay de área de soltar) — se o soltar cair sobre
     o editor, entra exatamente no ponto debaixo do mouse;
   - escolher o arquivo pelo botão de upload (file picker).
   ========================================================= */
(function () {
  'use strict';

  const MB = 1024 * 1024;

  /* A imagem viaja embutida no markdown (base64), então um arquivo
     grande infla o rascunho local e o corpo do pedido de PDF. O limite
     abaixo deixa fotos e capturas caberem confortavelmente. */
  const MAX_BYTES = 15 * MB;

  /* svg.fica de fora de propósito: um SVG embutido pode carregar script,
     e o higienizador do servidor também o recusa. */
  const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

  const MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
  };

  /** MIME de uma imagem: pelo tipo informado ou pela extensão do nome. */
  function mimeOf(file) {
    if (file && IMAGE_TYPE.test(file.type)) return file.type.toLowerCase();
    const ext = String((file && file.name) || '').replace(/^.*\./, '').toLowerCase();
    return MIME_BY_EXT[ext] || '';
  }

  function isImageFile(file) {
    return Boolean(file) && Boolean(mimeOf(file));
  }

  /** Arquivos de imagem presentes num DataTransfer (drop ou colagem). */
  function imageFiles(dataTransfer) {
    const files = [];
    if (!dataTransfer) return files;

    const candidates = [];
    // colagem de imagem costuma aparecer como item de arquivo
    if (dataTransfer.items && dataTransfer.items.length) {
      for (let i = 0; i < dataTransfer.items.length; i++) {
        const item = dataTransfer.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) candidates.push(file);
        }
      }
    }
    // drag-n-drop de arquivo clássico
    if (!candidates.length) {
      for (let i = 0; i < (dataTransfer.files || []).length; i++) {
        candidates.push(dataTransfer.files[i]);
      }
    }
    candidates.forEach((file) => {
      if (isImageFile(file)) files.push(file);
    });
    return files;
  }

  /**
   * Lê um arquivo de imagem como Data URL base64.
   * @returns {Promise<string>}
   */
  function dataUrlFor(file) {
    const mime = mimeOf(file);
    if (!mime) {
      return Promise.reject(new Error('Formato de imagem não suportado. Use PNG, JPG, GIF, WebP, AVIF ou BMP.'));
    }
    if (file.size > MAX_BYTES) {
      return Promise.reject(new Error('Imagem muito grande: o limite é 15 MB.'));
    }
    const blob = file.type === mime ? file : file.slice(0, file.size, mime);
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      reader.readAsDataURL(blob);
    });
  }

  /** Texto alternativo (alt) amigável a partir do nome do arquivo. */
  function altFor(name) {
    const alt = String(name || '')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[[\]()<>\n\\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return alt || 'imagem';
  }

  /** Sintaxe markdown da imagem com o conteúdo embutido em base64. */
  function markdownFor(file, dataUrl) {
    return '![' + altFor(file && file.name) + '](' + dataUrl + ')';
  }

  /**
   * Insere um texto num <textarea>. Sem `offset`, usa o cursor atual.
   * Dispara `input` para as páginas atualizarem pré-visualização e rascunho.
   */
  function insert(editor, text, offset) {
    let start = editor.selectionStart;
    let end = editor.selectionEnd;
    if (offset != null && Number.isFinite(offset)) {
      start = Math.max(0, Math.min(Math.round(offset), editor.value.length));
      end = start;
    }
    editor.setRangeText(text, start, end, 'end');
    editor.focus();
    // setRangeText já dispara input na maioria dos navegadores; o dispatch
    // manual garante a atualização do preview mesmo onde ele não dispara.
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Posição de texto no <textarea> correspondente a um ponto da tela.
   *
   * O navegador sabe desenhar o texto, inclusive com linhas quebradas,
   * então `caretPositionFromPoint`/`caretRangeFromPoint` devolvem o offset
   * exato. A estimativa por medidas de fonte é o plano B de navegadores
   * mais antigos.
   */
  function offsetFromPoint(editor, x, y) {
    const doc = editor.ownerDocument || document;

    if (typeof doc.caretPositionFromPoint === 'function') {
      try {
        const pos = doc.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode === editor && typeof pos.offset === 'number') {
          return Math.max(0, Math.min(pos.offset, editor.value.length));
        }
      } catch (err) { /* segue para a próxima tentativa */ }
    }
    if (typeof doc.caretRangeFromPoint === 'function') {
      try {
        const range = doc.caretRangeFromPoint(x, y);
        if (range && range.startContainer === editor) {
          return Math.max(0, Math.min(range.startOffset, editor.value.length));
        }
      } catch (err) { /* segue para a estimativa */ }
    }
    return estimateOffset(editor, x, y);
  }

  /** Fallback por geometria + largura de texto medida com canvas. */
  function estimateOffset(editor, x, y) {
    const rect = editor.getBoundingClientRect();
    const style = getComputedStyle(editor);
    const fontSize = parseFloat(style.fontSize) || 16;
    const lineHeight = parseFloat(style.lineHeight) || Math.round(fontSize * 1.5);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const innerWidth = Math.max(1, editor.clientWidth - padLeft - padRight);
    const value = editor.value;
    const lines = value.split('\n');
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = fontSize + 'px ' + style.fontFamily;

    const targetVisual = Math.max(0, Math.floor((y - rect.top - padTop) / lineHeight));
    const targetX = Math.max(0, x - rect.left - padLeft);

    let offset = 0;
    let visual = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineWidth = Math.max(1, context.measureText(line).width);
      const visualCount = Math.max(1, Math.ceil(lineWidth / innerWidth));
      if (visual + visualCount > targetVisual) {
        const which = targetVisual - visual; // linha visual dentro da lógica
        let char = 0;
        if (which === visualCount - 1) {
          let acc = 0;
          for (; char < line.length; char++) {
            acc += context.measureText(line[char]).width;
            if (acc > targetX) break;
          }
        } else {
          char = line.length;
        }
        return offset + clamp(char, 0, line.length);
      }
      visual += visualCount;
      offset += line.length + 1; // +1 pelo \n
    }
    return value.length;
  }

  /**
   * Offset para um ponto do mouse: mapeado para o texto quando o ponto cai
   * sobre o editor; `null` (cursor atual) caso contrário.
   */
  function insertOffset(editor, x, y) {
    const rect = editor.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return offsetFromPoint(editor, x, y);
    }
    return null;
  }

  /** Liga a colagem de imagem (Ctrl+V) num editor. */
  function onPaste(editor, handler) {
    editor.addEventListener('paste', (event) => {
      const files = imageFiles(event.clipboardData);
      if (!files.length) return; // colagem de texto segue o fluxo normal
      event.preventDefault();
      handler(files);
    });
  }

  /**
   * Liga arrastar-e-soltar de imagem para a página inteira.
   *
   * Enquanto um arquivo de imagem arrasta sobre a janela, o overlay mostra a
   * área de soltar. No `drop`, o handler recebe os arquivos e as coordenadas
   * do mouse; cada página decide o offset (ponto exato do editor ou o cursor).
   */
  function onScreenImageDrop(overlay, handler) {
    let depth = 0;
    const show = () => overlay && overlay.classList.add('is-visible');
    const hide = () => overlay && overlay.classList.remove('is-visible');

    window.addEventListener('dragenter', (event) => {
      if (!imageFiles(event.dataTransfer).length) return;
      event.preventDefault();
      depth += 1;
      show();
    });

    window.addEventListener('dragover', (event) => {
      if (!imageFiles(event.dataTransfer).length) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      show();
    });

    window.addEventListener('dragleave', () => {
      if (depth <= 0) return;
      depth -= 1;
      if (!depth) hide();
    });

    const reset = () => {
      depth = 0;
      hide();
    };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', (event) => {
      if (!imageFiles(event.dataTransfer).length) return;
      event.preventDefault();
      reset();
      handler(imageFiles(event.dataTransfer), event.clientX, event.clientY);
    });
  }

  window.MD.image = {
    MAX_BYTES,
    mimeOf,
    isImageFile,
    imageFiles,
    dataUrlFor,
    markdownFor,
    altFor,
    insert,
    offsetFromPoint,
    insertOffset,
    onPaste,
    onScreenImageDrop,
  };
})();