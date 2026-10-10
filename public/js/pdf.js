/* =========================================================
   Conversor Markdown -> PDF (tela dividida + pré-visualização)
   ========================================================= */
(function () {
  'use strict';

  const {
    $, $$, debounce, toast, render, storage, handoff, draftText, api,
    downloadFile, pickFile, fileStem, guessTitle, isTyping, onKeys,
  } = window.MD;

  const Shared = window.MDShared;
  const DRAFT_KEY = 'md:draft:pdf';
  const SETTINGS_KEY = 'md:settings:pdf';

  const editor = $('#source');
  const previewPages = $('#preview-pages');
  const previewPane = $('#preview');
  const settingsPanel = $('#settings');
  const loading = $('#preview-loading');

  /* Ajustes salvos: migra o padrão antigo "justificado" (que esticava as
     palavras) para "esquerda" uma única vez, usando `settingsVersion`. */
  const storedSettings = storage.get(SETTINGS_KEY, {});
  const savedSettings =
    storedSettings && typeof storedSettings === 'object' ? Object.assign({}, storedSettings) : {};
  if (!savedSettings.settingsVersion && savedSettings.textAlign === 'justify') {
    savedSettings.textAlign = 'left';
  }
  savedSettings.settingsVersion = Shared.DEFAULTS.settingsVersion;
  let settings = Object.assign({}, Shared.DEFAULTS, savedSettings);
  storage.set(SETTINGS_KEY, settings);
  let previewer = null;
  let previewRun = null;
  let zoom = Number(storage.get('md:zoom:pdf', 0)) || 0;
  let renderToken = 0;

  /* ==========================================================
     Fontes externas
     ========================================================== */

  /**
   * O que o servidor sabe sobre fontes: a lista para escolher e as que já
   * estão baixadas. `faces` são as regras `@font-face` prontas, montadas no
   * servidor para não ter duas cópias da mesma lógica.
   */
  const fontStore = { catalog: [], installed: [] };

  function fontDescriptor(key) {
    return fontStore.installed.find((item) => item.key === key) || null;
  }

  /** Valor de `font-family` para a prévia. */
  function fontCss(key) {
    if (Object.prototype.hasOwnProperty.call(Shared.FONT_FAMILIES, key)) {
      return Shared.FONT_FAMILIES[key].css;
    }
    const found = fontDescriptor(key);
    if (found) return '"' + found.family + '", serif';
    return Shared.FONT_FAMILIES[settings.fontFamily] ? Shared.FONT_FAMILIES[settings.fontFamily].css : 'serif';
  }

  /** Todas as famílias que a prévia vai precisar carregar. */
  function fontsInUse(s) {
    const keys = [s.fontFamily];
    if (s.headingFontFamily !== 'inherit') keys.push(s.headingFontFamily);
    return keys.map(fontDescriptor).filter(Boolean);
  }

  /**
   * Espera o navegador carregar as fontes antes de paginar.
   *
   * Sem isto o Paged.js mede o texto com a fonte substituta e quebra as linhas
   * no meio de uma palavra quando a fonte certa chega, e a prévia não bate com
   * o PDF.
   */
  async function fontsReady(used) {
    if (!used.length || !document.fonts) return;
    const jobs = [];
    used.forEach((item) => {
      const family = '"' + item.family + '"';
      jobs.push(document.fonts.load('400 12px ' + family).catch(() => {}));
      jobs.push(document.fonts.load('700 12px ' + family).catch(() => {}));
      jobs.push(document.fonts.load('italic 400 12px ' + family).catch(() => {}));
      jobs.push(document.fonts.load('italic 700 12px ' + family).catch(() => {}));
    });
    await Promise.all(jobs);
  }

  async function loadFontStore() {
    try {
      const data = await (await api('/api/fonts')).json();
      fontStore.catalog = Array.isArray(data.catalog) ? data.catalog : [];
      fontStore.installed = Array.isArray(data.installed) ? data.installed : [];
    } catch (err) {
      fontStore.catalog = [];
      fontStore.installed = [];
    }
  }

  /** Opções do <select> de fontes, com as externas agrupadas. */
  function fontOptions(selected) {
    const builtin = Object.keys(Shared.FONT_FAMILIES)
      .map((key) => {
        const label = Shared.FONT_FAMILIES[key].label;
        return '<option value="' + key + '"' + (key === selected ? ' selected' : '') + '>' + label + '</option>';
      })
      .join('');

    if (!fontStore.installed.length) return builtin;

    const external = fontStore.installed
      .map((item) => {
        const label = item.family + (item.catalog === 'mono' ? ' (mono)' : '');
        return '<option value="' + item.key + '"' + (item.key === selected ? ' selected' : '') + '>' + label + '</option>';
      })
      .join('');

    return (
      '<optgroup label="Do sistema">' + builtin + '</optgroup>' +
      '<optgroup label="Baixadas do Google Fonts">' + external + '</optgroup>'
    );
  }

  /* ==========================================================
     Configurações
     ========================================================== */

  function getPath(object, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
  }

  function setPath(object, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((acc, key) => {
      if (typeof acc[key] !== 'object' || acc[key] === null) acc[key] = {};
      return acc[key];
    }, object);
    target[last] = value;
  }

  /* Lista declarativa: id do controle -> caminho nas configurações. */
  const CONTROLS = [
    { id: 'pageSize', path: 'pageSize', type: 'select' },
    { id: 'orientation', path: 'orientation', type: 'select' },
    { id: 'marginTop', path: 'margins.top', type: 'number' },
    { id: 'marginRight', path: 'margins.right', type: 'number' },
    { id: 'marginBottom', path: 'margins.bottom', type: 'number' },
    { id: 'marginLeft', path: 'margins.left', type: 'number' },
    { id: 'fontFamily', path: 'fontFamily', type: 'select' },
    { id: 'headingFontFamily', path: 'headingFontFamily', type: 'select' },
    { id: 'fontSize', path: 'fontSize', type: 'range', format: (v) => Number(v).toFixed(1).replace('.0', '') + ' pt' },
    { id: 'lineHeight', path: 'lineHeight', type: 'range', format: (v) => Number(v).toFixed(2) },
    { id: 'paragraphSpacing', path: 'paragraphSpacing', type: 'range', format: (v) => v + ' pt' },
    { id: 'headingScale', path: 'headingScale', type: 'range', format: (v) => Number(v).toFixed(2) + '×' },
    { id: 'firstLineIndent', path: 'firstLineIndent', type: 'range', format: (v) => v + ' mm' },
    { id: 'textAlign', path: 'textAlign', type: 'select' },
    { id: 'listStyle', path: 'listStyle', type: 'select' },
    { id: 'theme', path: 'theme', type: 'select', rerenderColors: true },
    { id: 'textColor', path: 'textColor', type: 'color' },
    { id: 'headingColor', path: 'headingColor', type: 'color' },
    { id: 'linkColor', path: 'linkColor', type: 'color' },
    { id: 'codeColor', path: 'codeColor', type: 'color' },
    { id: 'accentColor', path: 'accentColor', type: 'color' },
    { id: 'backgroundColor', path: 'backgroundColor', type: 'color' },
    { id: 'borderColor', path: 'borderColor', type: 'color' },
    { id: 'codeBackground', path: 'codeBackground', type: 'color' },
    { id: 'pageNumberPosition', path: 'pageNumberPosition', type: 'select' },
    { id: 'pageNumberFormat', path: 'pageNumberFormat', type: 'select' },
    { id: 'pageNumbers', path: 'pageNumbers', type: 'check' },
    { id: 'runningTitle', path: 'runningTitle', type: 'text' },
    { id: 'showToc', path: 'showToc', type: 'check' },
    { id: 'tocDepth', path: 'tocDepth', type: 'range', format: (v) => 'até H' + v },
    { id: 'imageMaxWidth', path: 'imageMaxWidth', type: 'range', format: (v) => v + '%' },
    { id: 'figureCaption', path: 'figureCaption', type: 'check' },
    { id: 'syntaxHighlight', path: 'syntaxHighlight', type: 'check' },
    { id: 'hyphenation', path: 'hyphenation', type: 'check' },
  ];

  /* Monta as opções dos <select> a partir das tabelas compartilhadas. */
  function fillSelect(id, table, selected, labels) {
    const select = $('#' + id);
    if (!select) return;
    select.innerHTML = Object.keys(table)
      .map((key) => {
        const label = labels ? labels[key] || table[key].label : table[key].label;
        return '<option value="' + key + '"' + (key === selected ? ' selected' : '') + '>' + label + '</option>';
      })
      .join('');
  }

  function buildForm() {
    fillSelect('pageSize', Shared.PAGE_SIZES, settings.pageSize);

    const fontSelect = $('#fontFamily');
    if (fontSelect) {
      fontSelect.innerHTML = fontOptions(settings.fontFamily);
      /* Chave de fonte que não está mais instalada (arquivo apagado do disco):
         volta ao padrão em vez de deixar o <select> em branco. */
      if (fontSelect.value !== settings.fontFamily) {
        settings.fontFamily = Shared.DEFAULTS.fontFamily;
        fontSelect.value = settings.fontFamily;
      }
    }

    const headingSelect = $('#headingFontFamily');
    headingSelect.innerHTML =
      '<option value="inherit">Igual ao texto</option>' +
      fontOptions(settings.headingFontFamily);
    headingSelect.value = settings.headingFontFamily;
    if (headingSelect.value !== settings.headingFontFamily) {
      settings.headingFontFamily = 'inherit';
      headingSelect.value = 'inherit';
    }

    const suggestions = $('#font-suggestions');
    if (suggestions) {
      const jaTem = fontStore.installed.map((item) => String(item.family).toLowerCase());
      suggestions.innerHTML = fontStore.catalog
        .filter((item) => jaTem.indexOf(String(item.family).toLowerCase()) === -1)
        .map((item) => '<option value="' + item.family + '"></option>')
        .join('');
    }

    const listSelect = $('#listStyle');
    listSelect.innerHTML = Object.keys(Shared.LIST_STYLES)
      .map((key) => '<option value="' + key + '">' + Shared.LIST_STYLES[key].label + '</option>')
      .join('');

    const themeSelect = $('#theme');
    themeSelect.innerHTML = Object.keys(Shared.THEMES)
      .map((key) => '<option value="' + key + '">' + Shared.THEMES[key].label + '</option>')
      .join('');

    const positionSelect = $('#pageNumberPosition');
    positionSelect.innerHTML = Object.keys(Shared.POSITIONS)
      .map((key) => '<option value="' + key + '">' + Shared.POSITIONS[key].label + '</option>')
      .join('');

    const presetSelect = $('#preset');
    presetSelect.innerHTML = Object.keys(Shared.PRESETS)
      .map((key) => '<option value="' + key + '">' + Shared.PRESETS[key].label + '</option>')
      .join('');

    $('#preset-cards').innerHTML = Object.keys(Shared.PRESETS)
      .map(
        (key) =>
          '<button type="button" class="preset-card" data-preset="' + key + '">' +
          '<strong>' + Shared.PRESETS[key].label + '</strong>' +
          '<span>' + Shared.PRESETS[key].description + '</span></button>'
      )
      .join('');

    syncForm();
  }

  /** Escreve as configurações nos controles. */
  function syncForm() {
    CONTROLS.forEach((control) => {
      const el = $('#' + control.id);
      if (!el) return;
      const value = getPath(settings, control.path);

      if (control.type === 'check') el.checked = value !== false;
      else el.value = value;

      const badge = document.getElementById(control.id + 'Value');
      if (badge && control.format) badge.textContent = control.format(value);
    });

    $('#preset').value = matchPreset();
    $$('.preset-card').forEach((card) => card.classList.toggle('is-on', card.dataset.preset === matchPreset()));
  }

  function readControl(control) {
    const el = $('#' + control.id);
    if (!el) return;

    let value;
    if (control.type === 'check') value = el.checked;
    else if (control.type === 'number') value = Number(el.value);
    else if (control.type === 'range') value = Number(el.value);
    else value = el.value;

    setPath(settings, control.path, value);

    /* Trocar de tema repinta as cores, a menos que o usuário as tenha mexido. */
    if (control.id === 'theme') {
      const theme = Shared.THEMES[value];
      if (theme) {
        Object.keys(theme).forEach((key) => {
          if (key === 'label') return;
          setPath(settings, key, theme[key]);
        });
        syncForm();
      }
    }

    const badge = document.getElementById(control.id + 'Value');
    if (badge && control.format) badge.textContent = control.format(getPath(settings, control.path));

    storage.set(SETTINGS_KEY, settings);
    updatePreview();
  }

  CONTROLS.forEach((control) => {
    const el = $('#' + control.id);
    if (!el) return;
    const eventName = control.type === 'check' || control.type === 'select' ? 'change' : 'input';
    el.addEventListener(eventName, () => readControl(control));
  });

  /** Descobre qual preset mais se aproxima das configurações atuais. */
  function matchPreset() {
    const keys = ['pageSize', 'orientation', 'fontFamily', 'fontSize', 'lineHeight', 'textAlign', 'firstLineIndent', 'theme'];
    let best = '';
    let bestScore = Infinity;

    Object.keys(Shared.PRESETS).forEach((name) => {
      const values = Shared.applyPreset(name);
      let score = 0;
      keys.forEach((key) => {
        if (settings[key] === values[key]) score -= 1;
        else score += 3;
      });
      if (values.orientation !== settings.orientation) score += 1;
      if (score < bestScore) {
        bestScore = score;
        best = name;
      }
    });

    return best;
  }

  function applyPreset(name) {
    settings = Shared.applyPreset(name);
    storage.set(SETTINGS_KEY, settings);
    buildForm();
    updatePreview();
    toast('Preset "' + Shared.PRESETS[name].label + '" aplicado.');
  }

  $('#preset').addEventListener('change', (event) => applyPreset(event.target.value));
  $$('.preset-card').forEach((card) => {
    card.addEventListener('click', () => applyPreset(card.dataset.preset));
  });

  /* ==========================================================
     Folha de estilo da pré-visualização
     ========================================================== */

  const PREVIEW_STYLE = document.createElement('style');
  PREVIEW_STYLE.id = 'preview-style';
  document.head.appendChild(PREVIEW_STYLE);

  function previewCss(s) {
    const size = Shared.PAGE_SIZES[s.pageSize];
    const landscape = s.orientation === 'landscape';
    const width = landscape ? size.height : size.width;
    const height = landscape ? size.width : size.height;

    const font = fontCss(s.fontFamily);
    const heading =
      s.headingFontFamily === 'inherit' ? font : fontCss(s.headingFontFamily);

    const muted = mix(s.textColor, s.backgroundColor, 0.45);
    const sizes = [2.05, 1.58, 1.3, 1.14, 1.02, 0.95];
    const headingCss = sizes
      .map((scale, i) => {
        const level = i + 1;
        const margin = s.paragraphSpacing / 3;
        return (
          '#preview-pages h' + level + ' {' +
          'font-size:' + (s.fontSize * scale * s.headingScale).toFixed(2) + 'pt;' +
          'margin:' + (level === 1 ? 0 : margin * 1.8) + 'pt 0 ' + margin * 0.7 + 'pt;' +
          'line-height:1.25;' +
          'color:' + s.headingColor + ';' +
          (level === 1 ? 'border-bottom:1px solid ' + s.accentColor + '55;padding-bottom:6pt;' : '') +
          '}'
        );
      })
      .join('\n');

    const position = s.pageNumberPosition || 'footer-center';
    const onFooter = position.indexOf('footer') === 0;
    const align = position.split('-')[1] || 'center';
    const box = (onFooter ? 'bottom' : 'top') + '-' + align;
    const counterFormat =
      s.pageNumberFormat === 'roman'
        ? 'counter(page, lower-roman)'
        : s.pageNumberFormat === 'arabic-total'
        ? 'counter(page) " / " counter(pages)'
        : 'counter(page)';

    const furniture =
      (s.pageNumbers
        ? '@page { @' + box + ' { content: ' + counterFormat + '; font: ' + (s.fontSize - 2.4).toFixed(1) + 'pt ' + font + '; color: ' + muted + '; } }'
        : '') +
      (s.runningTitle || (s.runningTitle === '' && false)
        ? ''
        : '#preview-pages h1 { string-set: running content(); } @page { @top-left { content: string(running); font: ' +
          (s.fontSize - 2.4).toFixed(1) + 'pt ' + font + '; color: ' + muted + '; } }');

    const listMarker = Shared.LIST_STYLES[s.listStyle].css;

    /* As regras `@font-face` entram junto com o resto do CSS da prévia: é este
       bloco que o Paged.js recebe, e ele precisa da fonte para medir o texto
       na largura certa. */
    const faces = fontsInUse(s).map((item) => item.faces).filter(Boolean).join('\n');

    return `
${faces}
@page {
  size: ${width}mm ${height}mm;
  margin: ${s.margins.top}mm ${s.margins.right}mm ${s.margins.bottom}mm ${s.margins.left}mm;
}
${furniture}

#preview-pages {
  font-family: ${font};
  font-size: ${s.fontSize}pt;
  line-height: ${s.lineHeight};
  letter-spacing: ${s.letterSpacing}pt;
  color: ${s.textColor};
  text-align: ${s.textAlign === 'justify' ? 'justify' : s.textAlign};
  hyphens: ${s.hyphenation ? 'auto' : 'manual'};
}
#preview-pages p { margin: 0 0 ${s.paragraphSpacing}pt; text-indent: ${s.firstLineIndent}mm; }
#preview-pages h1, #preview-pages h2, #preview-pages h3,
#preview-pages h4, #preview-pages h5, #preview-pages h6 {
  font-family: ${heading};
  font-weight: 700;
  letter-spacing: 0;
  /* Título não herda o justify do corpo: com uma palavra por linha ele
     esticaria tudo (palavra na esquerda, outra na direita). */
  text-align: left;
  break-after: avoid;
}
${headingCss}
#preview-pages ul, #preview-pages ol { margin: 0 0 ${s.paragraphSpacing}pt; padding-left: 5mm; }
#preview-pages ul { list-style-type: ${listMarker}; }
#preview-pages li { margin: 0.6mm 0; break-inside: avoid; }
#preview-pages li > ul, #preview-pages li > ol { margin-top: 0.6mm; }
#preview-pages li::marker { color: ${s.accentColor}; }
#preview-pages blockquote {
  margin: ${s.paragraphSpacing / 2}pt 0;
  padding: 2pt 0 2pt 4mm;
  border-left: 2pt solid ${s.accentColor};
  color: ${muted};
}
#preview-pages blockquote p { text-indent: 0; }
#preview-pages hr { border: 0; border-top: 0.6pt solid ${s.borderColor}; margin: ${s.paragraphSpacing * 1.4}pt 0; }
#preview-pages a { color: ${s.linkColor}; text-decoration: underline; }
#preview-pages code {
  font-family: Consolas, "Courier New", monospace;
  font-size: 0.88em;
  color: ${s.codeColor};
}
#preview-pages pre {
  background: ${s.codeBackground};
  border: 0.6pt solid ${s.borderColor};
  border-radius: 2pt;
  padding: 5pt 6pt;
  margin: ${s.paragraphSpacing / 2}pt 0;
  white-space: pre-wrap;
  word-break: break-word;
  break-inside: auto;
  font-size: ${(s.fontSize * 0.82).toFixed(2)}pt;
  line-height: 1.4;
}
#preview-pages pre code { color: inherit; background: none; font-size: 1em; }
#preview-pages table {
  width: 100%;
  border-collapse: collapse;
  margin: ${s.paragraphSpacing / 2}pt 0;
  font-size: ${(s.fontSize * 0.95).toFixed(2)}pt;
}
#preview-pages th, #preview-pages td {
  border: 0.35pt solid ${s.textColor};
  padding: 3pt 4pt;
  text-align: left;
}
#preview-pages th { background: ${mix(s.accentColor, s.backgroundColor, 0.14)}; font-weight: 700; }
#preview-pages tr { break-inside: avoid; }
#preview-pages img { max-width: ${s.imageMaxWidth}%; height: auto; break-inside: avoid; }
  #preview-pages .md-table-wrap { overflow: visible; }
`;
  }

  function mix(a, b, weight) {
    const parse = (hex) => {
      let value = String(hex).replace('#', '');
      if (value.length === 3) value = value.split('').map((c) => c + c).join('');
      return [0, 2, 4].map((i) => parseInt(value.substr(i, 2), 16));
    };
    const ca = parse(a);
    const cb = parse(b);
    const channel = (i) => Math.round(ca[i] * weight + cb[i] * (1 - weight));
    return '#' + [0, 1, 2].map((i) => channel(i).toString(16).padStart(2, '0')).join('');
  }

  /* ==========================================================
     Paginação com Paged.js
     ========================================================== */

  /**
   * Folhas que o Paged.js pode reescrever. Só o CSS do documento entra: as
   * folhas da interface ficam de fora para não terem a cascata remexida.
   */
  const PREVIEW_SHEETS = ['/css/markdown.css'];

  /**
   * Remove os blocos `@media print` de uma folha de estilo.
   *
   * O Paged.js trata a saída paginada como meio de impressão: ele descarta a
   * condição `print` e despeja as regras dela no escopo da tela. O nosso CSS de
   * impressão existe para esconder a interface ao imprimir, e `display: block`
   * em `.split` mais `display: none` em `.split-left`, ambos com
   * `!important`, desmontam a tela dividida: o editor fica com 0x0 e a prévia
   * toma a janela inteira, engolindo o editor e o botão de baixar. Por isso o
   * CSS que o Paged.js recebe precisa chegar sem as regras de impressão.
   */
  function stripPrintRules(css) {
    let out = '';
    let i = 0;
    while (i < css.length) {
      const at = css.indexOf('@media', i);
      if (at === -1) {
        out += css.slice(i);
        break;
      }
      const braceAt = css.indexOf('{', at);
      if (braceAt === -1) {
        out += css.slice(i);
        break;
      }
      const condition = css.slice(at + 6, braceAt);
      // procura o fim do bloco contando { } e pulando comentários
      let depth = 0;
      let j = braceAt;
      for (; j < css.length; j++) {
        const ch = css[j];
        if (ch === '/' && css[j + 1] === '*') {
          j = css.indexOf('*/', j + 2);
          if (j === -1) { j = css.length; }
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) { j++; break; }
      }
      const isPrint = /\bprint\b/i.test(condition) && !/\bnot\b/i.test(condition);
      out += css.slice(i, at);
      if (!isPrint) out += css.slice(at, j);
      i = j;
    }
    return out;
  }

  /**
   * Estilos que o Paged.js deve aplicar ao preview.
   *
   * Só entra o CSS do documento (markdown.css) mais o CSS gerado por
   * `previewCss()`, de onde vêm as regras `@page` — sem ele o Paged.js usa o
   * padrão dele, Letter sem margens, e a prévia não corresponde ao PDF.
   *
   * Mandar `base.css` e `app.css` seria um erro com dois efeitos ruins: o
   * Paged.js reescreve as folhas e as reinyecta no fim do `<head>`, o que
   * embaralha a ordem da cascata da interface inteira, e ele descarta a
   * condição `print` — o `app.css` usa `@media print` para esconder a
   * interface ao imprimir, e vazado para a tela ele desmontava o conversor:
   * editor com 0x0 e a prévia ocupando a janela.
   *
   * As folhas chegam como { url: css }, forma que o Paged.js aceita para o
   * texto puro. Se o fetch falhar, cai para a URL, que é o comportamento
   * anterior. As variáveis de `:root` continuam valendo porque as folhas
   * originais seguem carregadas na página.
   */
  async function pageStylesheets() {
    const wanted = PREVIEW_SHEETS;
    /* `pathname` só existe em <a>. Num <link> o caminho tem de ser tirado do
       href, e sem tirar a query o carimbo ?v= faria a comparação falhar. */
    const links = $$('link[rel="stylesheet"]').filter((link) => {
      let pathname = '';
      try {
        pathname = new URL(link.href, window.location.href).pathname;
      } catch (err) {
        return false;
      }
      return wanted.some((file) => pathname === file);
    });

    const list = await Promise.all(
      links.map(async (link) => {
        try {
          const res = await fetch(link.href, { cache: 'no-cache' });
          if (!res.ok) return link.href;
          return { [link.href]: stripPrintRules(await res.text()) };
        } catch (err) {
          return link.href;
        }
      })
    );

    const css = PREVIEW_STYLE.textContent;
    if (css && css.trim()) {
      list.push({ [window.location.href]: stripPrintRules(css) });
    }
    return list;
  }

  async function updatePreview() {
    const token = ++renderToken;
    const markdown = editor.value;
    storage.set(DRAFT_KEY, markdown);

    PREVIEW_STYLE.textContent = previewCss(settings);
    loading.hidden = false;

    try {
      const result = await render(markdown);
      if (token !== renderToken) return;

      if (!window.Paged || typeof window.Paged.Previewer !== 'function') {
        previewPages.innerHTML =
          '<div class="preview-error">Biblioteca de paginação não carregada.</div>';
        return;
      }

      // A paginação anterior pode ainda estar escrevendo no DOM; esperar ela
      // terminar evita que duas pré-visualizações se sobrescrevam.
      if (previewRun) {
        try { await previewRun; } catch (err) { /* a prévia anterior falhou; seguimos */ }
      }
      if (token !== renderToken) return;

      if (previewer) {
        try { previewer.destroy(); } catch (err) { /* ignora */ }
      }

      previewPages.innerHTML = '';
      previewer = new window.Paged.Previewer();

      /* A fonte externa precisa estar carregada antes da medição: o Paged.js
         quebra as linhas com a largura que o navegador reporta, e com a fonte
         substituta essa largura está errada. */
      await fontsReady(fontsInUse(settings));
      if (token !== renderToken) return;

      const folhas = await pageStylesheets();

      // preview() faz a paginação de forma assíncrona e só resolve quando as
      // folhas já estão no DOM.
      previewRun = previewer.preview(result.html, folhas, previewPages);
      if (previewRun && typeof previewRun.then === 'function') await previewRun;

      if (token !== renderToken) return;

      const pages = previewPages.querySelectorAll('.pagedjs_page').length;
      $('#pages-info').textContent = pages + (pages === 1 ? ' página' : ' páginas');
      applyZoom();
    } catch (err) {
      if (token === renderToken) toast('Erro na pré-visualização: ' + err.message, 'error');
    } finally {
      if (token === renderToken) loading.hidden = true;
    }
  }

  const updatePreviewDebounced = debounce(updatePreview, 350);

  /* ==========================================================
     Zoom
     ========================================================== */

  function applyZoom() {
    const pageWidthEl = previewPages.querySelector('.pagedjs_page');
    const natural = pageWidthEl ? pageWidthEl.offsetWidth : 794;
    const available = previewPane.clientWidth - 48;

    let value = zoom;
    if (!zoom) value = Math.min(1, available / natural);

    previewPages.style.transform = 'scale(' + value + ')';
    previewPages.style.marginBottom = value < 1 ? (previewPages.offsetHeight * (value - 1)) + 'px' : '';
    $('#zoom-label').textContent = Math.round(value * 100) + '%';
    storage.set('md:zoom:pdf', zoom);
    return value;
  }

  function changeZoom(delta) {
    zoom = Math.min(2, Math.max(0.3, (applyZoom() + delta)));
    applyZoom();
  }

  function fitToWidth() {
    const pageWidthEl = previewPages.querySelector('.pagedjs_page');
    if (!pageWidthEl) return;
    zoom = Math.min(1, (previewPane.clientWidth - 48) / pageWidthEl.offsetWidth);
    applyZoom();
  }

  $('#zoom-in').addEventListener('click', () => changeZoom(0.1));
  $('#zoom-out').addEventListener('click', () => changeZoom(-0.1));
  $('#zoom-fit').addEventListener('click', fitToWidth);

  window.addEventListener('resize', debounce(() => applyZoom(), 200));

  /* ==========================================================
     Editor
     ========================================================== */

  editor.addEventListener('input', () => {
    storage.set(DRAFT_KEY, editor.value);
    updatePreviewDebounced();
    updateCounter();
  });

  function updateCounter() {
    const words = editor.value.trim() ? editor.value.trim().split(/\s+/).length : 0;
    $('#counter').textContent = words + (words === 1 ? ' palavra' : ' palavras');
  }

  /* Tab insere espaços; Shift+Tab desfaz a indentação da linha. */
  editor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const value = editor.value;

    if (event.shiftKey) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const prefix = value.slice(lineStart, lineStart + 2);
      if (prefix === '  ') {
        editor.value = value.slice(0, lineStart) + value.slice(lineStart + 2);
        editor.selectionStart = editor.selectionEnd = Math.max(lineStart, start - 2);
      }
      return;
    }

    editor.value = value.slice(0, start) + '  ' + value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
  });

  /* Atalhos de formatação. */
  const WRAPPERS = {
    bold: ['**', '**', 'texto em negrito'],
    italic: ['*', '*', 'texto em itálico'],
    code: ['`', '`', 'código'],
    link: ['[', '](https://)', 'link'],
    h2: ['## ', '', 'Título'],
    ul: ['- ', '', 'item'],
    fence: ['```\n', '\n```', 'código'],
    table: ['| Coluna | Coluna |\n|---|---|\n| valor | valor |\n', '', ''],
    quote: ['> ', '', 'citação'],
  };

  $$('.bar-tools [data-wrap]').forEach((button) => {
    button.addEventListener('click', () => {
      const [before, after, placeholder] = WRAPPERS[button.dataset.wrap] || ['', '', ''];
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const value = editor.value;
      const selected = value.slice(start, end) || placeholder;

      editor.value = value.slice(0, start) + before + selected + after + value.slice(end);
      editor.focus();
      const caret = start + before.length + selected.length;
      editor.selectionStart = editor.selectionEnd = caret;
      editor.dispatchEvent(new Event('input'));
    });
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
      imageTools.insert(editor, imageTools.markdownFor(file, dataUrl), offset);
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
  imageTools.onPaste(editor, (files) => insertImage(files[0], null));

  /* Arrastar para a página mostra a área de soltar; no editor, a imagem
     entra exatamente no ponto do mouse. */
  imageTools.onScreenImageDrop($('#screen-drop'), (files, x, y) => {
    insertImage(files[0], imageTools.insertOffset(editor, x, y));
  });

  /* ==========================================================
     Ações
     ========================================================== */

  function openSettings(force) {
    const open = force !== undefined ? force : !settingsPanel.classList.contains('is-open');
    settingsPanel.classList.toggle('is-open', open);
    settingsPanel.setAttribute('aria-hidden', String(!open));
  }

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-settings-2').addEventListener('click', () => openSettings());
  $('#settings-close').addEventListener('click', () => openSettings(false));
  $('#settings-reset').addEventListener('click', () => {
    settings = JSON.parse(JSON.stringify(Shared.DEFAULTS));
    storage.set(SETTINGS_KEY, settings);
    buildForm();
    updatePreview();
    toast('Configurações restauradas.');
  });

  /* ==========================================================
     Baixar uma fonte do Google Fonts
     ========================================================== */

  const fontInput = $('#font-input');
  const fontButton = $('#font-add');

  async function installFont() {
    const asked = fontInput.value.trim();
    if (!asked) {
      toast('Escreva o nome da fonte ou cole o link do Google Fonts.', 'error');
      fontInput.focus();
      return;
    }

    fontButton.disabled = true;
    const original = fontButton.textContent;
    fontButton.textContent = 'Baixando…';

    try {
      const response = await api('/api/fonts', {
        method: 'POST',
        body: JSON.stringify({ url: asked }),
      });
      const descriptor = await response.json();

      await loadFontStore();
      fontInput.value = '';

      settings.fontFamily = descriptor.key;
      storage.set(SETTINGS_KEY, settings);
      buildForm();
      await updatePreview();
      toast('Fonte "' + descriptor.family + '" baixada e aplicada.');
    } catch (err) {
      toast('Não consegui baixar essa fonte: ' + err.message, 'error');
    } finally {
      fontButton.disabled = false;
      fontButton.textContent = original;
    }
  }

  if (fontButton) fontButton.addEventListener('click', installFont);
  if (fontInput) {
    fontInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        installFont();
      }
    });
  }

  async function download() {
    const button = $('#btn-download');
    const spinner = $('#download-spinner');
    button.disabled = true;
    spinner.hidden = false;

    try {
      const response = await api('/api/pdf', {
        method: 'POST',
        body: JSON.stringify({
          markdown: editor.value,
          settings,
          title: guessTitle(editor.value),
        }),
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileStem(guessTitle(editor.value), 'documento') + '.pdf';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('PDF gerado e baixado.');
    } catch (err) {
      toast('Não foi possível gerar o PDF: ' + err.message, 'error');
    } finally {
      button.disabled = false;
      spinner.hidden = true;
    }
  }

  $('#btn-download').addEventListener('click', download);

  $('#btn-print').addEventListener('click', async () => {
    settingsPanel.classList.remove('is-open');
    /* Se a paginação ainda estiver rodando, o navegador imprimiria uma
       página em branco ("Salvar como PDF" do próprio navegador). Espera a
       prévia terminar — ou pelo menos avisa quando nada foi paginado. */
    if (previewRun) {
      try { await previewRun; } catch (err) { /* segue e avisa abaixo */ }
    }
    const pages = previewPages.querySelectorAll('.pagedjs_page').length;
    if (!pages) {
      toast('A paginação ainda não terminou; tente imprimir de novo.', 'error');
      return;
    }
    toast('Use "Salvar como PDF" na janela de impressão.', 'info');
    setTimeout(() => window.print(), 350);
  });

  $('#btn-md').addEventListener('click', () => {
    const name = fileStem(guessTitle(editor.value), 'documento');
    downloadFile(name + '.md', editor.value);
    toast('Baixado ' + name + '.md');
  });

  $('#btn-open').addEventListener('click', async () => {
    const file = await pickFile();
    if (!file) return;
    editor.value = file.text;
    updatePreview();
    updateCounter();
    toast('Arquivo "' + file.name + '" aberto.');
  });

  $('#btn-save').addEventListener('click', async () => {
    try {
      await api('/api/library', {
        method: 'POST',
        body: JSON.stringify({
          title: guessTitle(editor.value),
          content: editor.value,
          kind: 'pdf',
          settings,
        }),
      });
      toast('Salvo na biblioteca (texto e configurações).');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-split').addEventListener('click', () => {
    const split = $('.split');
    split.classList.toggle('is-editor-collapsed');
    applyZoom();
  });

  /* ==========================================================
     Atalhos de teclado
     ========================================================== */

  onKeys((event) => {
    const typing = isTyping(event.target);

    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      download();
      return;
    }

    if (event.key === 'Escape') {
      openSettings(false);
      return;
    }

    if (typing) {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === 'b') { event.preventDefault(); $('[data-wrap="bold"]').click(); }
        if (key === 'i') { event.preventDefault(); $('[data-wrap="italic"]').click(); }
      }
      return;
    }

    if (event.key.toLowerCase() === 'g') openSettings();
  });

  /* ==========================================================
     Divisor arrastável entre editor e pré-visualização
     ========================================================== */

  const split = $('.split');
  split.insertBefore(document.createElement('div'), split.children[1]);
  const splitter = split.children[1];
  splitter.className = 'splitter';

  let dragging = false;

  splitter.addEventListener('pointerdown', (event) => {
    dragging = true;
    splitter.classList.add('is-dragging');
    splitter.setPointerCapture(event.pointerId);
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const vertical = window.innerWidth <= 980;
    const ratio = vertical
      ? (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
    split.style.setProperty(
      '--split-left',
      'minmax(280px, ' + Math.round(ratio * 100) + '%)'
    );
    split.style.gridTemplateColumns = vertical ? '' : 'minmax(280px, ' + Math.round(ratio * 100) + '%) 6px 1fr';
    applyZoom();
  });

  splitter.addEventListener('pointerup', (event) => {
    dragging = false;
    splitter.classList.remove('is-dragging');
    splitter.releasePointerCapture(event.pointerId);
  });

  /* ==========================================================
     Inicialização
     ========================================================== */

  const STARTER = [
    '# Convertendo markdown em PDF',
    '',
    'Escreva à esquerda e veja o resultado paginado à direita.',
    'Tudo que você ajusta no painel **⚙ Ajustes** aparece no PDF baixado.',
    '',
    '## Formatação',
    '',
    '- **Negrito**, *itálico*, `código` e [links](https://example.com).',
    '- Listas ordenadas:',
    '',
    '1. primeiro passo;',
    '2. segundo passo;',
    '3. terceiro passo.',
    '',
    '## Código',
    '',
    '```javascript',
    'function saudacao(nome) {',
    '  return `Olá, ${nome}!`;',
    '}',
    '```',
    '',
    '## Tabela',
    '',
    '| Item | Valor |',
    '|:-----|------:|',
    '| A    |     1 |',
    '| B    |     2 |',
    '',
    '> Bloco de citação para destacar um aviso.',
  ].join('\n');

  (async function init() {
    /* As fontes externas vêm do servidor e determinam o conteúdo dos selects de
       fonte, então a lista é buscada antes do primeiro `buildForm()`. Sem
       await, a primeira prévia sairia com Times e depois trocaria sozinha. */
    await loadFontStore();

    buildForm();

    const params = new URLSearchParams(window.location.search);

    // Texto vindo da home tem prioridade; depois o rascunho local; depois o exemplo.
    const incoming = handoff.take('pdf');
    let initial = incoming
      ? incoming.markdown
      : editor.value || draftText(DRAFT_KEY, '') || STARTER;

    const docId = params.get('doc');
    if (docId) {
      try {
        const item = await (await api('/api/library/' + encodeURIComponent(docId))).json();
        initial = item.content;
        if (item.settings) {
          settings = Object.assign({}, Shared.DEFAULTS, item.settings);
          storage.set(SETTINGS_KEY, settings);
          buildForm();
        }
      } catch (err) {
        /* segue com o padrão */
      }
    } else if (incoming && incoming.settings) {
      settings = Object.assign({}, Shared.DEFAULTS, incoming.settings);
      buildForm();
    }

    editor.value = initial;
    updateCounter();
    await updatePreview();
  })();
})();