/* =========================================================
   Visualizador em tela cheia
   ========================================================= */
(function () {
  'use strict';

  const {
    $, $$, debounce, toast, render, storage, handoff, draftText,
    downloadFile, pickFile, fileStem, guessTitle, api, isTyping, onKeys,
  } = window.MD;

  const DRAFT_KEY = 'md:draft:viewer';
  const PREFS_KEY = 'md:prefs:viewer';

  const stage = $('#stage');
  const doc = $('#doc');
  const source = $('#source');
  const drawer = $('#drawer');
  const backdrop = $('#drawer-backdrop');
  const toolbar = $('#toolbar');
  const outline = $('#outline');
  const outlineList = $('#outline-list');
  const hint = $('#stage-hint');
  const toastEl = $('#toast');

  const prefs = Object.assign(
    { zoom: 1, theme: 'escuro', outline: false },
    storage.get(PREFS_KEY, {})
  );

  let headings = [];
  let lastRequest = 0;

  /* ==========================================================
     Tema e zoom
     ========================================================== */

  function applyTheme() {
    if (prefs.theme === 'claro' || prefs.theme === 'sepia') {
      stage.dataset.theme = prefs.theme;
    } else {
      delete stage.dataset.theme;
    }
    $('#btn-theme').classList.toggle('is-on', prefs.theme !== 'escuro');
    savePrefs();
  }

  function cycleTheme() {
    const order = ['escuro', 'claro', 'sepia'];
    prefs.theme = order[(order.indexOf(prefs.theme) + 1) % order.length];
    applyTheme();
  }

  function applyZoom() {
    const zoom = Math.min(2.5, Math.max(0.6, prefs.zoom));
    doc.style.transform = 'scale(' + zoom + ')';
    doc.style.marginBottom = zoom > 1 ? (doc.offsetHeight * (zoom - 1)) + 'px' : '';
    $('#btn-zoom-reset').textContent = Math.round(zoom * 100) + '%';
    savePrefs();
  }

  function setZoom(value) {
    prefs.zoom = Math.min(2.5, Math.max(0.6, value));
    applyZoom();
  }

  function savePrefs() {
    storage.set(PREFS_KEY, prefs);
  }

  /* ==========================================================
     Renderização
     ========================================================== */

  async function update() {
    const markdown = source.value;
    const token = ++lastRequest;
    storage.set(DRAFT_KEY, markdown);

    try {
      const result = await render(markdown);
      if (token !== lastRequest) return;

      doc.innerHTML = result.html;
      headings = result.headings || [];
      buildOutline();
      updateStatus(result.stats);
      hint.hidden = Boolean(markdown.trim());
      updateProgress();
    } catch (err) {
      if (token === lastRequest) toast('Não foi possível renderizar: ' + err.message, 'error');
    }
  }

  const updateDebounced = debounce(update, 220);

  function updateStatus(stats) {
    if (!stats) return;
    $('#status-counts').textContent = stats.words + (stats.words === 1 ? ' palavra' : ' palavras');
    $('#drawer-count').textContent =
      stats.words + (stats.words === 1 ? ' palavra' : ' palavras') +
      ' · ' + stats.headings + ' títulos';
    $('#status-pages').textContent = '~' + Math.max(1, Math.ceil(stats.words / 250)) + ' min de leitura';
  }

  /* ==========================================================
     Sumário lateral
     ========================================================== */

  function buildOutline() {
    if (!headings.length) {
      outlineList.innerHTML = '<p class="muted">Sem títulos.</p>';
      return;
    }

    outlineList.innerHTML = headings
      .filter((h) => h.level <= 4)
      .map(
        (h) =>
          '<a href="#' + h.id + '" class="lv' + h.level + '" data-id="' + h.id + '">' +
          escapeHtml(h.text) + '</a>'
      )
      .join('');

    outlineList.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const target = document.getElementById(link.dataset.id);
        if (!target) return;
        stage.scrollTo({ top: target.offsetTop - 40, behavior: 'smooth' });
      });
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function highlightOutline() {
    const offset = stage.scrollTop + 120;
    let currentId = '';
    headings.forEach((h) => {
      const el = document.getElementById(h.id);
      if (el && el.offsetTop <= offset) currentId = h.id;
    });
    outlineList.querySelectorAll('a').forEach((link) => {
      link.classList.toggle('is-active', link.dataset.id === currentId);
    });
  }

  function updateProgress() {
    const max = stage.scrollHeight - stage.clientHeight;
    const ratio = max > 0 ? stage.scrollTop / max : 0;
    $('#progress i').style.width = Math.min(100, Math.max(0, ratio * 100)) + '%';
    hideToolbarSoon();
  }

  /* ==========================================================
     Gaveta do editor
     ========================================================== */

  function toggleDrawer(force) {
    const open = force !== undefined ? force : !drawer.classList.contains('is-open');
    drawer.classList.toggle('is-open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    backdrop.hidden = !open;
    $('#btn-toggle-editor').classList.toggle('is-on', open);
    if (open) {
      showToolbar();
      source.focus();
    } else {
      stage.focus();
    }
  }

  /* ==========================================================
     Ferramentas
     ========================================================== */

  async function saveToLibrary() {
    try {
      const response = await api('/api/library', {
        method: 'POST',
        body: JSON.stringify({
          title: guessTitle(source.value),
          content: source.value,
          kind: 'viewer',
        }),
      });
      const item = await response.json();
      toast('Salvo na biblioteca: ' + item.title);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openFile() {
    const file = await pickFile();
    if (!file) return;
    source.value = file.text;
    update();
    toast('Arquivo "' + file.name + '" aberto.');
  }

  function saveFile() {
    const name = fileStem(guessTitle(source.value), 'documento');
    downloadFile(name + '.md', source.value);
    toast('Baixado ' + name + '.md');
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  function toggleOutline() {
    prefs.outline = !prefs.outline;
    outline.classList.toggle('is-open', prefs.outline);
    outline.setAttribute('aria-hidden', String(!prefs.outline));
    $('#btn-outline').classList.toggle('is-on', prefs.outline);
    savePrefs();
  }

  /* Barra flutuante some quando o usuário rola a página. */
  let toolbarTimer = null;
  function hideToolbarSoon() {
    toolbar.classList.add('is-hidden');
  }
  function showToolbar() {
    toolbar.classList.remove('is-hidden');
    clearTimeout(toolbarTimer);
    toolbarTimer = setTimeout(hideToolbarSoon, 2600);
  }

  /* ==========================================================
     Atalhos
     ========================================================== */

  onKeys((event) => {
    const typing = isTyping(event.target);

    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      saveToLibrary();
      return;
    }

    if (event.key === 'Escape') {
      if (drawer.classList.contains('is-open')) toggleDrawer(false);
      else if (prefs.outline) toggleOutline();
      return;
    }

    if (typing) return;

    switch (event.key.toLowerCase()) {
      case 'e': toggleDrawer(); break;
      case 't': toggleOutline(); break;
      case 'f': toggleFullscreen(); break;
      case 'p': window.print(); break;
      case 'o': openFile(); break;
      case '+': case '=': setZoom(prefs.zoom + 0.1); break;
      case '-': setZoom(prefs.zoom - 0.1); break;
      case '0': setZoom(1); break;
      default: break;
    }

    if (event.key === 'ArrowRight') stage.scrollBy({ left: 0, top: 400, behavior: 'smooth' });
    if (event.key === 'ArrowLeft') stage.scrollBy({ top: -400, behavior: 'smooth' });
  });

  /* ==========================================================
     Ligações
     ========================================================== */

  source.addEventListener('input', updateDebounced);
  stage.addEventListener('scroll', debounce(() => { highlightOutline(); updateProgress(); }, 60));
  stage.addEventListener('mousemove', showToolbar);
  toolbar.addEventListener('mouseenter', showToolbar);

  $('#btn-toggle-editor').addEventListener('click', () => toggleDrawer());

  // A gaveta cobre o botão da barra, então precisa de formas próprias de sair.
  $('#btn-close-drawer').addEventListener('click', () => toggleDrawer(false));
  backdrop.addEventListener('click', () => toggleDrawer(false));
  $('#btn-zoom-in').addEventListener('click', () => setZoom(prefs.zoom + 0.1));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(prefs.zoom - 0.1));
  $('#btn-zoom-reset').addEventListener('click', () => setZoom(1));
  $('#btn-theme').addEventListener('click', cycleTheme);
  $('#btn-outline').addEventListener('click', toggleOutline);
  $('#btn-open').addEventListener('click', openFile);
  $('#btn-save-file').addEventListener('click', saveFile);
  $('#btn-save-library').addEventListener('click', saveToLibrary);
  $('#btn-print').addEventListener('click', () => window.print());
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);

  $('#btn-clear').addEventListener('click', () => {
    if (source.value && !window.confirm('Limpar o documento atual?')) return;
    source.value = '';
    update();
    source.focus();
  });

  $('#btn-format').addEventListener('click', () => {
    const value = source.value;
    if (!value.trim()) {
      source.value = '# Título\n\n';
    } else {
      source.value = value
        .split('\n')
        .map((line) => (line.startsWith('# ') ? line : line.replace(/^(\s*)([*-]|\d+\.)\s/g, '$1$2 ')))
        .join('\n');
    }
    update();
  });

  $$('.chip[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      storage.set(DRAFT_KEY, DEMO);
      source.value = DEMO;
      update();
      toast('Exemplo carregado.');
    });
  });

  $('#btn-to-pdf').addEventListener('click', () => {
    storage.set('md:draft:pdf', {
      markdown: source.value,
      title: guessTitle(source.value),
      at: Date.now(),
    });
    window.location.href = '/pdf';
  });

  /* ==========================================================
     Inserir imagem (colar Ctrl+V, arrastar-e-soltar ou upload)
     ========================================================== */

  const imageTools = window.MD.image;
  const imageInput = $('#img-input');

  /** Lê o arquivo em base64 e insere o markdown da imagem no editor. */
  async function insertImage(file, offset) {
    if (!file) return;
    try {
      const dataUrl = await imageTools.dataUrlFor(file);
      imageTools.insert(source, imageTools.markdownFor(file, dataUrl), offset);
      toast('Imagem "' + (file.name || '') + '" inserida.');
    } catch (err) {
      toast(err.message || 'Não foi possível inserir a imagem.', 'error');
    }
  }

  $('#btn-image').addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    imageInput.value = '';
    if (file) insertImage(file, null);
  });

  /* Ctrl+V com imagem na área de transferência entra no cursor. */
  imageTools.onPaste(source, (files) => insertImage(files[0], null));

  /* Arrastar para a página mostra a área de soltar. Se a gaveta do editor
     estava aberta e o soltar caiu sobre ela, a imagem entra no ponto do
     mouse; senão, abre a gaveta e insere no cursor. */
  imageTools.onScreenImageDrop($('#screen-drop'), (files, x, y) => {
    const wasClosed = !drawer.classList.contains('is-open');
    if (wasClosed) toggleDrawer(true);
    insertImage(files[0], wasClosed ? null : imageTools.insertOffset(source, x, y));
  });

  /* ==========================================================
     Inicialização
     ========================================================== */

  const DEMO = [
    '# Bem-vindo ao Visualizador',
    '',
    'Esta página mostra **apenas o documento renderizado**, em tela cheia.',
    'O editor fica escondido: abra a gaveta acima ou tecle **E**.',
    '',
    '## O que dá para fazer',
    '',
    '- Escrever e ver o resultado em tempo real',
    '- Trocar entre tema escuro, claro e sépia (**T** mostra o sumário)',
    '- Baixar o documento como `.md` ou salvar na biblioteca (**Ctrl+S**)',
    '- Levar o texto para o conversor de PDF',
    '',
    '```js',
    '// exemplo de código com realce',
    'const mensagem = "Olá, mundo!";',
    'console.log(mensagem.toUpperCase());',
    '```',
    '',
    '> Dica: use **Esc** para fechar o que estiver aberto.',
    '',
    '| Atalho | Ação |',
    '|:-------|:-----|',
    '| E | Abre o editor |',
    '| T | Mostra o sumário |',
    '| F | Tela cheia |',
    '| P | Imprimir |',
    '| + / − / 0 | Zoom |',
  ].join('\n');

  (async function init() {
    /* Preferência de tema salva. */
    applyTheme();
    applyZoom();
    toggleOutline();

    const params = new URLSearchParams(window.location.search);

    // Texto vindo da home tem prioridade; o rascunho local vem depois.
    const incoming = handoff.take('viewer');
    let initial = incoming ? incoming.markdown : draftText(DRAFT_KEY, '') || DEMO;

    const docId = params.get('doc');
    if (docId) {
      try {
        const item = await (await api('/api/library/' + encodeURIComponent(docId))).json();
        initial = item.content;
      } catch (err) {
        /* segue com o conteúdo padrão */
      }
    }

    source.value = initial;
    await update();
    showToolbar();
    void toastEl;
  })();
})();