/* =========================================================
   Formatação de arquivos (página /formatar)

   Módulo puro: não toca no DOM e não depende de highlight.js,
   para que o mesmo código rode no navegador e nos testes de
   `scripts/test-format.js`.

   O que ele faz, por família de arquivo:

   - json      recuo com `JSON.stringify` (e erro com linha/coluna
               quando a sintaxe não fecha); com a opção ligada,
               remove um nível de escape antes de ler — JSON que
               veio como string (`"{\"a\": 1}"`) volta a ser JSON;
   - xml/html  impressão em árvore: uma tag por linha, texto curto
               no mesmo lance da tag, conteúdo bruto de pre/script
               intacto;
   - markdown  espaços no fim, cercas de código, listas, títulos ATX,
               setext -> ATX e linha em branco sobrando — tudo fora
               das cercas de código;
   - csv       leitura respeitando aspas e saída como tabela markdown
               com as colunas alinhadas;
   - text      limpeza de linhas + (opcional) `\n` literal vira
               quebra de linha de verdade, ou o contrário: escapa
               quebras, aspas e barras e junta tudo em uma linha
               só (vira string);
   - code      fim de linha, tabs <-> espaços e, se pedido, o recuo
               é recalculado para a unidade escolhida.

   A detecção começa pela extensão do arquivo e, se ela não diz
   nada, cai para o conteúdo.
   ========================================================= */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MDFormat = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  /* ---------------------------------------------------------
     Catálogo de tipos
     --------------------------------------------------------- */

  const CATALOG = [
    { value: 'auto', label: 'Detectar automaticamente', group: 'geral' },

    { value: 'json', label: 'JSON', group: 'arquivo' },
    { value: 'xml', label: 'XML', group: 'arquivo' },
    { value: 'html', label: 'HTML', group: 'arquivo' },
    { value: 'markdown', label: 'Markdown', group: 'arquivo' },
    { value: 'csv', label: 'CSV (tabela)', group: 'arquivo' },
    { value: 'text', label: 'Texto simples', group: 'arquivo' },

    { value: 'python', label: 'Python', group: 'codigo' },
    { value: 'csharp', label: 'C#', group: 'codigo' },
    { value: 'java', label: 'Java', group: 'codigo' },
    { value: 'javascript', label: 'JavaScript', group: 'codigo' },
    { value: 'typescript', label: 'TypeScript', group: 'codigo' },
    { value: 'c', label: 'C', group: 'codigo' },
    { value: 'cpp', label: 'C++', group: 'codigo' },
    { value: 'go', label: 'Go', group: 'codigo' },
    { value: 'rust', label: 'Rust', group: 'codigo' },
    { value: 'kotlin', label: 'Kotlin', group: 'codigo' },
    { value: 'swift', label: 'Swift', group: 'codigo' },
    { value: 'php', label: 'PHP', group: 'codigo' },
    { value: 'ruby', label: 'Ruby', group: 'codigo' },
    { value: 'lua', label: 'Lua', group: 'codigo' },
    { value: 'perl', label: 'Perl', group: 'codigo' },
    { value: 'r', label: 'R', group: 'codigo' },
    { value: 'sql', label: 'SQL', group: 'codigo' },
    { value: 'yaml', label: 'YAML', group: 'codigo' },
    { value: 'shell', label: 'Shell / Bash', group: 'codigo' },
    { value: 'ini', label: 'INI / configuração', group: 'codigo' },
    { value: 'css', label: 'CSS', group: 'codigo' },
    { value: 'scss', label: 'SCSS', group: 'codigo' },
    { value: 'graphql', label: 'GraphQL', group: 'codigo' },
    { value: 'makefile', label: 'Makefile', group: 'codigo' },
    { value: 'diff', label: 'Diff / patch', group: 'codigo' },
    { value: 'vbnet', label: 'VB.NET', group: 'codigo' },
    { value: 'objectivec', label: 'Objective-C', group: 'codigo' },
    { value: 'wasm', label: 'WebAssembly', group: 'codigo' },
  ];

  const BY_VALUE = new Map(CATALOG.map((item) => [item.value, item]));

  /** Família estrutural: é ela que decide qual formatação roda. */
  function familyOf(value) {
    if (value === 'json') return 'json';
    if (value === 'xml') return 'xml';
    if (value === 'html') return 'html';
    if (value === 'markdown') return 'markdown';
    if (value === 'csv') return 'csv';
    if (value === 'text') return 'text';
    return 'code';
  }

  /** Linguagem do highlight.js usada para colorir a saída. */
  function languageOf(value) {
    if (value === 'html') return 'xml';
    if (value === 'csv' || value === 'text') return 'plaintext';
    return value;
  }

  /** Descrição de um valor do catálogo. */
  function describe(value) {
    const item = BY_VALUE.get(value) || BY_VALUE.get('text');
    const resolved = item.value === 'auto' ? BY_VALUE.get('text') : item;
    return {
      value: resolved.value,
      label: resolved.label,
      family: familyOf(resolved.value),
      language: languageOf(resolved.value),
    };
  }

  /* ---------------------------------------------------------
     Opções
     --------------------------------------------------------- */

  const DEFAULTS = {
    /* limpeza geral */
    crlf: true,          // \r\n e \r viram \n
    trailing: true,      // espaços/tabulações no fim da linha
    blank: true,         // sequência de linhas em branco vira uma só
    edges: true,         // sem linha vazia no começo e no fim
    /* recuo */
    indent: 'keep',      // 'keep' | '2' | '4' | 'tab'
    reindent: false,     // recalcula os níveis com a unidade escolhida
    /* texto */
    unescapeNewlines: false, // `\n` literal vira quebra de linha
    escapeToOneLine: false,  // escapa e junta tudo em uma linha só
    /* json */
    removeEscapes: false,    // remove 1 nível de escape antes de ler
  };

  /** Aceita parcial, completa com os padrões e só reconhece chaves conhecidas. */
  function resolveOptions(partial) {
    const opts = Object.assign({}, DEFAULTS, partial || {});
    opts.crlf = !!opts.crlf;
    opts.trailing = !!opts.trailing;
    opts.blank = !!opts.blank;
    opts.edges = !!opts.edges;
    opts.reindent = !!opts.reindent;
    opts.unescapeNewlines = !!opts.unescapeNewlines;
    opts.escapeToOneLine = !!opts.escapeToOneLine;
    opts.removeEscapes = !!opts.removeEscapes;
    if (['keep', '2', '4', 'tab'].indexOf(String(opts.indent)) === -1) opts.indent = 'keep';
    else opts.indent = String(opts.indent);
    return opts;
  }

  /** Largura de uma tabulação quando a unidade é espaço. */
  function unitOf(indent) {
    return indent === '2' ? 2 : 4;
  }

  /* ---------------------------------------------------------
     Utilidades de linha
     --------------------------------------------------------- */

  /** Expande as tabulações iniciais de uma string de recuo. */
  function expandLeading(leading, tabWidth) {
    let width = 0;
    for (let i = 0; i < leading.length; i++) {
      width = leading[i] === '\t' ? width + (tabWidth - (width % tabWidth)) : width + 1;
    }
    return width;
  }

  /** Monta a string de recuo de `columns` colunas no estilo pedido. */
  function makeLeading(columns, style, tabWidth) {
    if (style === 'tab') {
      const tabs = Math.floor(columns / tabWidth);
      return '\t'.repeat(tabs) + ' '.repeat(columns - tabs * tabWidth);
    }
    return ' '.repeat(Math.max(0, columns));
  }

  /** Tira o espaço do fim, mas mantém a quebra dura de duas linhas do markdown. */
  function stripTrailing(lines) {
    return lines.map((line) => line.replace(/[ \t]+$/, ''));
  }

  /**
   * Espaço no fim de linha, com a quebra dura do markdown preservada: duas
   * linhas coladas (sem linha em branco entre elas) terminando em espaço
   * significam `<br>` e não são sujeira.
   */
  function trimHardBreak(line, next) {
    if (next !== undefined && next.trim() !== '') {
      const tail = line.match(/[ \t]+$/);
      if (tail && tail[0].length >= 2) return line.replace(/[ \t]+$/, '  ');
    }
    return line.replace(/[ \t]+$/, '');
  }

  /** Converte a unidade de recuo de cada linha (tabs <-> espaços). */
  function convertLeading(lines, indent) {
    if (indent === 'keep') return lines;
    const toTabs = indent === 'tab';
    const width = toTabs ? 4 : unitOf(indent);
    return lines.map((line) => {
      const m = line.match(/^[ \t]+/);
      if (!m) return line;
      const columns = expandLeading(m[0], width);
      return makeLeading(columns, toTabs ? 'tab' : 'space', width) + line.slice(m[0].length);
    });
  }

  /** Recalcula o nível de recuo: o espaço vira o passo mais próximo. */
  function relevel(lines, indent) {
    const toTabs = indent === 'tab';
    const width = toTabs ? 4 : unitOf(indent);
    return lines.map((line) => {
      if (!line.trim()) return '';
      const m = line.match(/^[ \t]+/);
      if (!m) return line;
      const columns = expandLeading(m[0], width);
      /* Exatamente no meio entre dois passos (6 com unidade 4) fica no
         passo de baixo: 4, e não 8 — o recuo nunca cresce por acaso. */
      const steps = columns / width;
      const level = steps - Math.floor(steps) === 0.5 ? Math.floor(steps) : Math.round(steps);
      const target = level * width;
      const style = toTabs ? 'tab' : 'space';
      return makeLeading(target, style, width) + line.slice(m[0].length);
    });
  }

  /**
   * Pipeline comum a todas as famílias menos o markdown (que tem a sua
   * própria, por causa das cercas de código).
   * @param {string} text
   * @param {object} opts opções já resolvidas
   * @param {{indent?: string, reindent?: boolean}} tweak sobrescritas pontuais
   */
  function cleanLines(text, opts, tweak) {
    const conf = Object.assign(
      { indent: opts.indent, reindent: opts.reindent },
      tweak || {}
    );

    let source = String(text == null ? '' : text);
    if (opts.crlf) source = source.replace(/\r\n?/g, '\n');

    let lines = source.split('\n');
    if (opts.trailing) lines = stripTrailing(lines);
    if (conf.indent && conf.indent !== 'keep') lines = convertLeading(lines, conf.indent);
    if (conf.reindent) lines = relevel(lines, conf.indent === 'keep' ? '4' : conf.indent);

    if (opts.blank) {
      const kept = [];
      let previousEmpty = false;
      for (const line of lines) {
        const empty = line.trim() === '';
        if (empty && previousEmpty) continue;
        kept.push(empty ? '' : line);
        previousEmpty = empty;
      }
      lines = kept;
    } else {
      lines = lines.map((line) => (line.trim() === '' ? '' : line));
    }

    if (opts.edges) {
      while (lines.length && lines[0] === '') lines.shift();
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
    }

    return lines;
  }

  /**
   * Junta as linhas de volta sem inventar quebra final: a saída termina no
   * último conteúdo (o código, sozinho, devolve a quebra que o original
   * tinha — ver `formatCode`).
   */
  function joinLines(lines) {
    if (!lines.length) return '';
    return lines.join('\n').replace(/\n+$/, '');
  }

  /* ---------------------------------------------------------
     JSON
     --------------------------------------------------------- */

  /**
   * Varredura própria do JSON para achar a linha e a coluna do problema.
   *
   * A mensagem do `JSON.parse` varia entre versões do Node e nem sempre traz
   * a posição; aqui ela é reconstruída em português, com o índice exato — o
   * aviso da página precisa apontar para a linha que a pessoa deve consertar.
   * @returns {{index: number, message: string}|null} null quando não achou nada
   */
  function locateJsonError(src) {
    let i = 0;
    const len = src.length;
    const isDigit = (ch) => ch >= '0' && ch <= '9';

    const fail = (message) => {
      const error = new Error(message);
      error.index = i;
      throw error;
    };

    const preview = (ch) => (ch === undefined ? 'o fim do arquivo' : '"' + ch + '"');
    const space = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    const ws = () => { while (i < len && space(src[i])) i++; };

    function parseString() {
      i++; // aspa de abertura
      while (i < len) {
        const ch = src[i];
        if (ch === '"') { i++; return; }
        if (ch === '\\') {
          const esc = src[i + 1];
          if (esc === undefined) return fail('escape incompleto no fim do texto');
          if (esc === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) return fail('escape \\u precisa de 4 dígitos hexadecimais');
            i += 6;
            continue;
          }
          if ('"\\/bfnrt'.indexOf(esc) === -1) return fail('escape inválido: \\' + esc);
          i += 2;
          continue;
        }
        if (ch === '\n') return fail('quebra de linha sem escape (use \\n)');
        i++;
      }
      return fail('texto aberto sem a aspa de fechamento');
    }

    function parseNumber() {
      if (src[i] === '-') i++;
      if (src[i] === '0') i++;
      else if (isDigit(src[i])) { while (isDigit(src[i])) i++; }
      else return fail('número incompleto');
      if (src[i] === '.') {
        i++;
        if (!isDigit(src[i])) return fail('vírgula decimal sem dígito depois');
        while (isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (!isDigit(src[i])) return fail('expoente sem dígito');
        while (isDigit(src[i])) i++;
      }
    }

    function parseValue() {
      ws();
      const ch = src[i];
      if (ch === undefined) return fail('faltou um valor aqui');
      if (ch === '{') return parseObject();
      if (ch === '[') return parseArray();
      if (ch === '"') return parseString();
      if (ch === '-' || isDigit(ch)) return parseNumber();
      if (src.startsWith('true', i)) { i += 4; return; }
      if (src.startsWith('false', i)) { i += 5; return; }
      if (src.startsWith('null', i)) { i += 4; return; }
      return fail(ch === ',' ? 'vírgula sem valor antes dela' : 'valor inesperado: ' + preview(ch));
    }

    function parseArray() {
      i++; // [
      ws();
      if (src[i] === ']') { i++; return; }
      for (;;) {
        parseValue();
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === ']') return fail('vírgula sobrando antes de "]"');
          continue;
        }
        if (src[i] === ']') { i++; return; }
        if (i >= len) return fail('lista aberta sem o "]"');
        return fail('esperava "," ou "]" mas veio ' + preview(src[i]));
      }
    }

    function parseObject() {
      i++; // {
      ws();
      if (src[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (src[i] !== '"') {
          return fail(src[i] === '}'
            ? 'objeto aberto sem valor para a última chave'
            : 'a chave precisa estar entre aspas, veio ' + preview(src[i]));
        }
        parseString();
        ws();
        if (src[i] !== ':') return fail('esperava ":" depois da chave, veio ' + preview(src[i]));
        i++;
        parseValue();
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === '}') return fail('vírgula sobrando antes de "}"');
          continue;
        }
        if (src[i] === '}') { i++; return; }
        if (i >= len) return fail('objeto aberto sem o "}"');
        return fail('esperava "," ou "}" mas veio ' + preview(src[i]));
      }
    }

    try {
      parseValue();
      ws();
      if (i < len) fail('sobrou conteúdo depois do fim do JSON');
      return null;
    } catch (err) {
      if (typeof err.index === 'number') return { index: err.index, message: err.message };
      return null;
    }
  }

  /** Acha linha/coluna de um erro do JSON.parse. */
  function jsonErrorInfo(source, err) {
    const own = locateJsonError(source);
    const message = own
      ? own.message
      : String((err && err.message) || 'JSON inválido');

    if (own) {
      const before = source.slice(0, Math.min(own.index, source.length));
      const line = before.split('\n').length;
      return { message, line, column: own.index - before.lastIndexOf('\n') };
    }

    const direct = message.match(/line (\d+) column (\d+)/i);
    if (direct) return { message, line: Number(direct[1]), column: Number(direct[2]) };

    const pos = message.match(/position (\d+)/i);
    if (pos) {
      const index = Math.min(Number(pos[1]), source.length);
      const before = source.slice(0, index);
      return { message, line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
    }
    return { message, line: 1, column: 1 };
  }

  /* Um nível de escape que a remoção entende: os do JSON (`\"`, `\n`,
     `\uXXXX`...) e a barra sozinha. Escape fora dessa lista (`\q`) fica
     intacto — é só um nível. */
  const UNESCAPE = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '"': '"', '\\': '\\' };

  /** Passa uma vez, da esquerda para a direita, tirando um nível de escape. */
  function unescapeOneLevel(text) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== '\\') { out += ch; continue; }

      const next = text[i + 1];
      if (next === undefined) { out += ch; break; }

      if (next === 'u') {
        const hex = text.substr(i + 2, 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          out += ch;
        }
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(UNESCAPE, next)) {
        out += UNESCAPE[next];
        i += 1;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /**
   * O conteúdo chegou "como string": remove um nível de escape antes de ler.
   *  - `"{\"a\": 1}"` é uma string JSON — o valor dela é o JSON um nível
   *    abaixo e é ele que segue para o formato;
   *  - `{\"a\": 1}` nem é JSON válido — tira o escape do texto cru;
   *  - JSON que já é válido (objeto, número...) fica intacto: o escape
   *    dele é o conteúdo, não um embrulho.
   */
  function removeJsonEscapes(text) {
    try {
      const value = JSON.parse(text);
      return typeof value === 'string' ? value : text;
    } catch (err) {
      return unescapeOneLevel(text);
    }
  }

  function formatJson(source, opts) {
    const width = opts.indent === 'keep' ? 2 : opts.indent === 'tab' ? 4 : unitOf(opts.indent);
    const stripped = source.replace(/^\uFEFF/, '');
    const text = opts.removeEscapes ? removeJsonEscapes(stripped) : stripped;
    try {
      let out = JSON.stringify(JSON.parse(text), null, width);
      if (opts.indent === 'tab') out = out.replace(/^ +/gm, (lead) => makeLeading(lead.length, 'tab', 4));
      return { text: out, error: null };
    } catch (err) {
      const info = jsonErrorInfo(text, err);
      /* Com a opção ligada, o texto sem escape é o que interessa: ele volta
         mesmo com erro, para a pessoa ver o que tinha dentro do embrulho. */
      const keep = opts.removeEscapes && text !== stripped ? text : null;
      return { text: keep, error: Object.assign({ family: 'json' }, info) };
    }
  }

  /* ---------------------------------------------------------
     XML / HTML: impressão em árvore
     --------------------------------------------------------- */

  const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]);

  /* Conteúdo que não pode ser recuado sem quebrar o original. */
  const RAW_TAGS = new Set(['pre', 'textarea', 'script', 'style']);

  /* Etiquetas que ficam junto do texto numa linha só. */
  const INLINE_TAGS = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn',
    'em', 'i', 'img', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small',
    'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
  ]);

  const NAME_START = /[A-Za-z_:]/;

  /**
   * Tags que o HTML5 fecha sozinhas quando outra abre (versão simplificada
   * do algoritmo "in body"): `<li>` fecha o `<li>` anterior, um bloco fecha
   * um `<p>` ainda aberto, células se substituem na linha e assim por diante.
   * Vale só para HTML — em XML a ordem das tags é obrigatória.
   */
  const CLOSES_ON_OPEN = {
    p: ['p'],
    li: ['p', 'li'],
    dt: ['p', 'dt', 'dd'],
    dd: ['p', 'dt', 'dd'],
    option: ['option'],
    optgroup: ['option'],
    tr: ['td', 'th', 'tr'],
    td: ['td', 'th'],
    th: ['td', 'th'],
    thead: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
    tbody: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
    tfoot: ['td', 'th', 'tr', 'thead', 'tbody', 'tfoot'],
    caption: ['caption', 'td', 'th', 'tr'],
    colgroup: ['colgroup'],
    div: ['p'], blockquote: ['p'], pre: ['p'], hr: ['p'], form: ['p'],
    ul: ['p'], ol: ['p'], dl: ['p'], table: ['p'], address: ['p'],
    article: ['p'], aside: ['p'], fieldset: ['p'], figure: ['p'],
    footer: ['p'], header: ['p'], main: ['p'], nav: ['p'], section: ['p'],
    h1: ['p'], h2: ['p'], h3: ['p'], h4: ['p'], h5: ['p'], h6: ['p'],
  };

  /** Fecha na pilha o que a tag `name` (que está prestes a abrir) encerra. */
  function autoClose(stack, name) {
    const closes = CLOSES_ON_OPEN[name];
    if (!closes) return;
    for (;;) {
      let found = -1;
      for (let k = stack.length - 1; k > 0; k--) {
        if (closes.indexOf(stack[k].name) >= 0) { found = k; break; }
      }
      if (found === -1) return;
      stack.length = found;
    }
  }

  /** Índice logo depois de uma tag de abertura (respeita aspas). */
  function scanOpenTag(src, start) {
    let quote = '';
    let i = start + 1;
    const limit = Math.min(src.length, start + 8000);
    for (; i < limit; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') return i + 1;
    }
    return -1;
  }

  /** Índice depois de um `<!DOCTYPE ...>`, com subconjunto interno `[...]`. */
  function scanDoctype(src, start) {
    let depth = 0;
    let i = start + 2;
    const limit = Math.min(src.length, start + 8000);
    for (; i < limit; i++) {
      const ch = src[i];
      if (ch === '[') depth++;
      else if (ch === ']') depth = Math.max(0, depth - 1);
      else if (ch === '>' && depth === 0) return i + 1;
    }
    return -1;
  }

  /**
   * Quebra o marcação em tags, comentários, CDATA e texto.
   * Um `<` que não abre nada conhecido é texto comum.
   */
  function tokenizeMarkup(src) {
    const out = [];
    let textStart = 0;
    let i = 0;
    let rawTag = null; // conteúdo bruto de pre/script/style/textarea

    const flush = (at) => {
      if (at > textStart) {
        out.push({ kind: 'text', value: src.slice(textStart, at), keep: rawTag !== null });
      }
    };

    while (i < src.length) {
      if (rawTag) {
        const close = src.toLowerCase().indexOf('</' + rawTag, i);
        if (close === -1) break;
        flush(i);
        out.push({ kind: 'text', value: src.slice(i, close), keep: true });
        textStart = close;
        rawTag = null;
        continue;
      }

      if (src.charCodeAt(i) !== 60 /* < */) { i++; continue; }

      let token = null;
      let next = -1;

      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i + 4);
        token = { kind: 'raw', value: src.slice(i, end === -1 ? src.length : end + 3) };
        next = end === -1 ? src.length : end + 3;
      } else if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i + 9);
        token = { kind: 'text', value: src.slice(i, end === -1 ? src.length : end + 3), keep: true };
        next = end === -1 ? src.length : end + 3;
      } else if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i + 2);
        token = { kind: 'raw', value: src.slice(i, end === -1 ? src.length : end + 2) };
        next = end === -1 ? src.length : end + 2;
      } else if (src.startsWith('<!', i)) {
        const end = scanDoctype(src, i);
        if (end > 0) { token = { kind: 'raw', value: src.slice(i, end) }; next = end; }
      } else if (src.startsWith('</', i)) {
        const close = /^<\/\s*([A-Za-z_:][-\w.:]*)\s*>/.exec(src.slice(i, i + 512));
        if (close) {
          token = { kind: 'close', name: close[1].toLowerCase(), value: close[0] };
          next = i + close[0].length;
        }
      } else if (NAME_START.test(src[i + 1] || '')) {
        const end = scanOpenTag(src, i);
        if (end > 0) {
          const raw = src.slice(i, end);
          const nameMatch = /^<\s*([A-Za-z_:][-\w.:]*)/.exec(raw);
          if (nameMatch) {
            const name = nameMatch[1].toLowerCase();
            const selfClosing = /\/\s*>$/.test(raw);
            token = {
              kind: 'open',
              name,
              attrs: raw.slice(nameMatch[0].length, raw.length - 1).replace(/\/\s*$/, '').trim(),
              selfClosing,
            };
            next = end;
          }
        }
      }

      if (!token) { i++; continue; }

      flush(i);
      out.push(token);
      textStart = next;
      i = next;
      if (token.kind === 'open' && !token.selfClosing && RAW_TAGS.has(token.name)) rawTag = token.name;
    }

    flush(src.length);
    return out;
  }

  /** Monta a árvore; tags sem par são fechadas no fim. */
  function buildMarkupTree(tokens, html) {
    const root = { element: false, children: [] };
    const stack = [root];

    for (const token of tokens) {
      const top = stack[stack.length - 1];

      if (token.kind === 'open') {
        if (html) autoClose(stack, token.name);
        /* recalcular: o auto-fechamento pode ter tirado `top` da pilha */
        const openTop = stack[stack.length - 1];
        const node = {
          element: true,
          name: token.name,
          attrs: token.attrs,
          selfClosing: token.selfClosing,
          children: [],
        };
        openTop.children.push(node);
        if (!token.selfClosing && !VOID_TAGS.has(token.name)) stack.push(node);
      } else if (token.kind === 'close') {
        let index = -1;
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].name === token.name) { index = k; break; }
        }
        if (index === -1) {
          /* fecha inesperado: mantém o texto para não perder conteúdo */
          top.children.push({ element: false, text: true, value: token.value, keep: true });
        } else {
          stack.length = index;
        }
      } else if (token.kind === 'raw') {
        top.children.push({ element: false, text: false, raw: true, value: token.value });
      } else {
        top.children.push({ element: false, text: true, value: token.value, keep: !!token.keep });
      }
    }

    return root;
  }

  const MAX_INLINE = 120;

  /** Colapsa espaços de um texto comum (o HTML sempre fez isso na renderização). */
  function collapse(value) {
    return String(value).replace(/\s+/g, ' ');
  }

  /** Um filho pode ficar na mesma linha do pai? */
  function isInlineChild(node) {
    if (node.raw) return false;
    if (node.text) return !node.keep;
    if (!node.element) return false;
    if (!INLINE_TAGS.has(node.name)) return false;
    return node.children.every(isInlineChild);
  }

  /** Texto concatenado na versão de uma linha só. */
  function flattenChildren(children) {
    let out = '';
    for (const child of children) {
      if (child.text) out += collapse(child.value);
      else if (child.element) out += openTag(child) + flattenChildren(child.children) + closeTag(child);
      else return null;
    }
    return out;
  }

  function openTag(node) {
    return '<' + node.name + (node.attrs ? ' ' + node.attrs : '') + '>';
  }

  function closeTag(node) {
    return '</' + node.name + '>';
  }

  function formatMarkup(source, opts, family) {
    const indent = opts.indent === 'keep' ? '2' : opts.indent === 'tab' ? 'tab' : opts.indent;
    const unit = indent === 'tab' ? '\t' : ' '.repeat(unitOf(indent));
    const tokens = tokenizeMarkup(source);
    const tree = buildMarkupTree(tokens, family === 'html');
    const out = [];

    const emit = (depth, line) => out.push(unit.repeat(depth) + line);

    const render = (node, depth) => {
      if (node.text) {
        if (node.keep) {
          const raw = node.value.replace(/^\n/, '').replace(/\n$/, '');
          if (raw) raw.split('\n').forEach((line) => out.push(line));
        } else {
          const value = collapse(node.value).trim();
          if (value) emit(depth, value);
        }
        return;
      }
      if (node.raw) { emit(depth, node.value); return; }

      const children = node.children;
      /* Junta tudo numa linha só só quando há texto direto no elemento:
         um `<a><b>x</b></a>` (tag dentro de tag, sem texto no meio) sai
         bloco a bloco, com um filho por linha. */
      const directText = children.some((child) => child.text && !child.keep && child.value !== '');
      const flat = (children.length === 0 || directText) && children.every(isInlineChild)
        ? flattenChildren(children)
        : null;

      if (flat !== null) {
        const body = flat.trim();
        if (body.length <= MAX_INLINE && body.indexOf('\n') === -1) {
          if (node.selfClosing || VOID_TAGS.has(node.name)) emit(depth, '<' + node.name + (node.attrs ? ' ' + node.attrs : '') + ' />');
          else emit(depth, openTag(node) + body + closeTag(node));
          return;
        }
      }

      /* conteúdo bruto (pre, script...): nada de recuar por dentro */
      const rawOnly = !children.some((child) => child.element || child.raw) &&
        children.some((child) => child.text && child.keep);

      if (node.selfClosing || VOID_TAGS.has(node.name)) {
        emit(depth, '<' + node.name + (node.attrs ? ' ' + node.attrs : '') + ' />');
        return;
      }

      emit(depth, openTag(node));
      if (rawOnly) {
        for (const child of children) {
          if (!child.text || !child.keep) continue;
          child.value.replace(/^\n/, '').replace(/\n$/, '').split('\n').forEach((line) => out.push(line));
        }
      } else {
        for (const child of children) render(child, depth + 1);
      }
      emit(depth, closeTag(node));
    };

    for (const child of tree.children) render(child, 0);

    /* linhas vazias sobrando entre blocos */
    const result = [];
    for (const line of out) {
      if (line.trim() === '' && result.length && result[result.length - 1].trim() === '') continue;
      result.push(line.trim() === '' ? '' : line);
    }
    while (result.length && result[0] === '') result.shift();
    while (result.length && result[result.length - 1] === '') result.pop();

    return { text: joinLines(result), error: null, family };
  }

  /* ---------------------------------------------------------
     Markdown
     --------------------------------------------------------- */

  const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
  const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

  /**
   * Máscara linha a linha: `true` onde a linha está (ou é a abertura/fechamento
   * de) uma cerca de código. O conteúdo das cercas é sagrado — nenhum passeio
   * de formatação pode mexer nele.
   */
  function fenceMask(lines) {
    const mask = [];
    let fence = null; // caractere da cerca aberta
    for (const line of lines) {
      if (fence) {
        mask.push(true);
        if (FENCE_CLOSE.test(line) && line.trim()[0] === fence[0]) fence = null;
        continue;
      }
      if (FENCE_OPEN.test(line)) {
        mask.push(true);
        fence = FENCE_OPEN.exec(line)[2][0];
        continue;
      }
      mask.push(false);
    }
    return mask;
  }

  /**
   * Preparação do markdown: fim de linha, espaço no fim (a quebra dura de
   * duas linhas sobrevive) e linhas em branco — tudo sem tocar em nada que
   * esteja dentro de uma cerca de código.
   */
  function prepareMarkdown(source, opts) {
    let text = String(source == null ? '' : source);
    if (opts.crlf) text = text.replace(/\r\n?/g, '\n');
    let lines = text.split('\n');
    const raw = fenceMask(lines);

    if (opts.trailing) {
      for (let i = 0; i < lines.length; i++) {
        if (raw[i]) continue;
        lines[i] = trimHardBreak(lines[i], lines[i + 1]);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (!raw[i] && lines[i].trim() === '') lines[i] = '';
    }

    if (opts.blank) {
      const kept = [];
      const keptRaw = [];
      let previousEmpty = false;
      for (let i = 0; i < lines.length; i++) {
        const empty = lines[i] === '';
        if (empty && previousEmpty && !raw[i]) continue;
        kept.push(lines[i]);
        keptRaw.push(raw[i]);
        previousEmpty = empty;
      }
      lines = kept;
      raw.length = 0;
      for (const flag of keptRaw) raw.push(flag);
    }

    if (opts.edges) {
      while (lines.length && !raw[0] && lines[0] === '') { lines.shift(); raw.shift(); }
      while (lines.length && !raw[raw.length - 1] && lines[lines.length - 1] === '') {
        lines.pop();
        raw.pop();
      }
    }

    return lines;
  }

  function formatMarkdown(source, opts) {
    const lines = prepareMarkdown(source, opts);

    /* front matter YAML: o "---" de abertura e o de fechamento não são títulos */
    let start = 0;
    if (lines.length && /^---\s*$/.test(lines[0])) {
      const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line));
      start = end === -1 ? lines.length : end + 1;
    }

    const out = lines.slice(0, start);
    let fence = null; // caractere da cerca aberta

    for (let i = start; i < lines.length; i++) {
      const line = lines[i];
      const previous = out.length ? out[out.length - 1] : '';

      if (fence) {
        out.push(line);
        if (FENCE_CLOSE.test(line) && line.trim()[0] === fence[0]) fence = null;
        continue;
      }

      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[2][0];
        const info = open[3].trim();
        out.push('```' + info);
        continue;
      }

      /* setext: texto seguido de === ou --- vira título ATX.
         Lista, citação, tabela e cerca de código não viram título. */
      const setext = /^\s{0,3}(=+|-+)[ \t]*$/.test(line);
      const blocky = /^\s*([-*+]|\d+[.)])\s+\S|^\s*>|^\s*\||^\s*(```|~~~)|^\s{0,3}#{1,6}\s/.test(previous);
      if (setext && previous.trim() !== '' && !blocky) {
        const marker = /^\s{0,3}(=+|-+)/.exec(line)[1];
        const level = marker[0] === '=' ? 1 : 2;
        out[out.length - 1] = '#'.repeat(level) + ' ' + previous.trim().replace(/\s+#+\s*$/, '');
        continue;
      }

      /* títulos ATX: um espaço depois dos cerquilhos, sem cerquilhos sobrando */
      const atx = /^(#{1,6})(\s*)(\S.*)$/.exec(line);
      if (atx) {
        out.push(atx[1] + ' ' + atx[3].replace(/\s+#+\s*$/, '').replace(/\s+$/, ''));
        continue;
      }
      if (/^\s{0,3}#{1,6}\s*$/.test(line)) { out.push(line.replace(/#+\s*$/, '').trimEnd()); continue; }

      /* citação: ">texto" vira "> texto" */
      const quote = /^(\s*>+)(?=\S)/.exec(line);
      if (quote) { out.push(line.replace(/^(\s*>+)(?=\S)/, '$1 ')); continue; }

      /* marcadores de lista */
      const bullet = /^(\s*)([*+-])[ \t]+(\[[ xX]\][ \t]+)?(.*)$/.exec(line);
      if (bullet && !/^[ \t]*[-*+]{3,}[ \t]*$/.test(line)) {
        out.push(bullet[1] + '- ' + (bullet[3] || '') + bullet[4]);
        continue;
      }
      const ordered = /^(\s*)(\d{1,9})[.)][ \t]+(\[[ xX]\][ \t]+)?(.*)$/.exec(line);
      if (ordered) {
        out.push(ordered[1] + ordered[2] + '. ' + (ordered[3] || '') + ordered[4]);
        continue;
      }

      out.push(line);
    }

    /* título cercado de linha em branco (fora das cercas de código) */
    const spaced = [];
    const openMask = fenceMask(out);
    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      if (openMask[i]) { spaced.push(line); continue; }

      const isHeading = /^#{1,6}\s+\S/.test(line);
      if (isHeading && spaced.length && spaced[spaced.length - 1].trim() !== '') spaced.push('');
      spaced.push(line);
      const next = out[i + 1];
      if (isHeading && next !== undefined && !openMask[i + 1] && next.trim() !== '') spaced.push('');
    }

    /* linhas em branco repetidas, sem entrar na cerca */
    const result = [];
    const flags = [];
    const closeMask = fenceMask(spaced);
    let empty = false;
    for (let i = 0; i < spaced.length; i++) {
      if (closeMask[i]) {
        result.push(spaced[i]);
        flags.push(true);
        empty = spaced[i].trim() === '';
        continue;
      }
      const isBlank = spaced[i].trim() === '';
      if (isBlank && empty) continue;
      result.push(isBlank ? '' : spaced[i]);
      flags.push(false);
      empty = isBlank;
    }
    while (result.length && !flags[0] && result[0] === '') { result.shift(); flags.shift(); }
    while (result.length && !flags[flags.length - 1] && result[result.length - 1] === '') {
      result.pop();
      flags.pop();
    }

    return { text: joinLines(result), error: null };
  }

  /* ---------------------------------------------------------
     CSV -> tabela markdown
     --------------------------------------------------------- */

  const DELIMITERS = [',', ';', '\t', '|'];

  /** Conta colunas fora das aspas e escolhe o delimitador mais consistente. */
  function pickDelimiter(sample) {
    let best = null;
    for (const delimiter of DELIMITERS) {
      const counts = sample.map((line) => countOutsideQuotes(line, delimiter)).filter((n) => n > 0);
      if (counts.length < sample.length * 0.6 || !counts.length) continue;
      const tally = new Map();
      for (const n of counts) tally.set(n, (tally.get(n) || 0) + 1);
      let mode = 0;
      let share = 0;
      for (const [n, times] of tally) {
        if (times > share || (times === share && n > mode)) { mode = n; share = times; }
      }
      const score = share / sample.length;
      if (!best || score > best.score || (score === best.score && mode > best.columns)) {
        best = { delimiter, columns: mode + 1, score };
      }
    }
    return best;
  }

  function countOutsideQuotes(line, delimiter) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') i++; else quoted = !quoted; }
      else if (ch === delimiter && !quoted) count++;
    }
    return count;
  }

  /** Lê as linhas respeitando aspas (célula pode ter \n por dentro). */
  function parseRows(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += ch;
        continue;
      }
      if (ch === '"') { quoted = true; continue; }
      if (ch === delimiter) { row.push(cell); cell = ''; continue; }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        continue;
      }
      cell += ch;
    }

    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((value) => value.trim() !== ''));
  }

  function pad(text, width) {
    let out = text;
    while (widthOf(out) < width) out += ' ';
    return out;
  }

  /** Largura visível (o `…` de uma célula cortada vale um). */
  function widthOf(text) {
    return String(text).length;
  }

  function formatCsv(source, opts) {
    const lines = cleanLines(source, opts, { indent: 'keep', reindent: false });
    const body = lines.join('\n');
    const sample = lines.filter((line) => line.trim() !== '').slice(0, 30);
    if (!sample.length) return { text: '', error: null, warnings: [] };

    const picked = pickDelimiter(sample);
    if (!picked) {
      return {
        text: joinLines(lines),
        error: {
          family: 'csv',
          message: 'Não parece CSV: encontrei uma única coluna em todas as linhas.',
          line: 1,
          column: 1,
        },
        warnings: [],
      };
    }

    const rows = parseRows(body, picked.delimiter);
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const warnings = [];
    rows.forEach((row, index) => {
      if (row.length !== columns) {
        warnings.push('Linha ' + (index + 1) + ' tem ' + row.length + ' coluna(s), a tabela tem ' + columns + '.');
      }
    });

    const CAP = 60;
    const widths = new Array(columns).fill(3);
    const shown = rows.map((row) =>
      row.map((cell, index) => {
        const value = cell.replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
        const short = value.length > CAP ? value.slice(0, CAP - 1) + '…' : value;
        widths[index] = Math.max(widths[index], short.length);
        return short;
      })
    );

    const wrap = (cells) => {
      const parts = cells.map((cell, index) => pad(cell || '', widths[index]));
      return '| ' + parts.join(' | ') + ' |';
    };

    const bar = '| ' + widths.map((width) => '-'.repeat(width)).join(' | ') + ' |';

    const out = [];
    if (shown.length) { out.push(wrap(shown[0])); out.push(bar); }
    for (let i = 1; i < shown.length; i++) out.push(wrap(shown[i]));

    return { text: joinLines(out), error: null, warnings };
  }

  /* ---------------------------------------------------------
     Texto simples
     --------------------------------------------------------- */

  /* Escapa o texto como string — o caminho inverso de
     `\n` literal → quebra de linha: quebra vira `\n`, aspa vira `\"`,
     barra vira `\\` e controle vira `\t`/`\uXXXX`. Com tudo escapado,
     a saída inteira cabe em uma linha só. */
  const TEXT_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

  function escapeToOneLine(text) {
    return text.replace(/[\u0000-\u001f\\"]/g, (ch) => {
      if (ch === '\\') return '\\\\';
      if (ch === '"') return '\\"';
      return TEXT_ESCAPES[ch] || '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    });
  }

  function formatText(source, opts) {
    let text = source;
    if (opts.unescapeNewlines) {
      text = text.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    }
    text = joinLines(cleanLines(text, opts));
    /* Por último, com a limpeza já feita: escapa de verdade e a saída
       sai em uma linha só. Se as duas opções estiverem ligadas, essa
       vence — o final é sempre uma linha. */
    if (opts.escapeToOneLine) text = escapeToOneLine(text);
    return { text, error: null };
  }

  /* ---------------------------------------------------------
     Código
     --------------------------------------------------------- */

  function formatCode(source, opts) {
    const original = String(source == null ? '' : source);
    let text = joinLines(cleanLines(source, opts));
    /* Código é arquivo: se o original terminava com quebra de linha,
       a saída termina igual — nem mais, nem menos. */
    if (/\r\n$|\n$|\r$/.test(original)) text = text.replace(/\n*$/, '\n');
    return { text, error: null };
  }

  /* ---------------------------------------------------------
     Detecção
     --------------------------------------------------------- */

  const EXT_MAP = {
    json: 'json', ndjson: 'json',
    xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', svg: 'xml', plist: 'xml',
    csproj: 'xml', vbproj: 'xml', wsdl: 'xml', resx: 'xml', config: 'xml',
    html: 'html', htm: 'html', xhtml: 'html',
    md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
    csv: 'csv', tsv: 'csv',
    txt: 'text', log: 'text', text: 'text', rtf: 'text',
    py: 'python', pyw: 'python', pyi: 'python',
    cs: 'csharp', csx: 'csharp',
    java: 'java',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
    go: 'go', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin', swift: 'swift',
    php: 'php', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r',
    sql: 'sql', yml: 'yaml', yaml: 'yaml',
    sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell', ps1: 'shell', bat: 'shell',
    ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini', properties: 'ini', toml: 'ini',
    css: 'css', scss: 'scss', less: 'scss', graphql: 'graphql', gql: 'graphql',
    mk: 'makefile', diff: 'diff', patch: 'diff', vb: 'vbnet', m: 'objectivec',
  };

  const NAME_MAP = {
    makefile: 'makefile', 'gnumakefile': 'makefile', dockerfile: 'shell',
    gemfile: 'ruby', rakefile: 'ruby', procfile: 'shell',
    '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  };

  const HTML_HINT = /^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s>]|<link[\s>]|<title[\s>]|<div[\s>]|<p[\s>]|<span[\s>]|<a[\s>]|<ul[\s>]|<ol[\s>]|<li[\s>]|<table[\s>]|<form[\s>]|<input[\s>]|<br\s*\/?>|<img[\s>]|<section[\s>]|<article[\s>]|<header[\s>]|<footer[\s>]|<nav[\s>]|<h[1-6][\s>]|<script[\s>]|<style[\s>]|<button[\s>])/i;

  /** Sinais de linguagem, por pontuação. A maior soma vence. */
  const CODE_RULES = [
    ['python', [
      [/^\s*def\s+\w+\s*\(/m, 3],
      [/^\s*class\s+\w+\s*(\([^)]*\))?\s*:/m, 3],
      [/^\s*from\s+[\w.]+\s+import\b/m, 3],
      [/\b__init__\s*\(/m, 3],
      [/^\s*(elif|except|finally)\b.*:\s*$/m, 2],
      [/^\s*import\s+[\w.]+\s*$/m, 2],
      [/^\s*(if|for|while|with|else)\b[^:]*:\s*$/m, 1],
      [/\bself\./m, 1],
    ]],
    ['csharp', [
      [/using\s+System(\.\w+)*\s*;/m, 4],
      [/\bnamespace\s+[\w.]+\s*\{/m, 3],
      [/\bConsole\.(Write|WriteLine)\s*\(/m, 3],
      [/\bpublic\s+(static\s+)?(void|string|int|bool|class)\b/m, 2],
      [/^\s*\[[\w.]+(\([^)]*\))?\]\s*$/m, 2],
    ]],
    ['java', [
      [/import\s+java\.\w+/m, 4],
      [/System\.(out|err)\.(print|printf)/m, 4],
      [/^\s*public\s+static\s+void\s+main\s*\(/m, 3],
      [/^\s*public\s+(final\s+)?class\b/m, 3],
      [/@(Override|Test|Autowired)\b/m, 2],
    ]],
    ['javascript', [
      [/^\s*(const|let|var)\s+\w+\s*=/m, 2],
      [/\bconsole\.log\s*\(/m, 3],
      [/module\.exports|m\.exports\s*=/m, 3],
      [/require\(\s*['"]/m, 2],
      [/=>/m, 2],
      [/^\s*function\s+\w+\s*\(/m, 2],
      [/\bdocument\.(getElementById|querySelector)/m, 3],
    ]],
    ['typescript', [
      [/^\s*interface\s+\w+\s*\{/m, 4],
      [/^\s*type\s+\w+\s*=/m, 3],
      [/:\s*(string|number|boolean|void|any)\b/m, 3],
      [/^\s*(export\s+)?(type|interface)\b/m, 2],
      [/<\w+>\s*\(/m, 1],
    ]],
    ['c', [
      [/#include\s*<(stdio|stdlib|string)\.h>/m, 4],
      [/^\s*int\s+main\s*\(/m, 3],
      [/\b(printf|scanf|malloc|free)\s*\(/m, 2],
      [/\bNULL\b/m, 1],
    ]],
    ['cpp', [
      [/#include\s*<iostream>/m, 4],
      [/\bstd::\w+/m, 3],
      [/\b(cout|cin|endl)\b/m, 3],
      [/\btemplate\s*</m, 2],
      [/\b(namespace|std::string)\b/m, 2],
    ]],
    ['go', [
      [/^\s*package\s+(main|\w+)\s*$/m, 2],
      [/^\s*func\s+\w+\s*\(/m, 3],
      [/\bfmt\.(Print|Printf|Println)\s*\(/m, 4],
      [/:=/m, 2],
      [/^\s*import\s*\(/m, 2],
    ]],
    ['rust', [
      [/\bfn\s+\w+\s*\(/m, 3],
      [/\blet\s+mut\b/m, 3],
      [/\buse\s+std::/m, 3],
      [/\bprintln!\s*\(/m, 3],
      [/\bimpl\s+\w+/m, 2],
    ]],
    ['php', [
      [/<\?php/m, 6],
      [/\$\w+\s*=/m, 2],
      [/^\s*(echo|require_once|use\s+\w+);/m, 2],
      [/\bfunction\s+\w+\s*\(/m, 1],
    ]],
    ['ruby', [
      [/^\s*require\s+['"]/m, 3],
      [/^\s*def\s+\w+[?!]?\s*(\|.*\|)?\s*$/m, 3],
      [/^\s*end\s*$/m, 1],
      [/\bputs\s+/m, 2],
      [/\bdo\s*\|/m, 2],
      [/\battr_(reader|accessor)\b/m, 3],
    ]],
    ['kotlin', [
      [/\bfun\s+\w+\s*\(/m, 4],
      [/^\s*(val|var)\s+\w+/m, 2],
      [/\bprintln\s*\(/m, 1],
      [/\bdata\s+class\b/m, 3],
    ]],
    ['swift', [
      [/import\s+(Foundation|SwiftUI|UIKit)/m, 4],
      [/\bfunc\s+\w+\s*\(/m, 3],
      [/^\s*(let|var)\s+\w+\s*=/m, 2],
      [/\bprint\s*\(/m, 1],
    ]],
    ['sql', [
      [/\bSELECT\b[\s\S]*\bFROM\b/im, 4],
      [/\bINSERT\s+INTO\b/im, 3],
      [/\bCREATE\s+TABLE\b/im, 3],
      [/\b(UPDATE|DELETE)\b[\s\S]*\bWHERE\b/im, 3],
      [/\b(LEFT|INNER|OUTER)?\s*JOIN\b/im, 1],
    ]],
    ['shell', [
      [/^\s*#!\s*\/bin\/(ba)?sh/m, 6],
      [/^\s*(echo|export|cd|ls|cat|chmod|sudo)\s+/m, 1],
      [/\$\(|\$\{/m, 2],
      [/^\s*(if|then|fi|for|done|while)\b/m, 1],
      [/\|\s*(grep|awk|sed|xargs)\b/m, 3],
    ]],
    ['yaml', [
      [/^[\w.-]+:\s*\S.*$/m, 2],
      [/^\s*-\s+\w+:/m, 2],
      [/^#[\s\S]*$/m, 1],
      [/^\s{2,}[\w.-]+:\s*/m, 1],
    ]],
    ['css', [
      [/^[^{}@]+\{[^}]*:[^}]*;/m, 3],
      [/--[\w-]+\s*:/m, 2],
      [/\.[\w-]+\s*\{/m, 2],
    ]],
    ['scss', [
      [/\$[\w-]+\s*:/m, 4],
      [/@(mixin|include|extend|use)\b/m, 4],
      [/^[^{}@]+\{[^}]*:[^}]*;/m, 2],
    ]],
    ['graphql', [
      [/^\s*(query|mutation|fragment|subscription)\s+\w+/m, 4],
      [/^\s*type\s+\w+\s*\{/m, 3],
      [/^\s*\w+\s*\([^)]*\)\s*:\s*\w+/m, 1],
    ]],
    ['makefile', [
      [/^[\w./$()%-]+:(\s|$)/m, 3],
      [/^\t\w+/m, 3],
      [/^\s*(all|clean|install|build):/m, 2],
    ]],
    ['diff', [
      [/^@@ .* @@/m, 5],
      [/^--- .*/m, 2],
      [/^\+\+\+ .*/m, 2],
      [/^diff --git/m, 4],
    ]],
    ['vbnet', [
      [/\bDim\s+\w+\s+As\b/m, 4],
      [/\bEnd\s+(Sub|Function|Class)\b/m, 4],
      [/\b(Module|Imports)\s+\w+/m, 2],
    ]],
    ['objectivec', [
      [/@interface\b/m, 4],
      [/#import\s+</m, 3],
      [/\bNSLog\s*\(/m, 3],
      [/\b(IBOutlet|IBAction)\b/m, 3],
    ]],
    ['lua', [
      [/^\s*local\s+\w+/m, 3],
      [/^\s*function\s+[\w.:]+\s*\(/m, 3],
      [/\bend\b\s*$/m, 1],
    ]],
    ['perl', [
      [/^\s*my\s+\$/m, 4],
      [/use\s+strict\b/m, 4],
      [/^\s*use\s+warnings\b/m, 3],
    ]],
    ['r', [
      [/<-/m, 3],
      [/\blibrary\s*\(/m, 3],
      [/^\s*\w+\s*<-\s*function\s*\(/m, 3],
    ]],
    ['ini', [
      [/^\s*\[[\w .-]+\]\s*$/m, 3],
      [/^\s*[\w.-]+\s*=\s*\S*/m, 2],
      [/^\s*[#;]\s*\S+/m, 1],
    ]],
  ];

  function scoreCode(text) {
    const head = text.slice(0, 12000);
    let best = null;
    for (const [language, rules] of CODE_RULES) {
      let score = 0;
      for (const [pattern, weight] of rules) {
        if (pattern.test(head)) score += weight;
      }
      if (score >= 3 && (!best || score > best.score)) best = { language, score };
    }
    return best;
  }

  function looksLikeMarkdown(text) {
    let score = 0;
    if (/^#{1,6}\s+\S/m.test(text)) score += 3;
    if (/^\s*(```|~~~)/m.test(text)) score += 3;
    if (/^\s*>\s?\S/m.test(text)) score += 2;
    if (/^\s*[-*+]\s+\S.*(\n\s*[-*+]\s+\S)/m.test(text)) score += 2;
    if (/^\s*\d{1,9}[.)]\s+\S/m.test(text)) score += 1;
    if (/^\s*\|.+\|\s*$/m.test(text) && /^\s*\|[\s:|-]+\|\s*$/m.test(text)) score += 4;
    if (/\*\*[^*\n]+\*\*/m.test(text)) score += 1;
    return score >= 3;
  }

  function looksLikeHtml(text) {
    const head = text.trimStart().slice(0, 400);
    return HTML_HINT.test(head) || /<\/(html|body|div|p|span|table)>/i.test(text);
  }

  function looksLikeCsv(lines) {
    const sample = lines.filter((line) => line.trim() !== '').slice(0, 30);
    if (sample.length < 3) return false;
    const picked = pickDelimiter(sample);
    if (!picked || picked.score < 0.9) return false;
    if (picked.columns >= 3) return true;
    /* Duas colunas são fáceis de confundir com prosa: só aceita se nenhuma
       linha terminar como frase e todas forem curtas. */
    return sample.every((line) => !/[.!?]\s*$/.test(line.trim()) && line.length <= 120);
  }

  /**
   * Descobre o tipo pelo nome do arquivo e, se não der, pelo conteúdo.
   * @returns {{value: string, label: string, family: string, language: string, reason: string}}
   */
  function detect(text, filename) {
    const source = String(text == null ? '' : text);
    const name = String(filename || '').trim();

    if (name) {
      const base = name.split(/[\\/]/).pop().toLowerCase();
      if (NAME_MAP[base]) return withReason(describe(NAME_MAP[base]), 'o nome do arquivo');
      const ext = (base.match(/\.([a-z0-9]+)$/) || [])[1];
      if (ext && EXT_MAP[ext]) return withReason(describe(EXT_MAP[ext]), 'a extensão .' + ext);
    }

    const trimmed = source.trimStart();
    if (!trimmed) return withReason(describe('text'), 'o conteúdo estar vazio');

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try {
        JSON.parse(trimmed.replace(/^\uFEFF/, ''));
        return withReason(describe('json'), 'o conteúdo ser JSON');
      } catch (err) {
        /* JSON quebrado ainda é JSON: seguimos aqui para a formatação
           mostrar a linha e a coluna do problema. O código escapa se ele
           tiver cara de linguagem. */
        const code = scoreCode(source);
        if (!code) return withReason(describe('json'), 'o conteúdo parecer JSON');
      }
    }

    if (/^<\?xml/i.test(trimmed)) return withReason(describe('xml'), 'o conteúdo ser XML');
    if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed) || /<\/html>\s*$/i.test(source)) {
      return withReason(describe('html'), 'o conteúdo ser HTML');
    }
    if (/^<[^>]+>/.test(trimmed) && looksLikeHtml(source)) return withReason(describe('html'), 'o conteúdo ser HTML');
    if (/^<[^>]+>/.test(trimmed)) return withReason(describe('xml'), 'o conteúdo ser XML');
    if (looksLikeMarkdown(source)) return withReason(describe('markdown'), 'o conteúdo ser Markdown');
    if (looksLikeCsv(source.split('\n'))) return withReason(describe('csv'), 'o conteúdo ser CSV');

    const code = scoreCode(source);
    if (code) return withReason(describe(code.language), 'o conteúdo parecer ' + code.language);

    return withReason(describe('text'), 'o conteúdo ser texto puro');
  }

  function withReason(descriptor, reason) {
    return Object.assign({}, descriptor, { reason });
  }

  /* ---------------------------------------------------------
     API
     --------------------------------------------------------- */

  /**
   * Formata o texto.
   * @param {string} text
   * @param {{type?: string, filename?: string} & object} partial opções
   *        `type` é o valor do catálogo ('auto' detecta pelo conteúdo)
   * @returns {{text: string, changed: boolean, type: string, label: string,
   *            family: string, language: string, reason: string,
   *            error: ?object, warnings: string[]}}
   */
  function format(text, partial) {
    const opts = resolveOptions(partial);
    const source = String(text == null ? '' : text);
    const asked = partial && partial.type ? String(partial.type) : 'auto';

    const descriptor = asked === 'auto'
      ? detect(source, partial && partial.filename)
      : withReason(describe(asked), 'a sua escolha');

    const family = descriptor.family;

    /* Opções que não fazem sentido para a família são ignoradas: a interface
       esconde o controle, mas o valor continua no estado da página. */
    opts.reindent = family === 'code' && opts.reindent;
    opts.unescapeNewlines = family === 'text' && opts.unescapeNewlines;
    opts.escapeToOneLine = family === 'text' && opts.escapeToOneLine;
    opts.removeEscapes = family === 'json' && opts.removeEscapes;
    if (family === 'markdown' || family === 'csv') opts.indent = 'keep';

    let outcome;

    if (family === 'json') outcome = formatJson(source, opts);
    else if (family === 'xml' || family === 'html') outcome = formatMarkup(source, opts, family);
    else if (family === 'markdown') outcome = formatMarkdown(source, opts);
    else if (family === 'csv') outcome = formatCsv(source, opts);
    else if (family === 'text') outcome = formatText(source, opts);
    else outcome = formatCode(source, opts);

    const output = outcome.text == null ? source : outcome.text;

    return {
      text: output,
      changed: output !== source,
      type: descriptor.value,
      label: descriptor.label,
      family,
      language: descriptor.language,
      reason: descriptor.reason,
      error: outcome.error || null,
      warnings: outcome.warnings || [],
    };
  }

  return {
    CATALOG,
    DEFAULTS,
    detect,
    describe,
    familyOf,
    languageOf,
    format,
    resolveOptions,
  };
});
