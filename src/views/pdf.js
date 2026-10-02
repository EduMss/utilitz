'use strict';

const { layout } = require('./layout');

function pdf() {
  return layout({
    title: 'Converter para PDF',
    active: '/pdf',
    chrome: false,
    bodyClass: 'page-pdf',
    scripts: ['/vendor/paged.js', '/js/pdf.js'],
    body: `
<div class="split">

  <section class="split-left" id="editor-pane">
    <header class="bar">
      <a class="brand-mark bar-back" href="/" title="Voltar ao início" aria-label="Voltar ao início">M↓</a>
      <div class="bar-title">
        <strong>Markdown</strong>
        <span class="muted" id="counter">0 palavras</span>
      </div>
      <div class="bar-tools">
        <button type="button" class="icon-btn" data-wrap="bold" title="Negrito (Ctrl+B)"><b>B</b></button>
        <button type="button" class="icon-btn" data-wrap="italic" title="Itálico (Ctrl+I)"><i>I</i></button>
        <button type="button" class="icon-btn" data-wrap="code" title="Código">&lt;/&gt;</button>
        <button type="button" class="icon-btn" data-wrap="link" title="Link">🔗</button>
        <button type="button" class="icon-btn" data-wrap="h2" title="Título">H</button>
        <button type="button" class="icon-btn" data-wrap="ul" title="Lista">•</button>
        <button type="button" class="icon-btn" data-wrap="fence" title="Bloco de código">▤</button>
        <button type="button" class="icon-btn" data-wrap="table" title="Tabela">▦</button>
        <button type="button" class="icon-btn" data-wrap="quote" title="Citação">❝</button>
      </div>
      <div class="bar-actions">
        <button type="button" class="icon-btn" id="btn-open" title="Abrir .md">📂</button>
        <button type="button" class="icon-btn" id="btn-md" title="Baixar .md">⬇</button>
        <button type="button" class="icon-btn" id="btn-print" title="Imprimir pelo navegador">🖨</button>
        <button type="button" class="icon-btn" id="btn-save" title="Salvar na biblioteca">🔖</button>
        <button type="button" class="icon-btn" id="btn-settings" title="Configurações do PDF">⚙</button>
      </div>
    </header>

    <textarea id="source" class="editor" spellcheck="false"
      placeholder="# Escreva ou cole seu markdown&#10;&#10;O PDF é montado enquanto você digita."></textarea>

    <footer class="bar bar-foot">
      <select id="preset" class="select" title="Presets"></select>
      <span class="muted" id="pages-info">— páginas</span>
      <span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-settings-2">Ajustes</button>
      <button type="button" class="btn btn-primary btn-sm" id="btn-download">
        Baixar PDF <span id="download-spinner" class="spinner" hidden></span>
      </button>
    </footer>
  </section>

  <section class="split-right" id="preview-pane">
    <header class="bar bar-preview">
      <div class="bar-title">
        <strong>Pré-visualização</strong>
        <span class="muted" id="preview-note">paginação real</span>
      </div>
      <div class="bar-tools">
        <button type="button" class="icon-btn" id="zoom-out" title="Diminuir">−</button>
        <span class="zoom-label" id="zoom-label">100%</span>
        <button type="button" class="icon-btn" id="zoom-in" title="Aumentar">+</button>
        <button type="button" class="icon-btn" id="zoom-fit" title="Ajustar à largura">⤢</button>
        <button type="button" class="icon-btn" id="btn-split" title="Dividir Equally">◫</button>
      </div>
    </header>
    <div class="preview" id="preview">
      <div class="preview-pages" id="preview-pages"></div>
    </div>
    <div class="preview-loading" id="preview-loading" hidden><span class="spinner big"></span></div>
  </section>
</div>

<aside class="settings" id="settings" aria-hidden="true">
  <header class="settings-head">
    <strong>Configurações do PDF</strong>
    <button type="button" class="icon-btn" id="settings-close" title="Fechar">✕</button>
  </header>

  <div class="settings-body">

    <div class="set-group">
      <h4>Modelo rápido</h4>
      <div class="set-row" id="preset-cards"></div>
    </div>

    <div class="set-group">
      <h4>Página</h4>
      <div class="set-row two">
        <label>Tamanho
          <select id="pageSize" class="select"></select>
        </label>
        <label>Orientação
          <select id="orientation" class="select">
            <option value="portrait">Retrato</option>
            <option value="landscape">Paisagem</option>
          </select>
        </label>
      </div>
      <div class="set-row four">
        <label>Margem sup.<input type="number" id="marginTop" min="5" max="80" step="1"></label>
        <label>Margem dir.<input type="number" id="marginRight" min="5" max="80" step="1"></label>
        <label>Margem inf.<input type="number" id="marginBottom" min="5" max="80" step="1"></label>
        <label>Margem esq.<input type="number" id="marginLeft" min="5" max="80" step="1"></label>
      </div>
      <p class="set-hint">Margens em milímetros.</p>
    </div>

    <div class="set-group">
      <h4>Tipografia</h4>
      <div class="set-row two">
        <label>Fonte do texto<select id="fontFamily" class="select"></select></label>
        <label>Fonte dos títulos<select id="headingFontFamily" class="select"></select></label>
      </div>
      <div class="set-row font-add">
        <label class="grow">Fonte do Google
          <input type="text" id="font-input" class="text-input" list="font-suggestions"
            placeholder="Lora ou link do Google Fonts" autocomplete="off" spellcheck="false">
          <datalist id="font-suggestions"></datalist>
        </label>
        <button type="button" class="btn btn-sm btn-ghost" id="font-add">Baixar</button>
      </div>
      <p class="set-hint">
        Aceita o nome da família (<code>Lora</code>) ou o link
        <code>fonts.googleapis.com/css2?family=…</code>. Os quatro estilos são
        baixados e embutidos no PDF.
      </p>
      <label class="set-slider">Corpo do texto
        <span class="set-value" id="fontSizeValue"></span>
        <input type="range" id="fontSize" min="6" max="28" step="0.5">
      </label>
      <label class="set-slider">Entrelinha
        <span class="set-value" id="lineHeightValue"></span>
        <input type="range" id="lineHeight" min="1" max="3" step="0.05">
      </label>
      <label class="set-slider">Espaço entre parágrafos
        <span class="set-value" id="paragraphSpacingValue"></span>
        <input type="range" id="paragraphSpacing" min="0" max="40" step="1">
      </label>
      <label class="set-slider">Escala dos títulos
        <span class="set-value" id="headingScaleValue"></span>
        <input type="range" id="headingScale" min="0.8" max="2.5" step="0.05">
      </label>
      <label class="set-slider">Recuo da 1ª linha
        <span class="set-value" id="firstLineIndentValue"></span>
        <input type="range" id="firstLineIndent" min="0" max="40" step="1">
      </label>
      <div class="set-row two">
        <label>Alinhamento<select id="textAlign" class="select">
          <option value="justify">Justificado</option>
          <option value="left">Esquerda</option>
          <option value="center">Centro</option>
          <option value="right">Direita</option>
        </select></label>
        <label>Marcadores<select id="listStyle" class="select"></select></label>
      </div>
    </div>

    <div class="set-group">
      <h4>Cores</h4>
      <div class="set-row">
        <label>Tema
          <select id="theme" class="select"></select>
        </label>
      </div>
      <div class="set-row swatches">
        <label>Texto<input type="color" id="textColor"></label>
        <label>Títulos<input type="color" id="headingColor"></label>
        <label>Links<input type="color" id="linkColor"></label>
        <label>Código<input type="color" id="codeColor"></label>
        <label>Realce<input type="color" id="accentColor"></label>
        <label>Fundo<input type="color" id="backgroundColor"></label>
        <label>Bordas<input type="color" id="borderColor"></label>
        <label>Fundo código<input type="color" id="codeBackground"></label>
      </div>
    </div>

    <div class="set-group">
      <h4>Cabeçalho, rodapé e sumário</h4>
      <div class="set-row two">
        <label>Posição
          <select id="pageNumberPosition" class="select"></select>
        </label>
        <label>Formato
          <select id="pageNumberFormat" class="select">
            <option value="arabic">1, 2, 3</option>
            <option value="arabic-total">1 / 12</option>
            <option value="roman">I, II, III</option>
          </select>
        </label>
      </div>
      <label class="set-check">
        <input type="checkbox" id="pageNumbers"> Mostrar numeração das páginas
      </label>
      <label>Título corrido (opcional)
        <input type="text" id="runningTitle" class="text-input" placeholder="Usa o título do documento">
      </label>
      <label class="set-check">
        <input type="checkbox" id="showToc"> Gerar sumário no início
      </label>
      <label class="set-slider">Níveis do sumário
        <span class="set-value" id="tocDepthValue"></span>
        <input type="range" id="tocDepth" min="1" max="6" step="1">
      </label>
    </div>

    <div class="set-group">
      <h4>Detalhes</h4>
      <label class="set-slider">Largura das imagens
        <span class="set-value" id="imageMaxWidthValue"></span>
        <input type="range" id="imageMaxWidth" min="20" max="100" step="5">
      </label>
      <label class="set-check"><input type="checkbox" id="figureCaption"> Legenda nas imagens</label>
      <label class="set-check"><input type="checkbox" id="syntaxHighlight"> Realçar código</label>
      <label class="set-check"><input type="checkbox" id="hyphenation"> Hifenizar palavras longas</label>
    </div>

  </div>

  <footer class="settings-foot">
    <button type="button" class="btn btn-ghost btn-sm" id="settings-reset">Restaurar padrão</button>
    <span class="grow"></span>
    <span class="muted" id="settings-saved">salvo automaticamente</span>
  </footer>
</aside>

<div class="toast" id="toast" role="status"></div>
<input type="file" id="file-input" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden>
`,
  });
}

module.exports = { pdf };