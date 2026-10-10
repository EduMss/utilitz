/* =========================================================
   Página inicial
   ========================================================= */
(function () {
  'use strict';

  const { $, $$, storage, toast, guessTitle, api, handoff } = window.MD;

  const DRAFT_KEY = 'md:draft:shared';
  const source = $('#home-source');

  /* ------------------------------------------------------------
     Rascunho compartilhado com as outras páginas
     ------------------------------------------------------------ */
  source.value = storage.get(DRAFT_KEY, '');

  const save = window.MD.debounce(() => storage.set(DRAFT_KEY, source.value), 300);
  source.addEventListener('input', save);

  /* ------------------------------------------------------------
     Inserir imagem (colar Ctrl+V, arrastar-e-soltar ou upload)
     ------------------------------------------------------------ */
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

  /* Arrastar para a página mostra a área de soltar; no editor, a imagem
     entra exatamente no ponto do mouse. */
  imageTools.onScreenImageDrop($('#screen-drop'), (files, x, y) => {
    insertImage(files[0], imageTools.insertOffset(source, x, y));
  });

  /* ------------------------------------------------------------
     Exemplos
     ------------------------------------------------------------ */
  const EXAMPLES = [
    {
      title: 'Artigo',
      text: [
        '# Anatomia de um bom texto',
        '',
        'Escrever bem é, antes de tudo, **enxugar**. Este documento reúne alguns',
        'princípios que valem para qualquer texto técnico.',
        '',
        '## Princípio 1: corte tudo que não sustenta a ideia',
        '',
        '> Se uma frase não acrescenta nada, ela é ruído.',
        '',
        '## Princípio 2: varie a estrutura',
        '',
        '- Frases curtas para bater o ponto.',
        '- Frases longas para construir a cena.',
        '- Listas quando a ordem importa.',
        '',
        '| Sinal | O que costuma indicar |',
        '|:------|:---------------------|',
        '| Muita vírgula | Parágrafo pesado |',
        '| Muitos "a" | Run-on sentence |',
        '',
        '```js',
        'const texto = ["corte", "varie", "clareza"];',
        'console.log(texto.join(" → "));',
        '```',
        '',
        '## Princípio 3: releia em voz alta',
        '',
        'Se você tropeça lendo, o leitor também tropeça.',
      ].join('\n'),
    },
    {
      title: 'Documento técnico',
      text: [
        '# API de exemplo',
        '',
        '## Autenticação',
        '',
        'Envie o token no cabeçalho:',
        '',
        '```bash',
        'curl -H "Authorization: Bearer TOKEN" https://api.exemplo.com/v1/usuarios',
        '```',
        '',
        '### Resposta',
        '',
        '```json',
        '{ "id": 42, "nome": "Maria", "ativo": true }',
        '```',
        '',
        '1. Valide o token.',
        '2. Processe a requisição.',
        '3. Devolva JSON com status 200.',
        '',
        '| Código | Significado |',
        '|:------:|:------------|',
        '| 200    | Sucesso     |',
        '| 401    | Sem token   |',
        '',
        '> Erros sempre retornam `{ "erro": "mensagem" }`.',
      ].join('\n'),
    },
  ];

  $$('.chip[data-sample]').forEach((button) => {
    button.addEventListener('click', () => {
      const example = EXAMPLES[Number(button.dataset.sample)];
      if (!example) return;
      source.value = example.text;
      storage.set(DRAFT_KEY, example.text);
      source.focus();
    });
  });

  /* ------------------------------------------------------------
     Navegação para as subpáginas
     ------------------------------------------------------------ */
  function go(target) {
    const text = source.value.trim();
    if (!text) {
      toast('Escreva algo antes de continuar.');
      source.focus();
      return;
    }
    storage.set(DRAFT_KEY, source.value);
    // texto vai para a ferramenta escolhida; cada página consome uma vez só
    handoff.send(target, source.value, guessTitle(source.value));
    window.location.href = target === 'viewer' ? '/visualizar' : '/pdf';
  }

  $$('[data-go]').forEach((button) => {
    button.addEventListener('click', () => go(button.dataset.go));
  });

  /* ------------------------------------------------------------
     Biblioteca
     ------------------------------------------------------------ */
  const list = $('#library-list');

  function when(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'agora mesmo';
    if (minutes < 60) return 'há ' + minutes + ' min';
    if (minutes < 60 * 24) return 'há ' + Math.round(minutes / 60) + ' h';
    return date.toLocaleDateString('pt-BR');
  }

  async function loadLibrary() {
    try {
      const response = await api('/api/library');
      const items = await response.json();

      if (!items.length) {
        list.innerHTML = '<p class="empty">Nada salvo ainda. Use o botão de disfarce (🔖) nas páginas de visualização ou de PDF.</p>';
        return;
      }

      list.innerHTML = items
        .map(
          (item) => `
        <div class="library-item">
          <span class="li-badge">${item.kind === 'pdf' ? 'PDF' : 'Tela'}</span>
          <div class="li-main">
            <div class="li-title">${escape(item.title)}</div>
            <div class="li-meta">${item.words} palavras · ${when(item.updatedAt)}</div>
          </div>
          <a class="chip" href="/${item.kind === 'pdf' ? 'pdf' : 'visualizar'}?doc=${encodeURIComponent(item.id)}">Abrir</a>
          <button type="button" class="icon-btn" data-remove="${escape(item.id)}" title="Excluir">✕</button>
        </div>`
        )
        .join('');
    } catch (err) {
      list.innerHTML = '<p class="empty">Não foi possível carregar a biblioteca.</p>';
    }
  }

  function escape(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove]');
    if (!button) return;
    try {
      await api('/api/library/' + button.dataset.remove, { method: 'DELETE' });
      toast('Documento excluído.');
      loadLibrary();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#library-refresh').addEventListener('click', loadLibrary);
  loadLibrary();

  /* Abre direto o documento indicado pela URL. */
  const docId = new URLSearchParams(window.location.search).get('doc');
  if (docId) {
    api('/api/library/' + encodeURIComponent(docId))
      .then((r) => r.json())
      .then((item) => {
        source.value = item.content;
        storage.set(DRAFT_KEY, item.content);
        toast('Documento "' + item.title + '" carregado.');
      })
      .catch(() => {});
  }
})();