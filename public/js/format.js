/* =========================================================
   Página /formatar

   Lê o texto (colado, de um arquivo solto na página ou de um
   exemplo), manda formatar no `format-core.js` e desenha a
   saída linha a linha com realce de sintaxe — o highlight.js
   mora em /vendor/hljs.js, gerado por scripts/build-hljs.js.

   A formatação é síncrona e mora no navegador: nada sobe para
   o servidor, e o rascunho fica no localStorage como nas
   outras ferramentas.
   ========================================================= */
(function () {
  'use strict';

  const MD = window.MD;
  const Format = window.MDFormat;
  if (!MD || !Format) return;

  const $ = MD.$;
  const toast = MD.toast;

  const MAX_BYTES = 4 * 1024 * 1024;
  /* Acima disso a prévia linha a linha pesa mais do que ajuda. */
  const MAX_LINES = 4000;
  const DRAFT_KEY = 'md:format:state';

  const ACCEPT = '.json,.xml,.html,.htm,.md,.markdown,.csv,.tsv,.txt,.log,.py,.cs,.java,' +
    '.js,.jsx,.mjs,.cjs,.ts,.tsx,.c,.h,.cpp,.cc,.hpp,.go,.rb,.rs,.kt,.swift,.php,.lua,' +
    '.pl,.r,.sql,.yml,.yaml,.sh,.bash,.zsh,.ini,.cfg,.conf,.properties,.toml,.css,.scss,' +
    '.less,.graphql,.gql,.diff,.patch,.vb,.m,text/plain';

  /** Extensão usada no download quando não veio de um arquivo. */
  const EXT_BY_TYPE = {
    json: 'json', xml: 'xml', html: 'html', markdown: 'md', csv: 'csv', text: 'txt',
    python: 'py', csharp: 'cs', java: 'java', javascript: 'js', typescript: 'ts',
    c: 'c', cpp: 'cpp', go: 'go', rust: 'rs', kotlin: 'kt', swift: 'swift',
    php: 'php', ruby: 'rb', lua: 'lua', perl: 'pl', r: 'r', sql: 'sql', yaml: 'yml',
    shell: 'sh', ini: 'ini', css: 'css', scss: 'scss', graphql: 'graphql',
    makefile: 'mk', diff: 'diff', vbnet: 'vb', objectivec: 'm', wasm: 'wasm',
  };

  /* Exemplos propositalmente feios: é mostrando o "antes" que a página
     explica o que faz. */
  const SAMPLES = [
    {
      key: 'json', type: 'json', label: 'JSON',
      text: '{"empresa":"Utilitz","ativo":true,"planos":[{"nome":"Básico","preco":19.9,' +
        '"recursos":["5 projetos","Suporte por e-mail"]},{"nome":"Pro","preco":49.9,' +
        '"recursos":["Projetos ilimitados","Suporte prioritário","Exportação em PDF"]}],' +
        '"contato":{"email":"oi@utilitz.dev","telefone":"+55 11 99999-0000"}}',
    },
    {
      key: 'code', type: 'csharp', label: 'C#',
      text: 'using System;\nnamespace Loja.Servicos{\npublic class Calculadora{\n' +
        'private readonly double _taxa;\npublic Calculadora(double taxa){_taxa=taxa;}\n' +
        'public double Total(double valor){\nif(valor<=0){throw new ArgumentException("valor precisa ser positivo");}\n' +
        'return valor*(1+_taxa);\n}\n}\n}',
    },
    {
      key: 'text', type: 'text', label: 'Texto',
      text: 'Reunião de terça\\nDefinimos o prazo do lançamento: 15 de março.\\n' +
        'A Maria cuida da página, o João cuida dos e-mails.\\n\\n\\n' +
        'Próximo encontro: dia 10, às 14h.',
    },
    {
      key: 'xml', type: 'xml', label: 'XML',
      text: '<?xml version="1.0"?><pedido id="1042"><cliente nome="Ana Souza">' +
        '<fone>11 9999-0000</fone><fone>11 3333-0000</fone></cliente><itens>' +
        '<item sku="A-1" qtd="2"><preco>19,90</preco></item>' +
        '<item sku="B-7" qtd="1"><preco>49,90</preco></item></itens></pedido>',
    },
    {
      key: 'html', type: 'html', label: 'HTML',
      text: '<div class="cartao"><h2>Utilitz Studio</h2><p>Ferramenta para <b>ler</b> e ' +
        '<b>exportar</b> documentos.</p><ul><li>Visualização em tela cheia</li><li>PDF</li>' +
        '<li>Conversor de imagens</li></ul></div>',
    },
    {
      key: 'markdown', type: 'markdown', label: 'Markdown',
      text: '#Notas da reunião   \n\n- Prazo:15 de março\n- Responsável: Maria\n' +
        '1) Enviar o orçamento\n\n>aguardando retorno do cliente\n\n\n\n' +
        '```\nconst x=1;   \n```\n',
    },
    {
      key: 'csv', type: 'csv', label: 'CSV',
      text: 'nome;cidade;funcao;projeto\nAna Souza;Lisboa;Designer;Identidade visual\n' +
        'Bruno Reis;Porto;Desenvolvedor;API de pagamentos\n' +
        '"Maria, Clara";São Paulo;Redatora;Relatório anual\n',
    },
  ];

  const el = {
    drop: $('#fmt-drop'),
    open: $('#fmt-open'),
    clear: $('#fmt-clear'),
    input: $('#fmt-input'),
    source: $('#fmt-source'),
    samples: $('#fmt-samples'),
    type: $('#fmt-type'),
    indent: $('#fmt-indent'),
    reindent: $('#fmt-reindent'),
    detect: $('#fmt-detect'),
    indentHint: $('#grp-indent-hint'),
    grpIndent: $('#grp-indent'),
    grpReindent: $('#grp-reindent'),
    grpClean: $('#grp-clean'),
    grpText: $('#grp-text'),
    grpEscapes: $('#grp-escapes'),
    grpCsv: $('#grp-csv'),
    escapesTitle: $('#escapes-title'),
    escapesHint: $('#escapes-hint'),
    crlf: $('#opt-crlf'),
    trailing: $('#opt-trailing'),
    blank: $('#opt-blank'),
    edges: $('#opt-edges'),
    unescape: $('#opt-unescape'),
    oneLine: $('#opt-one-line'),
    removeEscapes: $('#opt-remove-escapes'),
    textHint: $('#text-hint'),
    copy: $('#fmt-copy'),
    download: $('#fmt-download'),
    badge: $('#fmt-badge'),
    error: $('#fmt-error'),
    preview: $('#fmt-preview'),
    inStats: $('#fmt-in-stats'),
    outStats: $('#fmt-out-stats'),
    warnings: $('#fmt-warnings'),
  };

  const state = {
    fileName: '',
    result: null,
  };

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function countLines(text) {
    if (!text) return 0;
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.length;
  }

  function formatNumber(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** Destaque de sintaxe; sem highlight.js o texto segue escapado e cinza. */
  function highlight(text, language) {
    const hljs = window.hljs;
    if (!hljs) return escapeHtml(text);
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(text, { language, ignoreIllegals: true }).value;
      }
    } catch (err) {
      /* linguagem estranha: cai no texto puro */
    }
    return escapeHtml(text);
  }

  /**
   * Quebra o HTML realçado em linhas sem abrir/cerrar spans no meio.
   * O highlight.js deixa tags atravessando `\n`; aqui elas são
   * reabertas a cada linha, então cada uma pode ter seu próprio div.
   * @returns {string[]} HTML de cada linha
   */
  function splitHighlightedLines(html) {
    const lines = [''];
    const stack = [];
    const re = /<span class="([^"]*)">|<\/span>|[^<]+/g;
    let match;

    const wrap = (text) => {
      let out = '';
      for (const cls of stack) out += '<span class="' + cls + '">';
      out += text;
      for (let i = 0; i < stack.length; i++) out += '</span>';
      return out;
    };

    while ((match = re.exec(html)) !== null) {
      const token = match[0];
      if (token.charAt(0) === '<') {
        if (token.charAt(1) === '/') stack.pop();
        else stack.push(match[1]);
        continue;
      }
      const parts = token.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) lines.push('');
        if (parts[i]) lines[lines.length - 1] += wrap(parts[i]);
      }
    }

    return lines;
  }

  /* ---------------------------------------------------------
     Prévia
     --------------------------------------------------------- */

  function showPreviewEmpty(message) {
    el.preview.textContent = '';
    const p = document.createElement('p');
    p.className = 'fmt-empty';
    p.textContent = message;
    el.preview.appendChild(p);
  }

  function renderPreview(text, language) {
    el.preview.textContent = '';

    if (!text) {
      showPreviewEmpty('A versão formatada aparece aqui.');
      return;
    }

    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    if (lines.length > MAX_LINES) {
      const pre = document.createElement('pre');
      pre.className = 'fmt-plain';
      pre.textContent = lines.join('\n');
      el.preview.appendChild(pre);
      el.preview.classList.add('is-plain');
      return;
    }
    el.preview.classList.remove('is-plain');

    const parts = splitHighlightedLines(highlight(text, language));
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < parts.length; i++) {
      const row = document.createElement('div');
      row.className = 'fmt-line';

      const number = document.createElement('span');
      number.className = 'fmt-num';
      number.textContent = String(i + 1);

      const code = document.createElement('span');
      code.className = 'fmt-code';
      if (parts[i]) code.innerHTML = parts[i];

      row.appendChild(number);
      row.appendChild(code);
      fragment.appendChild(row);
    }

    el.preview.appendChild(fragment);
  }

  /* ---------------------------------------------------------
     Painéis de opções
     --------------------------------------------------------- */

  const GROUPS = {
    json: { indent: true, clean: true, escapes: true },
    xml: { indent: true, clean: true, escapes: true },
    html: { indent: true, clean: true },
    markdown: { clean: true },
    csv: { csv: true },
    text: { indent: true, clean: true, text: true },
    code: { indent: true, clean: true, reindent: true },
  };

  function updateGroups(family) {
    const group = GROUPS[family] || GROUPS.code;
    el.grpIndent.hidden = !group.indent;
    el.grpClean.hidden = !group.clean;
    el.grpReindent.hidden = !group.reindent;
    el.grpText.hidden = !group.text;
    el.grpEscapes.hidden = !group.escapes;
    el.grpCsv.hidden = !group.csv;

    if (group.indent) el.indentHint.textContent = indentHint(family, el.indent.value);
    if (group.escapes) {
      const noun = family === 'xml' ? 'XML' : 'JSON';
      el.escapesTitle.textContent = noun + ' escapado';
      el.escapesHint.innerHTML =
        'Use quando o ' + noun + ' chegou como string escapada — de uma linha só, ' +
        'cheia de <code>\\n</code> e <code>\\"</code> — e precisa voltar a ser ' +
        noun + ' de verdade.';
    }
  }

  function indentHint(family, indent) {
    if (family === 'json' || family === 'xml' || family === 'html') {
      return 'O arquivo é reescrito por inteiro: esta é a unidade de cada nível.';
    }
    if (indent === 'keep') return 'Espaços e tabulações do original ficam como estão.';
    if (indent === 'tab') return 'O recuo inicial vira tabulação de 4 colunas.';
    return 'Tabulações do recuo inicial viram espaços, ' + indent + ' por nível.';
  }

  /** Avisa quando o texto tem `\n` literal ainda sem virar quebra de linha. */
  function updateTextHint(result) {
    const literal = /\\n/.test(el.input.value);
    const armed = el.unescape.checked;
    /* Na virada de string o `\n` literal é informação, não problema. */
    const escaping = el.oneLine.checked;

    el.textHint.classList.remove('is-alert');

    if (result.family === 'text' && literal && !armed && !escaping) {
      el.textHint.classList.add('is-alert');
      el.textHint.innerHTML =
        'Este texto tem <code>\\n</code> literal — ' +
        '<button type="button" class="hint-link" id="hint-fix">converta em quebra de linha</button>.';
      const fix = $('#hint-fix');
      if (fix) {
        fix.addEventListener('click', () => {
          el.unescape.checked = true;
          run();
        });
      }
      return;
    }

    el.textHint.innerHTML =
      'Marque quando o texto veio colado em uma linha só e as quebras aparecem ' +
      'como a sequência <code>\\n</code>.';
  }

  /* ---------------------------------------------------------
     Estatísticas e avisos
     --------------------------------------------------------- */

  function statsOf(text) {
    return { lines: countLines(text), chars: text.length };
  }

  function renderStats(result, source) {
    const before = statsOf(source);
    const after = statsOf(result.text);

    el.inStats.textContent = source
      ? before.lines + ' linha(s) · ' + formatNumber(before.chars) + ' caractere(s)'
      : '—';

    if (!source) {
      el.outStats.textContent = '—';
      return;
    }

    const movement = result.changed
      ? (after.lines >= before.lines ? '+' : '') + (after.lines - before.lines) + ' linha(s)'
      : 'sem mudanças';

    el.outStats.textContent =
      after.lines + ' linha(s) · ' + formatNumber(after.chars) + ' caractere(s) · ' + movement;

    const notes = [];
    if (result.warnings && result.warnings.length) notes.push(result.warnings.join(' · '));
    if (after.lines > MAX_LINES) notes.push('prévia sem numeração: mais de ' + formatNumber(MAX_LINES) + ' linhas');
    el.warnings.textContent = notes.join(' · ');
  }

  function renderError(result, source) {
    if (!result.error) {
      el.error.hidden = true;
      el.error.textContent = '';
      return;
    }
    const kept = result.text === source
      ? 'O texto original foi mantido.'
      : 'A saída mantém o texto com um nível de escape a menos.';
    el.error.hidden = false;
    el.error.textContent =
      (result.family === 'json' ? 'JSON inválido' : 'Não deu para formatar') +
      ' — linha ' + result.error.line + ', coluna ' + result.error.column + ': ' +
      result.error.message + '. ' + kept;
  }

  /* ---------------------------------------------------------
     Formatação
     --------------------------------------------------------- */

  function readOptions() {
    return {
      type: el.type.value,
      filename: state.fileName,
      indent: el.indent.value,
      reindent: el.reindent.checked,
      crlf: el.crlf.checked,
      trailing: el.trailing.checked,
      blank: el.blank.checked,
      edges: el.edges.checked,
      unescapeNewlines: el.unescape.checked,
      escapeToOneLine: el.oneLine.checked,
      removeEscapes: el.removeEscapes.checked,
    };
  }

  function run() {
    const source = el.input.value;
    const result = Format.format(source, readOptions());
    state.result = result;

    if (!source) {
      updateGroups(result.family);
      el.badge.textContent = '—';
      el.badge.removeAttribute('title');
      el.detect.textContent = 'Cole ou solte um arquivo para começar.';
      showPreviewEmpty('A versão formatada aparece aqui.');
      renderStats(result, source);
      renderError(result, source);
      el.badge.classList.remove('is-error');
      el.copy.disabled = true;
      el.download.disabled = true;
      return;
    }

    el.copy.disabled = false;
    el.download.disabled = false;

    updateGroups(result.family);
    updateTextHint(result);

    el.badge.textContent = result.label;
    el.badge.setAttribute('title', result.reason);
    el.badge.classList.toggle('is-error', !!result.error);
    el.detect.textContent = el.type.value === 'auto'
      ? 'Detectado ' + result.label + ' — ' + result.reason + '.'
      : 'Você escolheu ' + result.label + '.';

    renderError(result, source);
    renderStats(result, source);
    renderPreview(result.text, result.language);
    saveDraft();
  }

  const runSoon = MD.debounce(run, 180);

  /* ---------------------------------------------------------
     Entrada de texto
     --------------------------------------------------------- */

  function setSource(fileName) {
    state.fileName = fileName || '';
    el.source.textContent = state.fileName || 'colado na página';
  }

  function clearAll() {
    el.input.value = '';
    setSource('');
    el.type.value = 'auto';
    run();
    el.input.focus();
    toast('Tudo limpo');
  }

  /** Recebe o texto já lido (arquivo solto ou escolhido no seletor). */
  function useText(name, text) {
    if (typeof text !== 'string') {
      toast('Não consegui ler esse arquivo.', 'error');
      return;
    }
    if (text.indexOf('\u0000') >= 0) {
      toast('Parece um arquivo binário — esta página trabalha com texto.', 'error');
      return;
    }
    if (text.length > MAX_BYTES) {
      toast('Arquivo maior que 4 MB — a leitura ficaria lenta demais.', 'error');
      return;
    }

    el.input.value = text;
    setSource(name);
    run();
    toast('Lido: ' + name);
  }

  async function openFile(file) {
    if (!file) return;

    if (/^image\//.test(file.type || '')) {
      toast('Esta página formata texto e código, não imagens.', 'error');
      return;
    }
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
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
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
     Copiar, baixar e rascunho
     --------------------------------------------------------- */

  function copyOutput() {
    const result = state.result;
    if (!result || !result.text) { toast('Nada para copiar ainda.', 'error'); return; }

    const done = () => toast('Formatado copiado');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(result.text).then(done, fallbackCopy);
      return;
    }
    fallbackCopy();

    function fallbackCopy() {
      const area = document.createElement('textarea');
      area.value = result.text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done();
      } catch (err) {
        toast('O navegador bloqueou a cópia.', 'error');
      }
      area.remove();
    }
  }

  function downloadOutput() {
    const result = state.result;
    if (!result || !result.text) { toast('Nada para baixar ainda.', 'error'); return; }

    const name = state.fileName || 'formatado.' + (EXT_BY_TYPE[result.type] || 'txt');
    const blob = new Blob([result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('Baixando ' + name);
  }

  function saveDraft() {
    MD.storage.set(DRAFT_KEY, {
      text: el.input.value,
      type: el.type.value,
      indent: el.indent.value,
      fileName: state.fileName,
    });
  }

  function loadDraft() {
    const data = MD.storage.get(DRAFT_KEY, null);
    if (!data || typeof data !== 'object') return;

    if (typeof data.type === 'string') {
      for (let i = 0; i < el.type.options.length; i++) {
        if (el.type.options[i].value === data.type) { el.type.value = data.type; break; }
      }
    }
    if (typeof data.indent === 'string') {
      for (let i = 0; i < el.indent.options.length; i++) {
        if (el.indent.options[i].value === data.indent) { el.indent.value = data.indent; break; }
      }
    }
    if (typeof data.text === 'string' && data.text) {
      el.input.value = data.text;
      setSource(typeof data.fileName === 'string' ? data.fileName : '');
    }
  }

  /* ---------------------------------------------------------
     Exemplos
     --------------------------------------------------------- */

  function bindSamples() {
    const row = $('#fmt-samples');
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
      el.type.value = sample.type;
      setSource('');
      run();
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
    el.copy.addEventListener('click', copyOutput);
    el.download.addEventListener('click', downloadOutput);

    el.input.addEventListener('input', runSoon);
    el.type.addEventListener('change', run);
    el.indent.addEventListener('change', run);
    el.reindent.addEventListener('change', run);
    for (const box of [el.crlf, el.trailing, el.blank, el.edges, el.removeEscapes]) {
      box.addEventListener('change', run);
    }

    /* As duas viradas de texto se excluem: não dá para escapar e
       desescapar no mesmo passe — marcar uma desliga a outra. */
    el.unescape.addEventListener('change', () => {
      if (el.unescape.checked) el.oneLine.checked = false;
      run();
    });
    el.oneLine.addEventListener('change', () => {
      if (el.oneLine.checked) el.unescape.checked = false;
      run();
    });

    run();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
