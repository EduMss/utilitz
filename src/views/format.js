'use strict';

const { layout } = require('./layout');
const { CATALOG } = require('../../public/js/format-core.js');

const GROUP_LABELS = {
  geral: 'Detecção',
  arquivo: 'Formatos de arquivo',
  codigo: 'Linguagens de programação',
};

/** Opções do seletor de tipo, agrupadas por categoria. */
function typeOptions() {
  let group = null;
  let html = '';

  for (const item of CATALOG) {
    if (item.group !== group) {
      if (group !== null) html += '</optgroup>';
      html += `<optgroup label="${GROUP_LABELS[item.group] || ''}">`;
      group = item.group;
    }
    html += `<option value="${item.value}">${item.label}</option>`;
  }
  if (group !== null) html += '</optgroup>';
  return html;
}

function format() {
  return layout({
    title: 'Formatar arquivos',
    description:
      'Formate JSON, XML, HTML, Markdown, CSV, texto e código (Python, C#, Java...) com prévia realçada e números de linha, tudo no navegador.',
    active: '/formatar',
    bodyClass: 'page-format',
    scripts: ['/vendor/hljs.js', '/js/format-core.js', '/js/format.js'],
    body: `
<main class="home fmt">
  <section class="hero fmt-hero">
    <p class="eyebrow">Formatação 100% no navegador</p>
    <h1>Cole, formate e <span class="grad">leia</span> sem sofrer.</h1>
    <p class="lead">
      JSON, XML, HTML, Markdown, CSV, texto e código — Python, C#, Java e o resto.
      O conteúdo sai arrumado, com realce de sintaxe e número de linha: o que
      estava tudo em uma única linha vira algo que dá para ler.
    </p>
    <div class="hero-actions">
      <button type="button" class="btn btn-primary" id="fmt-open">Abrir arquivo</button>
      <button type="button" class="btn btn-ghost" id="fmt-clear">Limpar tudo</button>
    </div>
  </section>

  <section class="convi-drop fmt-drop" id="fmt-drop">
    <input type="file" id="file-input" hidden>
    <div class="convi-drop-inner">
      <strong>Arraste um arquivo para cá</strong>
      <span>ou clique para escolher — .json, .xml, .html, .md, .csv, .txt, .py, .cs, .java, .js e companhia.</span>
    </div>
  </section>

  <section class="convi-panel fmt-options" id="fmt-options">
    <div class="convi-group fmt-group">
      <h4>Tipo do conteúdo</h4>
      <select id="fmt-type" class="select">${typeOptions()}</select>
      <p class="set-hint" id="fmt-detect">Detectando…</p>
    </div>

    <div class="convi-group fmt-group" id="grp-indent">
      <h4>Recuo</h4>
      <select id="fmt-indent" class="select">
        <option value="keep">Manter o recuo atual</option>
        <option value="2">2 espaços</option>
        <option value="4">4 espaços</option>
        <option value="tab">Tabulações</option>
      </select>
      <p class="set-hint" id="grp-indent-hint"></p>
      <label class="set-check" id="grp-reindent" hidden>
        <input type="checkbox" id="fmt-reindent">
        <span>Recalcular os níveis de recuo com essa unidade</span>
      </label>
    </div>

    <div class="convi-group fmt-group" id="grp-clean">
      <h4>Limpeza</h4>
      <label class="set-check">
        <input type="checkbox" id="opt-crlf" checked>
        <span>Quebras de linha <code>\\r\\n</code> viram <code>\\n</code></span>
      </label>
      <label class="set-check">
        <input type="checkbox" id="opt-trailing" checked>
        <span>Remover espaços no fim da linha</span>
      </label>
      <label class="set-check">
        <input type="checkbox" id="opt-blank" checked>
        <span>Juntar linhas em branco repetidas</span>
      </label>
      <label class="set-check">
        <input type="checkbox" id="opt-edges" checked>
        <span>Sem linha vazia no começo e no fim</span>
      </label>
    </div>

    <div class="convi-group fmt-group" id="grp-text" hidden>
      <h4>Texto simples</h4>
      <label class="set-check">
        <input type="checkbox" id="opt-unescape">
        <span>Converter <code>\\n</code> em quebra de linha</span>
      </label>
      <label class="set-check">
        <input type="checkbox" id="opt-one-line">
        <span>Virar string de uma linha só — quebras viram <code>\\n</code>, aspas <code>\\"</code> e barras <code>\\\\</code></span>
      </label>
      <p class="set-hint" id="text-hint">
        Marque quando o texto veio colado em uma linha só e as quebras aparecem
        como a sequência <code>\\n</code>.
      </p>
    </div>

    <div class="convi-group fmt-group" id="grp-json" hidden>
      <h4>JSON escapado</h4>
      <label class="set-check">
        <input type="checkbox" id="opt-remove-escapes">
        <span>Remover 1 nível de escape (<code>\\n</code>, <code>\\"</code>, <code>\\\\</code>)</span>
      </label>
      <p class="set-hint" id="json-hint">
        Use quando o JSON chegou como string escapada — de uma linha só, cheia
        de <code>\\n</code> e <code>\\"</code> — e precisa voltar a ser JSON de
        verdade.
      </p>
    </div>

    <div class="convi-group fmt-group" id="grp-csv" hidden>
      <h4>CSV</h4>
      <p class="set-hint">
        As colunas são lidas respeitando aspas, com o delimitador detectado
        entre <code>,</code>, <code>;</code>, tabulação e <code>|</code>. A
        saída vira uma tabela markdown com as colunas alinhadas.
      </p>
    </div>
  </section>

  <section class="fmt-split">
    <div class="fmt-pane">
      <header class="fmt-pane-head">
        <strong>Entrada</strong>
        <span class="muted" id="fmt-source">colado na página</span>
      </header>
      <textarea id="fmt-input" class="fmt-editor" spellcheck="false"
        placeholder="Cole aqui o conteúdo — ou solte um arquivo em qualquer canto da página."></textarea>
      <div class="fmt-samples" id="fmt-samples"></div>
      <div class="fmt-foot fmt-in-foot">
        <span class="muted" id="fmt-in-stats">—</span>
        <span class="grow"></span>
        <span class="muted">Bom para arquivos de até 4 MB</span>
      </div>
    </div>

    <div class="fmt-pane fmt-pane-out">
      <header class="fmt-pane-head">
        <strong>Saída</strong>
        <span class="fmt-badge" id="fmt-badge">—</span>
        <span class="grow"></span>
        <button type="button" class="btn btn-soft btn-sm" id="fmt-copy">Copiar</button>
        <button type="button" class="btn btn-primary btn-sm" id="fmt-download">Baixar</button>
      </header>
      <div class="fmt-error" id="fmt-error" hidden></div>
      <div class="fmt-preview" id="fmt-preview">
        <p class="fmt-empty">A versão formatada aparece aqui.</p>
      </div>
      <div class="fmt-foot fmt-out-foot">
        <span class="muted" id="fmt-out-stats">—</span>
        <span class="grow"></span>
        <span class="muted" id="fmt-warnings"></span>
      </div>
    </div>
  </section>

  <footer class="foot">
    <span>Tudo acontece no seu navegador · nada é enviado para o servidor</span>
  </footer>
</main>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { format };
