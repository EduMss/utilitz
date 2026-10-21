'use strict';

const { layout } = require('./layout');

/**
 * Visualizador de logs: JSON, NDJSON, CSV, TSV e XLSX entram pelo lado do
 * navegador (SheetJS em public/vendor), viram uma tabela "planilha" com
 * pesquisa, filtros por coluna, ordenação, paginação e exportação para CSV
 * e Excel. Nada é enviado ao servidor.
 */
function logs() {
  return layout({
    title: 'Logs',
    description: 'Abra logs e planilhas (JSON, CSV, XLSX) e visualize como tabela com filtros, pesquisa e exportação para CSV e Excel.',
    active: '/logs',
    bodyClass: 'page-logs',
    scripts: ['/vendor/xlsx.min.js', '/js/log-core.js', '/js/logs.js'],
    body: `
<main class="logv">
  <section class="hero logv-hero">
    <p class="eyebrow">Planilha viva, 100% no navegador</p>
    <h1>Seus <span class="grad">logs</span>, modo planilha</h1>
    <p class="lead">
      Solte um arquivo JSON, NDJSON, CSV, TSV ou Excel e ele vira uma tabela:
      colunas detectadas, filtradas, ordenadas, pesquisadas e exportadas de
      volta para CSV ou Excel. Seus dados não saem da sua máquina.
    </p>
  </section>

  <div class="logv-chrome" id="logv-chrome" hidden>
    <div class="logv-bar">
      <input type="search" id="logv-search" class="text-input logv-search"
             placeholder="Pesquisar em todas as colunas…" spellcheck="false">
      <span class="muted" id="logv-status"></span>
      <button type="button" class="btn btn-ghost btn-sm" id="logv-clear" hidden>Limpar filtros</button>
      <span class="grow"></span>

      <select id="logv-sheet" class="select logv-sheet" hidden></select>

      <div class="logv-pop-wrap">
        <button type="button" class="btn btn-ghost btn-sm" id="logv-columns-btn">Colunas</button>
        <div class="logv-pop logv-pop-menu" id="logv-columns-pop" hidden></div>
      </div>

      <div class="logv-pop-wrap">
        <button type="button" class="btn btn-ghost btn-sm" id="logv-export-btn">Exportar</button>
        <div class="logv-pop logv-pop-menu" id="logv-export-pop" hidden>
          <button type="button" class="logv-menu-item" data-export="xlsx">
            <b>Excel (.xlsx)</b><span>Tabela com cabeçalho</span>
          </button>
          <button type="button" class="logv-menu-item" data-export="csv">
            <b>CSV (vírgula)</b><span>Delimitado por vírgulas</span>
          </button>
          <button type="button" class="logv-menu-item" data-export="csv-semicolon">
            <b>CSV (ponto e vírgula)</b><span>Abre direto no Excel em pt-BR</span>
          </button>
          <button type="button" class="logv-menu-item" data-export="copy">
            <b>Copiar</b><span>Colunas visíveis, pronto pra colar em planilha</span>
          </button>
        </div>
      </div>

      <button type="button" class="btn btn-ghost btn-sm" id="logv-reload">Trocar arquivo</button>
    </div>

    <div class="logv-table-wrap" id="logv-table-wrap">
      <table class="logv-table" id="logv-table">
        <thead id="logv-thead"></thead>
        <tbody id="logv-tbody"></tbody>
      </table>
      <div class="logv-no-match" id="logv-no-match" hidden>
        <span id="logv-nomatch-text">Nenhuma linha atende aos filtros.</span>
        <button type="button" class="btn btn-ghost btn-sm" id="logv-clear-2">Limpar filtros</button>
      </div>
    </div>

    <div class="logv-pager">
      <span class="muted" id="logv-pager-info"></span>
      <span class="grow"></span>
      <label class="logv-pagesize">
        Linhas por página
        <select id="logv-page-size" class="select">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="250">250</option>
          <option value="500">500</option>
          <option value="1000">1000</option>
          <option value="0">Tudo</option>
        </select>
      </label>
      <button type="button" class="btn btn-ghost btn-sm" id="logv-page-prev" title="Página anterior">←</button>
      <span class="muted logv-page-now" id="logv-page-now">1</span>
      <button type="button" class="btn btn-ghost btn-sm" id="logv-page-next" title="Próxima página">→</button>
    </div>
  </div>

  <section class="logv-drop" id="logv-drop">
    <input type="file" id="logv-input" hidden
           accept=".json,.ndjson,.jsonl,.csv,.tsv,.txt,.log,.xlsx,.xls,.ods">
    <div class="logv-drop-inner">
      <strong>Solte um arquivo de log aqui</strong>
      <span>JSON, NDJSON, CSV, TSV, .log (IIS, pm2/Nest), XLSX, XLS ou ODS — ou clique para escolher. O conteúdo é lido no navegador.</span>
    </div>
  </section>

  <div class="logv-alt" id="logv-alt">
    <button type="button" class="btn btn-ghost btn-sm" id="logv-paste-btn">Colar dados (JSON ou CSV)</button>
    <button type="button" class="btn btn-ghost btn-sm" id="logv-sample-btn">Carregar exemplo</button>
  </div>

  <footer class="foot">
    <span>Leitura, filtragem e exportação acontecem no seu navegador · nada é enviado para o servidor</span>
  </footer>
</main>

<div class="logv-modal-backdrop" id="logv-modal" hidden>
  <div class="logv-modal">
    <div class="logv-modal-head">
      <strong>Colar dados</strong>
      <button type="button" class="btn btn-ghost btn-sm" id="logv-paste-close" aria-label="Fechar">✕</button>
    </div>
    <textarea id="logv-paste-text" class="logv-modal-text" rows="12" wrap="off"
              placeholder='Cole aqui. Exemplos aceitos:
[{"nivel":"erro","msg":"timeout","tempo_ms":3000}, …]
{"nivel": "info", "msg": "ok"} (um objeto por linha — NDJSON)
nivel,msg,tempo_ms
erro,timeout,3000'></textarea>
    <div class="logv-modal-actions">
      <span class="muted">JSON, NDJSON ou CSV — detectamos o formato.</span>
      <span class="grow"></span>
      <button type="button" class="btn btn-primary btn-sm" id="logv-paste-load">Carregar</button>
    </div>
  </div>
</div>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { logs };
