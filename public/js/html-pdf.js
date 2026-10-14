/* =========================================================
   Página /html-pdf

   Cola o HTML (página inteira ou pedaço solto), mostra a prévia
   num iframe isolado e manda gerar o PDF no servidor — que usa o
   Chrome/Edge instalado na máquina (src/lib/chrome.js). Sem
   navegador instalado, o botão "Imprimir" do painel resolve: o
   diálogo nativo do próprio navegador sai na frente.

   O HTML só viaja de ida e volta na sua própria máquina: não há
   fila, nuvem nem conta. O rascunho fica no localStorage, como
   nas outras ferramentas.
   ========================================================= */
(function () {
  'use strict';

  const MD = window.MD;
  if (!MD) return;

  const $ = MD.$;
  const toast = MD.toast;

  const MAX_BYTES = 4 * 1024 * 1024;
  const ACCEPT = '.html,.htm,.xhtml,text/html';
  const DRAFT_KEY = 'md:htmlpdf:state';

  /* Exemplos propositalmente diferentes: um pedaço solto (o caso
     mais comum de colar) e uma página inteira com CSS próprio. */
  const SAMPLES = [
    {
      key: 'recibo', label: 'Recibo',
      text: '<h1>Recibo nº 1042</h1>\n' +
        '<p><b>Emitido por:</b> Utilitz<br>\n' +
        '<b>Data:</b> 12 de março</p>\n' +
        '<table>\n' +
        '  <tr><th>Item</th><th>Valor</th></tr>\n' +
        '  <tr><td>Hospedagem anual</td><td>R$ 240,00</td></tr>\n' +
        '  <tr><td>Suporte prioritário</td><td>R$ 90,00</td></tr>\n' +
        '  <tr><td><b>Total</b></td><td><b>R$ 330,00</b></td></tr>\n' +
        '</table>\n' +
        '<p style="color:#666;font-size:12px">Documento gerado pela ferramenta HTML → PDF.</p>',
    },
    {
      key: 'pagina', label: 'Página inteira',
      text: '<!doctype html>\n<html lang="pt-BR">\n<head>\n' +
        '<meta charset="utf-8">\n<title>Newsletter de março</title>\n' +
        '<style>\n' +
        '  @page { margin: 18mm; }\n' +
        '  body { font-family: Georgia, serif; color: #1c1c1e; max-width: 640px; margin: 0 auto; }\n' +
        '  header { border-bottom: 3px solid #2c6eaf; padding-bottom: 8px; }\n' +
        '  h1 { color: #2c6eaf; }\n' +
        '  .destaque { background: #eef4fb; padding: 12px 16px; border-radius: 8px; }\n' +
        '</style>\n</head>\n<body>\n' +
        '<header><h1>Newsletter de março</h1></header>\n' +
        '<p class="destaque"><b>Novidade:</b> a ferramenta de HTML para PDF chegou.</p>\n' +
        '<p>Esta página veio como arquivo completo, com <code>&lt;head&gt;</code>, ' +
        'CSS próprio e regra <code>@page</code> — as regras dela valem mais que os ajustes da tela.</p>\n' +
        '</body>\n</html>',
    },
  ];

  const el = {
    open: $('#hp-open'),
    clear: $('#hp-clear'),
    drop: $('#hp-drop'),
    input: $('#hp-input'),
    source: $('#hp-source'),
    samples: $('#hp-samples'),
    size: $('#hp-size'),
    orientation: $('#hp-orientation'),
    margins: $('#hp-margins'),
    background: $('#hp-background'),
    title: $('#hp-title'),
    frame: $('#hp-frame'),
    badge: $('#hp-badge'),
    error: $('#hp-error'),
    print: $('#hp-print'),
    pdf: $('#hp-pdf'),
    inStats: $('#hp-in-stats'),
    outStats: $('#hp-out-stats'),
    hint: $('#hp-hint'),
  };

  const state = { fileName: '' };

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */

  function countLines(text) {
    if (!text) return 0;
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  function formatNumber(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** Nome de arquivo baixado: o título, o nome do arquivo, ou o padrão. */
  function downloadName() {
    const asked = el.title.value.trim();
    if (asked) return MD.fileStem(asked, 'pagina') + '.pdf';
    if (state.fileName) return MD.fileStem(state.fileName, 'pagina') + '.pdf';
    return 'pagina.pdf';
  }

  /**
   * Documento da prévia: um HTML inteiro entra como está; um pedaço solto
   * ganha uma página branca em volta para dar contraste e legibilidade.
   */
  function previewDoc(text) {
    const trimmed = text.trimStart();
    if (/^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return text;
    return '<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n' +
      '<style>\n' +
      '  html { background: #fff; }\n' +
      "  body { margin: 18px; color: #16181d; font: 15px/1.6 -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; }\n" +
      '  table { border-collapse: collapse; }\n' +
      '  th, td { border: 1px solid #c9ced8; padding: 5px 9px; text-align: left; }\n' +
      '  th { background: #f2f4f8; }\n' +
      '  img { max-width: 100%; }\n' +
      '</style>\n</head>\n<body>\n' + text + '\n</body>\n</html>';
  }

  /* ---------------------------------------------------------
     Prévia e estatísticas
     --------------------------------------------------------- */

  function showError(message) {
    el.error.hidden = !message;
    el.error.textContent = message || '';
  }

  function render() {
    const source = el.input.value;
    showError('');

    el.inStats.textContent = source
      ? countLines(source) + ' linha(s) · ' + formatNumber(source.length) + ' caractere(s)'
      : '—';

    if (!source.trim()) {
      el.frame.removeAttribute('srcdoc');
      el.frame.srcdoc = '';
      el.badge.textContent = '—';
      el.outStats.textContent = '—';
      el.hint.textContent = '';
      return;
    }

    /* `srcdoc` é atributo do DOM: atribuir de novo recarrega o quadro
       inteiro, então o debounce evita repintar a cada tecla. */
    el.frame.srcdoc = previewDoc(source);
    el.badge.textContent = 'prévia';
    el.outStats.textContent = 'papel ' + (el.size.selectedOptions[0] || {}).textContent;
    el.hint.textContent = 'O PDF sai paginado pelo papel escolhido aqui.';
  }

  const renderSoon = MD.debounce(render, 250);

  /* ---------------------------------------------------------
     Gerar PDF e imprimir
     --------------------------------------------------------- */

  function filenameFrom(response, fallback) {
    const header = response.headers && response.headers.get('Content-Disposition');
    const match = header && /filename="?([^";]+)"?/i.exec(header);
    return match ? match[1] : fallback;
  }

  function generate() {
    const html = el.input.value;
    if (!html.trim()) {
      toast('Cole um HTML antes de gerar o PDF.', 'error');
      el.input.focus();
      return;
    }

    el.pdf.disabled = true;
    el.print.disabled = true;

    MD.api('/api/html-pdf', {
      method: 'POST',
      body: JSON.stringify({
        html,
        title: el.title.value.trim() || undefined,
        pageSize: el.size.value,
        orientation: el.orientation.value,
        margins: el.margins.value,
        printBackground: el.background.checked,
      }),
    })
      .then((response) => response.blob().then((blob) => {
        const name = filenameFrom(response, downloadName());
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast('Baixando ' + name);
      }))
      .catch((err) => {
        const message = String((err && err.message) || 'Não consegui gerar o PDF.');
        showError(message + ' O botão Imprimir abre o diálogo do navegador — "Salvar como PDF" resolve na hora.');
        toast('Não deu para gerar o PDF.', 'error');
      })
      .then(() => {
        el.pdf.disabled = false;
        el.print.disabled = false;
      });
  }

  /** Sai pelo navegador: funciona mesmo sem Chrome no servidor. */
  function printHere() {
    if (!el.input.value.trim()) {
      toast('Cole um HTML antes de imprimir.', 'error');
      return;
    }
    try {
      el.frame.contentWindow.focus();
      el.frame.contentWindow.print();
    } catch (err) {
      toast('O navegador bloqueou o diálogo de impressão.', 'error');
    }
  }

  /* ---------------------------------------------------------
     Entrada de texto e arquivos
     --------------------------------------------------------- */

  function setSource(fileName) {
    state.fileName = fileName || '';
    el.source.textContent = state.fileName || 'colado na página';
  }

  function clearAll() {
    el.input.value = '';
    setSource('');
    el.title.value = '';
    render();
    el.input.focus();
    toast('Tudo limpo');
  }

  function useText(name, text) {
    if (typeof text !== 'string') {
      toast('Não consegui ler esse arquivo.', 'error');
      return;
    }
    if (text.indexOf('\u0000') >= 0) {
      toast('Parece um arquivo binário — esta página trabalha com HTML.', 'error');
      return;
    }
    if (text.length > MAX_BYTES) {
      toast('Arquivo maior que 4 MB — a leitura ficaria lenta demais.', 'error');
      return;
    }

    el.input.value = text;
    if (!el.title.value.trim() && name) el.title.value = MD.fileStem(name, '');
    setSource(name);
    render();
    toast('Lido: ' + name);
  }

  async function openFile(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast('Arquivo maior que 4 MB — a leitura ficaria lenta demais.', 'error');
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (err) {
      toast('Não consegui ler esse arquivo.', 'error');
      return;
    }
    useText(file.name, text);
  }

  function pickFile() {
    MD.pickFile(ACCEPT).then((file) => {
      if (file) useText(file.name, file.text);
    });
  }

  /* ---------------------------------------------------------
     Arrastar e soltar
     --------------------------------------------------------- */

  function filesOf(dataTransfer) {
    if (!dataTransfer || !dataTransfer.files) return [];
    const files = [];
    for (let i = 0; i < dataTransfer.files.length; i++) files.push(dataTransfer.files[i]);
    return files;
  }

  function carriesFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }

  let dragDepth = 0;

  function bindDrop() {
    window.addEventListener('dragenter', (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      el.drop.classList.add('is-over');
    });

    window.addEventListener('dragover', (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) el.drop.classList.remove('is-over');
    });

    window.addEventListener('drop', (event) => {
      const files = filesOf(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      dragDepth = 0;
      el.drop.classList.remove('is-over');
      openFile(files[0]);
    });
  }

  /* ---------------------------------------------------------
     Rascunho e exemplos
     --------------------------------------------------------- */

  function saveDraft() {
    MD.storage.set(DRAFT_KEY, {
      text: el.input.value,
      title: el.title.value,
      size: el.size.value,
      orientation: el.orientation.value,
      margins: el.margins.value,
      background: el.background.checked,
      fileName: state.fileName,
    });
  }

  function loadDraft() {
    const data = MD.storage.get(DRAFT_KEY, null);
    if (!data || typeof data !== 'object') return;

    const choose = (select, value) => {
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === value) { select.value = value; return; }
      }
    };

    choose(el.size, data.size);
    choose(el.orientation, data.orientation);
    choose(el.margins, data.margins);
    if (typeof data.background === 'boolean') el.background.checked = data.background;
    if (typeof data.title === 'string') el.title.value = data.title;
    if (typeof data.text === 'string' && data.text) {
      el.input.value = data.text;
      setSource(typeof data.fileName === 'string' ? data.fileName : '');
    }
  }

  function bindSamples() {
    const row = el.samples;
    if (!row) return;

    const label = document.createElement('span');
    label.className = 'samples-label';
    label.textContent = 'Exemplos:';
    row.appendChild(label);

    SAMPLES.forEach((sample) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip';
      button.setAttribute('data-sample', sample.key);
      button.textContent = sample.label;
      row.appendChild(button);
    });

    row.addEventListener('click', (event) => {
      const target = event.target;
      const key = target && target.getAttribute ? target.getAttribute('data-sample') : null;
      if (!key) return;
      const sample = SAMPLES.filter((item) => item.key === key)[0];
      if (!sample) return;

      el.input.value = sample.text;
      setSource('');
      render();
      el.input.focus();
    });
  }

  /* ---------------------------------------------------------
     Início
     --------------------------------------------------------- */

  function init() {
    if (!el.input) return;

    loadDraft();
    bindSamples();
    bindDrop();

    el.open.addEventListener('click', pickFile);
    el.drop.addEventListener('click', pickFile);
    el.clear.addEventListener('click', clearAll);
    el.pdf.addEventListener('click', generate);
    el.print.addEventListener('click', printHere);

    el.input.addEventListener('input', () => { renderSoon(); saveDraft(); });
    el.title.addEventListener('input', () => { saveDraft(); });
    for (const control of [el.size, el.orientation, el.margins, el.background]) {
      control.addEventListener('change', () => { render(); saveDraft(); });
    }

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
