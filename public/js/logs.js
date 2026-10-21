/* =========================================================
   Visualizador de logs (página /logs)

   JSON, NDJSON, CSV, TSV, XLSX, XLS e ODS são lidos no navegador
   (SheetJS em /vendor/xlsx.min.js) e viram uma tabela estilo
   planilha: pesquisa global, filtro por coluna (texto e caixa de
   valores, como no Excel), ordenação, paginação e exportação de
   volta para CSV, Excel e área de transferência. Seus dados não
   saem da máquina.

   O fluxo é sempre: `state.linhas` (objetos de colunas achatadas)
   → `linhasFiltradas()` aplica pesquisa + filtros + ordenação
   → só a fatia da página atual entra no DOM.
   ========================================================= */
(function () {
  'use strict';

  const MD = window.MD;
  const XLSX = window.XLSX;
  const LogCore = window.MDLogCore;
  if (!MD || !XLSX || !LogCore) return;

  const $ = MD.$;
  const toast = MD.toast;
  const debounce = MD.debounce;

  /* O menu de filtro de valores lista no máximo estes distintos por coluna;
     o filtro de texto cobre o resto (logs com IDs únicos produzem uma lista
     infinita de valores que não ajuda ninguém). */
  const MAX_VALORES = 300;
  /* Linhas amostradas para deduzir o tipo de cada coluna. */
  const AMOSTRA_TIPO = 400;
  /* Corte do rótulo dos valores no menu de filtro. */
  const ROTULO_MAX = 120;
  /* A partir daqui, avisamos que filtrar pode demorar. */
  const AVISO_GRANDE = 60000;

  const EXT_EXCEL = ['xlsx', 'xls', 'ods'];

  /* ---------------------------------------------------------
     Estado
     --------------------------------------------------------- */
  const state = {
    /* Objetos de colunas planas: { 'nível': 'erro', 'tempo_ms': 3000 } */
    linhas: [],
    /* { key, label, tipo, hidden, filtro: { op, texto, valores: Set|null } } */
    colunas: [],
    origem: '',
    baseNome: 'logs',
    /* Workbook em memória quando a fonte foi Excel (troca de aba). */
    bufferExcel: null,
    abas: [],
    search: '',
    sort: { key: null, dir: 0 }, /* dir: 1 asc, -1 desc, 0 sem ordenação */
    pageSize: 100,
    page: 1,
  };

  /* Preenchido por `linhasFiltradas()`: a vista está recortada? */
  let filtrada = false;

  const el = {
    chrome: $('#logv-chrome'),
    drop: $('#logv-drop'),
    input: $('#logv-input'),
    reload: $('#logv-reload'),
    alt: $('#logv-alt'),
    search: $('#logv-search'),
    status: $('#logv-status'),
    clear: $('#logv-clear'),
    clear2: $('#logv-clear-2'),
    sheet: $('#logv-sheet'),
    thead: $('#logv-thead'),
    tbody: $('#logv-tbody'),
    noMatch: $('#logv-no-match'),
    noMatchText: $('#logv-nomatch-text'),
    columnsBtn: $('#logv-columns-btn'),
    columnsPop: $('#logv-columns-pop'),
    exportBtn: $('#logv-export-btn'),
    exportPop: $('#logv-export-pop'),
    pagerInfo: $('#logv-pager-info'),
    pageSize: $('#logv-page-size'),
    pagePrev: $('#logv-page-prev'),
    pageNext: $('#logv-page-next'),
    pageNow: $('#logv-page-now'),
    pasteBtn: $('#logv-paste-btn'),
    sampleBtn: $('#logv-sample-btn'),
    modal: $('#logv-modal'),
    pasteText: $('#logv-paste-text'),
    pasteClose: $('#logv-paste-close'),
    pasteLoad: $('#logv-paste-load'),
  };

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */
  function escDuas(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const isVazio = (v) => v === null || v === undefined || v === '';

  /* "1,5" também é número (CSV pt-BR); "1.234,56" fica como texto. */
  function comoNumero(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    const s = v.trim().replace(/\s/g, '');
    if (!/^-?\d+(?:[.,]\d+)?$/.test(s)) return null;
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function conteudo(v) {
    if (isVazio(v)) return '';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (v instanceof Date) return v.toLocaleString('pt-BR');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  /* Rótulo do valor nos menus de filtro — "(vazio)" tem entidade própria. */
  function rotuloValor(v) {
    const s = conteudo(v);
    if (s === '') return '(vazio)';
    return s.length > ROTULO_MAX ? s.slice(0, ROTULO_MAX) + '…' : s;
  }

  const fmt = (n) => n.toLocaleString('pt-BR');

  /* ---------------------------------------------------------
     Normalização — do dado cru para linhas planas
     --------------------------------------------------------- */

  /* Objetos aninhados viram "a.b.c"; arrays viram texto juntado. */
  function achatarDe(orig, saida, prefixo, profundidade) {
    for (const chave of Object.keys(orig)) {
      const valor = orig[chave];
      const caminho = prefixo ? prefixo + '.' + chave : chave;
      if (
        valor !== null && typeof valor === 'object' &&
        !Array.isArray(valor) && !(valor instanceof Date) &&
        profundidade < 4
      ) {
        achatarDe(valor, saida, caminho, profundidade + 1);
      } else if (Array.isArray(valor)) {
        saida[caminho] = valor
          .map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item == null ? '' : item)))
          .join(', ');
      } else {
        saida[caminho] = valor;
      }
    }
  }

  /* Item cru (objeto, array ou escalar) → objeto de colunas planas. */
  function normalizarItem(item) {
    const linha = {};
    if (item !== null && typeof item === 'object') {
      if (Array.isArray(item)) {
        item.forEach((v, i) => { linha['Coluna ' + (i + 1)] = v; });
      } else {
        achatarDe(item, linha, '', 0);
      }
    } else {
      linha['Valor'] = item;
    }
    return linha;
  }

  /* Envelopes comuns de API: { "data": [...], "total": 10 } → o array. */
  function abrirEnvelope(parsed) {
    if (Array.isArray(parsed)) return parsed;
    const lista = Object.values(parsed).find(
      (v) => Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null
    );
    return lista ? lista : [parsed];
  }

  /* JSON monolítico ou NDJSON (um objeto por linha — formato comum de logs). */
  function parsearJson(texto) {
    const aparado = texto.trim();
    if (!aparado) throw new Error('o conteúdo está vazio');
    if (aparado[0] === '[' || aparado[0] === '{') {
      try {
        return abrirEnvelope(JSON.parse(aparado));
      } catch (err) { /* pode ser NDJSON */ }
    }
    const itens = [];
    let rebeldes = 0;
    for (const bruta of aparado.split(/\r?\n/)) {
      const linha = bruta.trim();
      if (!linha) continue;
      try {
        itens.push(JSON.parse(linha));
      } catch (err) {
        rebeldes += 1;
      }
    }
    if (!itens.length || rebeldes > itens.length / 2) {
      throw new Error('não parece JSON, NDJSON nem CSV reconhecível');
    }
    return itens;
  }

  /* Heurística para texto colado sem extensão confiável. */
  function pareceJson(texto) {
    const aparado = texto.trim();
    if (aparado[0] === '[' || aparado[0] === '{') return true;
    /* NDJSON: a primeira linha parseia e começa com "{". */
    const primeira = aparado.split('\n')[0];
    if (/^\s*\{/.test(primeira)) {
      try { JSON.parse(primeira); return true; } catch (err) { /* não */ }
    }
    return false;
  }

  /* Descobre o separador dominante nas cinco primeiras linhas. */
  function farejarDelimitador(texto) {
    const pegaDia = texto.split(/\r\n|\r|\n/).slice(0, 5).join('\n');
    let melhor = ',', melhorN = 0;
    for (const sep of [';', ',', '\t', '|']) {
      const n = (pegaDia.match(new RegExp('\\' + sep, 'g')) || []).length;
      if (n > melhorN) { melhor = sep; melhorN = n; }
    }
    return melhor;
  }

  /* ---------------------------------------------------------
     Leitura dos formatos (SheetJS in, matriz AOA out)
     --------------------------------------------------------- */
  function lerTabelaDoTexto(texto) {
    try {
      return XLSX.read(texto, { type: 'string', FS: farejarDelimitador(texto) });
    } catch (err) {
      throw new Error('falha ao interpretar CSV/TSV: ' + (err.message || err));
    }
  }

  function lerExcel(bytes) {
    try {
      return XLSX.read(bytes, { type: 'array', cellDates: true });
    } catch (err) {
      throw new Error('falha ao abrir a planilha: ' + (err.message || err));
    }
  }

  /* Melhor aba do workbook: a que tem mais linhas. */
  function melhorMatriz(wb) {
    let nome = null, matriz = null;
    for (const aba of wb.SheetNames) {
      const tentativa = XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true, defval: null });
      if (!matriz || tentativa.length > matriz.length) { matriz = tentativa; nome = aba; }
    }
    if (!matriz) throw new Error('a planilha está vazia');
    return { nome, matriz };
  }

  /* ---------------------------------------------------------
     Instalação do dataset
     --------------------------------------------------------- */

  /* AOA do SheetJS → linhas achatadas. A primeira linha com rótulos serve
     de cabeçalho; células já tipadas (número/data do Excel) na primeira
     linha indicam arquivo sem cabeçalho — tratamos tudo como dado. */
  function linhasDeMatriz(matriz) {
    const corpo = matriz.filter((r) => Array.isArray(r) && r.some((c) => !isVazio(c)));
    if (!corpo.length) throw new Error('a planilha não tem linhas com conteúdo');

    let rotulos = null;
    for (let i = 0; i < Math.min(corpo.length, 5); i++) {
      const cheios = corpo[i].filter((c) => !isVazio(c)).length;
      if (cheios === 0) continue;
      const primeiraTemDado = corpo[i].some((c) => typeof c === 'number' || c instanceof Date);
      if (!primeiraTemDado) {
        rotulos = corpo[i];
        corpo.splice(i, 1);
      }
      break;
    }

    /* Cabeçalho limpo e sem duplicata: a segunda "status" vira "status (2)". */
    if (rotulos) {
      const usados = new Set();
      rotulos = rotulos.map((c, i) => {
        let base = isVazio(c) ? 'Coluna ' + (i + 1) : String(c).trim();
        let final = base;
        let n = 2;
        while (usados.has(final)) final = base + ' (' + n++ + ')';
        usados.add(final);
        return final;
      });
    }

    return corpo.map((linhaBruta) => {
      const linha = {};
      linhaBruta.forEach((valor, i) => {
        if (isVazio(valor)) return;
        const rotulo = rotulos && rotulos[i] ? rotulos[i] : 'Coluna ' + (i + 1);
        linha[rotulo] = valor;
      });
      return linha;
    });
  }

  /* Colunas na ordem de primeira aparição (campos espalhados de logs ficam
     na ordem em que aparecem). */
  function coletarColunas(linhas) {
    const ordem = [];
    const vistos = new Set();
    for (const linha of linhas) {
      for (const k of Object.keys(linha)) {
        const chave = k.trim() ? k : 'Valor';
        if (!vistos.has(chave)) { vistos.add(chave); ordem.push(chave); }
      }
    }
    return ordem;
  }

  function deduzirTipo(linhas, key) {
    let numero = false, booleano = false, data = false, texto = false, amostradas = 0;
    for (let i = 0; i < linhas.length && amostradas < AMOSTRA_TIPO; i++) {
      const v = linhas[i][key];
      if (isVazio(v)) continue;
      amostradas++;
      if (typeof v === 'boolean' || v === 'true' || v === 'false') booleano = true;
      else if (v instanceof Date) data = true;
      else if (typeof v === 'number' || comoNumero(v) !== null) numero = true;
      else texto = true;
    }
    if (!amostradas) return 'texto';
    if (texto) return 'texto';
    if (numero) return 'numero';
    if (data) return 'data';
    return 'booleano';
  }

  function instalar({ linhasCru, matriz, aba, nome }) {
    /* 1) Linhas achatadas */
    const base = matriz ? linhasDeMatriz(matriz) : (linhasCru || []).map(normalizarItem);
    if (!base.length) throw new Error('nenhuma linha encontrada no conteúdo');

    state.linhas = base;

    /* 2) Colunas na ordem de primeira aparição, com tipo deduzido.
       Colunas em que ninguém aparece (todos os valores nulos) são ruído
       comum de logs — saem, a menos que sejam a única. */
    let chaves = coletarColunas(base);
    if (chaves.length > 1) {
      chaves = chaves.filter((key) => base.some((linha) => !isVazio(linha[key])));
    }
    state.colunas = chaves.map((key) => ({
      key,
      label: key,
      tipo: deduzirTipo(base, key),
      hidden: false,
      filtro: { op: 'nenhum', texto: '', valores: null },
    }));

    /* 3) Origem e abas (Excel segue em memória para trocar de aba) */
    state.abas = state.bufferExcel ? state.bufferExcel.SheetNames.slice() : [];
    state.baseNome = nome.replace(/\.[^.]+$/, '') || 'logs';
    /* O nome da aba só entra quando há mais de uma — "Sheet1" sozinho é ruído. */
    state.origem = state.baseNome + (state.abas.length > 1 && aba ? ' · ' + aba : '');

    /* 4) Vista zerada */
    state.search = '';
    state.sort = { key: null, dir: 0 };
    state.page = 1;
    valoresCache = { key: null, lista: null };

    /* 5) Tela */
    el.chrome.hidden = false;
    el.drop.hidden = true;
    el.alt.hidden = true;
    el.search.value = '';
    el.clear.hidden = true;
    el.clear2.hidden = true;
    renderizarSeletorAbas(aba);
    atualizarColunasPop();
    renderizar();
    if (state.linhas.length > AVISO_GRANDE) {
      toast('Arquivo grande: ' + fmt(state.linhas.length) + ' linhas — filtros podem levar alguns segundos', 'error');
    } else {
      toast('Carregado: ' + fmt(state.linhas.length) + ' linhas · ' + state.colunas.length + ' colunas');
    }
  }

  function renderizarSeletorAbas(abaAtiva) {
    const temAbas = state.abas.length > 1;
    el.sheet.hidden = !temAbas;
    if (temAbas) {
      el.sheet.innerHTML = state.abas.map((nome) =>
        '<option value="' + escDuas(nome) + '"' + (nome === abaAtiva ? ' selected' : '') + '>' + escDuas(nome) + '</option>'
      ).join('');
    } else {
      el.sheet.innerHTML = '';
    }
  }

  /* `fonte` é um File, ou objeto colado com { text(), name }. */
  async function carregarArquivo(fonte, nomeForcado) {
    if (!fonte) return;
    const nome = nomeForcado || fonte.name || 'dados colados';
    const ext = (nome.split('.').pop() || '').toLowerCase();
    try {
      if (EXT_EXCEL.includes(ext)) {
        if (!fonte.arrayBuffer) throw new Error('esperava um arquivo de verdade');
        state.bufferExcel = lerExcel(new Uint8Array(await fonte.arrayBuffer()));
        const m = melhorMatriz(state.bufferExcel);
        instalar({ matriz: m.matriz, aba: m.nome, nome });
        return;
      }
      const texto = typeof fonte.text === 'function' ? await fonte.text() : String(fonte);
      state.bufferExcel = null;
      /* Logs de linha (IIS, pm2/Nest...) têm prioridade sobre JSON/CSV. */
      if (ext === 'log' || LogCore.isTextoLinhasLog(texto)) {
        instalar({ linhasCru: LogCore.parsearLinhasLog(texto), nome });
      } else if (ext !== 'csv' && ext !== 'tsv' && ext !== 'txt' && pareceJson(texto)) {
        instalar({ linhasCru: parsearJson(texto), nome });
      } else {
        const m = melhorMatriz(lerTabelaDoTexto(texto));
        instalar({ matriz: m.matriz, nome });
      }
    } catch (err) {
      state.bufferExcel = null;
      toast('Não consegui ler: ' + (err.message || err), 'error');
    }
  }

  /* ---------------------------------------------------------
     Valores distintos (para o menu de filtro), com cache por coluna
     --------------------------------------------------------- */
  let valoresCache = { key: null, lista: null };

  function valoresDistintos(coluna) {
    if (valoresCache.key === coluna.key && valoresCache.lista) return valoresCache.lista;
    const contagem = new Map();
    for (const linha of state.linhas) {
      const rotulo = rotuloValor(linha[coluna.key]);
      contagem.set(rotulo, (contagem.get(rotulo) || 0) + 1);
    }
    const lista = Array.from(contagem, ([valor, n]) => ({ valor, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, MAX_VALORES);
    valoresCache = { key: coluna.key, lista: { lista, total: contagem.size } };
    return valoresCache.lista;
  }

  /* ---------------------------------------------------------
     Pipeline: pesquisa + filtros + ordenação
     --------------------------------------------------------- */
  function linhasFiltradas() {
    const pesquisa = state.search.trim().toLowerCase();
    const chavesPesquisa = state.colunas.filter((c) => !c.hidden).map((c) => c.key);
    const filtros = state.colunas.filter((c) => c.filtro.op !== 'nenhum' || c.filtro.valores);
    filtrada = !!(pesquisa || filtros.length);

    const saida = [];
    for (const linha of state.linhas) {
      if (pesquisa) {
        let achei = false;
        for (const key of chavesPesquisa) {
          if (conteudo(linha[key]).toLowerCase().includes(pesquisa)) { achei = true; break; }
        }
        if (!achei) continue;
      }

      let manter = true;
      for (const coluna of filtros) {
        const bruto = linha[coluna.key];
        const f = coluna.filtro;

        if (f.op !== 'nenhum') {
          const s = conteudo(bruto).toLowerCase();
          const agulha = f.texto.trim().toLowerCase();
          switch (f.op) {
            case 'contem':
              if (!agulha || !s.includes(agulha)) { manter = false; }
              break;
            case 'nao_contem':
              if (agulha && s.includes(agulha)) { manter = false; }
              break;
            case 'igual':
              if (s !== agulha) { manter = false; }
              break;
            case 'diferente':
              if (s === agulha) { manter = false; }
              break;
            case 'vazio':
              if (s === '') { manter = false; }
              break;
            case 'nao_vazio':
              if (s !== '') { manter = false; }
              break;
            case 'maior':
            case 'menor': {
              const limite = comoNumero(f.texto), dado = comoNumero(bruto);
              if (limite === null || dado === null || (f.op === 'maior' ? !(dado > limite) : !(dado < limite))) {
                manter = false;
              }
              break;
            }
          }
          if (!manter) break;
        }

        if (f.valores && !f.valores.has(rotuloValor(bruto))) { manter = false; break; }
      }

      if (manter) saida.push(linha);
    }

    if (state.sort.dir && state.sort.key) {
      const { key, dir } = state.sort;
      const coluna = state.colunas.find((c) => c.key === key);
      const tipo = coluna ? coluna.tipo : 'texto';
      saida.sort((a, b) => {
        const va = a[key], vb = b[key];
        const vaV = isVazio(va), vbV = isVazio(vb);
        if (vaV && vbV) return 0;
        if (vaV) return 1;  /* vazios sempre por último */
        if (vbV) return -1;
        let cmp;
        if (tipo === 'numero') cmp = (comoNumero(va) || 0) - (comoNumero(vb) || 0);
        else if (tipo === 'data') {
          cmp = (va instanceof Date ? va : new Date(va)).getTime() -
                (vb instanceof Date ? vb : new Date(vb)).getTime();
        } else {
          cmp = conteudo(va).localeCompare(conteudo(vb), 'pt-BR', { numeric: true });
        }
        return dir * cmp;
      });
    }
    return saida;
  }

  function limparFiltros() {
    state.colunas.forEach((c) => { c.filtro = { op: 'nenhum', texto: '', valores: null }; });
    state.search = '';
    el.search.value = '';
    state.page = 1;
    fecharMenus();
    renderizar();
    toast('Filtros limpos');
  }

  /* ---------------------------------------------------------
     Renderização
     --------------------------------------------------------- */
  function renderizarCabecalho() {
    const visiveis = state.colunas.filter((c) => !c.hidden);
    const ordenada = (c) => state.sort.key === c.key && state.sort.dir;
    const ths = visiveis.map((c) => {
      const filtradaCol = c.filtro.op !== 'nenhum' || c.filtro.valores;
      const seta = ordenada(c)
        ? '<span class="logv-sort">' + (state.sort.dir > 0 ? '▲' : '▼') + '</span>'
        : '';
      const funil = '<button type="button" class="logv-th-btn' + (filtradaCol ? ' is-filtered' : '') +
        '" data-menu="' + escDuas(c.key) + '" title="Filtrar coluna">' + (filtradaCol ? '▼' : '▾') + '</button>';
      return '<th data-key="' + escDuas(c.key) + '"' +
        ' class="' + (c.tipo === 'numero' ? 'is-numeric ' : '') + (ordenada(c) ? 'is-sorted' : '') + '">' +
        '<div class="logv-th"><button type="button" class="logv-th-label" data-sort="' + escDuas(c.key) +
        '" title="Ordenar">' + escDuas(c.label) + seta + '</button>' + funil + '</div></th>';
    }).join('');
    el.thead.innerHTML = '<tr>' + ths + '</tr>';
  }

  function renderizarCorpo(linhas) {
    const visiveis = state.colunas.filter((c) => !c.hidden);
    if (!visiveis.length) { el.tbody.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    for (const linha of linhas) {
      const tr = document.createElement('tr');
      for (const c of visiveis) {
        const td = document.createElement('td');
        const v = linha[c.key];
        const s = conteudo(v);
        if (isVazio(v)) {
          td.className = 'is-empty';
          td.textContent = '—';
        } else {
          if (c.tipo === 'numero') td.className = 'is-numeric';
          td.textContent = s;
          td.title = s.length > 300 ? s.slice(0, 300) + '…' : s;
        }
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    el.tbody.innerHTML = '';
    el.tbody.appendChild(frag);
  }

  function atualizarColunasPop() {
    const itens = state.colunas.map((c) =>
      '<label class="logv-check"><input type="checkbox" data-col-check="' + escDuas(c.key) + '"' +
      (c.hidden ? '' : ' checked') + '><span title="' + escDuas(c.label) + '">' + escDuas(c.label) + '</span></label>'
    ).join('');
    el.columnsPop.innerHTML =
      '<div class="logv-pop-head"><span>Colunas exibidas</span>' +
      '<span><button type="button" class="logv-mini" data-col-all="1">tudo</button>' +
      '<button type="button" class="logv-mini" data-col-all="0">nenhuma</button></span></div>' +
      '<div class="logv-pop-list">' + (itens || '<p class="muted">Sem colunas.</p>') + '</div>';
  }

  function renderizar() {
    renderizarCabecalho();
    const visiveisQtd = state.colunas.filter((c) => !c.hidden).length;
    const resultado = linhasFiltradas();

    if (state.pageSize) {
      const totalPaginas = Math.max(1, Math.ceil(resultado.length / state.pageSize));
      if (state.page > totalPaginas) state.page = totalPaginas;
      const inicio = (state.page - 1) * state.pageSize;
      const fim = Math.min(inicio + state.pageSize, resultado.length);
      renderizarCorpo(resultado.slice(inicio, fim));
      el.pagerInfo.textContent = resultado.length
        ? fmt(inicio + 1) + '–' + fmt(fim) + ' de ' + fmt(resultado.length)
        : '0 de 0';
      el.pageNow.textContent = state.page + ' / ' + totalPaginas;
      el.pagePrev.disabled = state.page <= 1;
      el.pageNext.disabled = state.page >= totalPaginas;
    } else {
      renderizarCorpo(resultado);
      el.pagerInfo.textContent = resultado.length ? fmt(resultado.length) + ' linhas' : '';
      el.pageNow.textContent = '1 / 1';
      el.pagePrev.disabled = el.pageNext.disabled = true;
    }

    /* Estado vazio: filtros sufocaram tudo — ou nenhuma coluna visível. */
    if (!resultado.length) {
      el.noMatchText.textContent = visiveisQtd === 0
        ? 'Nenhuma coluna visível — reative no menu Colunas.'
        : 'Nenhuma linha atende aos filtros.';
      el.noMatch.hidden = false;
    } else {
      el.noMatch.hidden = true;
    }

    el.status.textContent = fmt(state.linhas.length) + ' linhas · ' +
      visiveisQtd + '/' + state.colunas.length + ' colunas' +
      (filtrada ? ' · filtradas: ' + fmt(resultado.length) : '');
    el.clear.hidden = !filtrada;
    el.exportBtn.disabled = state.colunas.length === 0;
  }

  /* ---------------------------------------------------------
     Menu de coluna (ordenação + filtro + valores)
     --------------------------------------------------------- */
  function abrirMenu(coluna, thElement) {
    fecharMenus();

    const f = coluna.filtro;
    const tipada = coluna.tipo === 'numero';
    const ops = tipada
      ? [['nenhum', 'Sem filtro'], ['contem', 'Contém'], ['igual', 'Igual a'], ['diferente', 'Diferente de'],
         ['maior', 'Maior que'], ['menor', 'Menor que'], ['vazio', 'Vazio'], ['nao_vazio', 'Não vazio']]
      : [['nenhum', 'Sem filtro'], ['contem', 'Contém'], ['nao_contem', 'Não contém'], ['igual', 'Igual a'],
         ['diferente', 'Diferente de'], ['vazio', 'Vazio'], ['nao_vazio', 'Não vazio']];

    const { lista, total } = valoresDistintos(coluna);
    const marcadosAgora = f.valores ? f.valores.size : lista.length;

    const menu = document.createElement('div');
    menu.className = 'logv-menu';
    menu.id = 'logv-menu';
    menu.innerHTML =
      '<div class="logv-menu-head"><strong title="' + escDuas(coluna.label) + '">' + escDuas(coluna.label) + '</strong>' +
      '<button type="button" class="logv-mini" data-fechar aria-label="Fechar">✕</button></div>' +

      '<div class="logv-menu-sec"><span class="logv-menu-rot">Ordenar</span>' +
      '<div class="logv-menu-btns">' +
      '<button type="button" class="logv-mini" data-ord="asc">▲ A→Z</button>' +
      '<button type="button" class="logv-mini" data-ord="desc">▼ Z→A</button>' +
      '<button type="button" class="logv-mini" data-ord="off">Sem</button>' +
      '</div></div>' +

      '<div class="logv-menu-sec"><span class="logv-menu-rot">' + (tipada ? 'Filtro numérico' : 'Filtro de texto') + '</span>' +
      '<div class="logv-menu-row"><select class="select logv-op">' +
      ops.map((op) => '<option value="' + op[0] + '"' + (op[0] === f.op ? ' selected' : '') + '>' + op[1] + '</option>').join('') +
      '</select><input type="text" class="text-input logv-valor" placeholder="valor"' +
      (['vazio', 'nao_vazio', 'nenhum'].includes(f.op) ? ' hidden' : ' value="' + escDuas(f.texto) + '"') + '></div></div>' +

      '<div class="logv-menu-sec"><span class="logv-menu-rot">Valores' +
      (total > lista.length ? ' — ' + lista.length + ' de ' + total + ' distintos' : ' (' + lista.length + ')') + '</span>' +
      '<input type="text" class="text-input logv-busca-val" placeholder="Buscar valor…">' +
      '<div class="logv-val-list">' +
      lista.map((item) =>
        '<label><input type="checkbox" data-val="' + escDuas(item.valor) + '"' +
        (!f.valores || f.valores.has(item.valor) ? ' checked' : '') + '>' +
        '<span title="' + escDuas(item.valor) + '">' + escDuas(item.valor) + '</span><b>' + item.n + '</b></label>'
      ).join('') +
      '</div>' +
      '<div class="logv-menu-btns"><button type="button" class="logv-mini" data-todos="1">Marcar todos</button>' +
      '<button type="button" class="logv-mini" data-todos="0">Desmarcar todos</button></div>' +
      '<p class="logv-menu-nota">Aplica ao fechar (ou Enter).</p>' +
      '</div>';
    document.body.appendChild(menu);

    /* Posição: logo abaixo do cabeçalho dentro da janela. */
    const dim = menu.getBoundingClientRect();
    const ret = thElement.getBoundingClientRect();
    let topo = ret.bottom + 4;
    let esquerda = Math.min(Math.max(8, ret.left), window.innerWidth - dim.width - 8);
    if (topo + dim.height > window.innerHeight - 8) {
      topo = Math.max(8, window.innerHeight - dim.height - 8);
    }
    menu.style.top = topo + 'px';
    menu.style.left = esquerda + 'px';

    /* Filtro de texto: guarda no estado do menu, aplica ao fechar. */
    const opSelect = menu.querySelector('.logv-op');
    const valorInput = menu.querySelector('.logv-valor');
    opSelect.addEventListener('change', () => {
      f.op = opSelect.value;
      valorInput.hidden = ['vazio', 'nao_vazio', 'nenhum'].includes(opSelect.value);
    });
    valorInput.addEventListener('input', () => { f.texto = valorInput.value; });

    /* Busca dentro da lista de valores. */
    menu.querySelector('.logv-busca-val').addEventListener('input', (ev) => {
      const termo = ev.target.value.toLowerCase();
      menu.querySelectorAll('.logv-val-list label').forEach((lb) => {
        lb.hidden = !!termo && !lb.textContent.toLowerCase().includes(termo);
      });
    });

    function aplicarValores() {
      const caixas = Array.from(menu.querySelectorAll('.logv-val-list input'));
      const todosMarcados = caixas.every((c) => c.checked);
      const nenhumMarcado = caixas.every((c) => !c.checked);
      /* Tudo marcado = sem filtro de valores; nada marcado = bloqueia tudo. */
      coluna.filtro.valores = todosMarcados ? null : new Set(caixas.filter((c) => c.checked).map((c) => c.getAttribute('data-val')));
    }

    menu.querySelectorAll('.logv-val-list input').forEach((caixa) =>
      caixa.addEventListener('change', aplicarValores)
    );

    menu.addEventListener('click', (ev) => {
      const mini = ev.target.closest('button');
      if (!mini) return;
      ev.stopPropagation();
      if (mini.hasAttribute('data-fechar')) { fecharMenus(); renderizar(); return; }
      if (mini.hasAttribute('data-ord')) {
        const modo = mini.getAttribute('data-ord');
        state.sort = modo === 'off' ? { key: null, dir: 0 } : { key: coluna.key, dir: modo === 'asc' ? 1 : -1 };
        state.page = 1;
        fecharMenus();
        renderizar();
        return;
      }
      if (mini.hasAttribute('data-todos')) {
        const marcar = mini.getAttribute('data-todos') === '1';
        menu.querySelectorAll('.logv-val-list input').forEach((c) => { c.checked = marcar; });
        aplicarValores();
      }
    });

    /* Enter fecha e aplica — fluidez de "digitei, apertei, sumiu". */
    menu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target.matches('input, select')) {
        ev.preventDefault();
        fecharMenus();
        renderizar();
      }
    });
  }

  function fecharMenus() {
    const menu = $('#logv-menu');
    if (menu) menu.remove();
    el.columnsPop.hidden = true;
    el.exportPop.hidden = true;
  }

  /* ---------------------------------------------------------
     Exportação
     --------------------------------------------------------- */
  function recorte() {
    const colunas = state.colunas.filter((c) => !c.hidden);
    const linhas = linhasFiltradas();
    const matriz = [colunas.map((c) => c.label)];
    for (const linha of linhas) {
      matriz.push(colunas.map((c) => (isVazio(linha[c.key]) ? '' : linha[c.key])));
    }
    return { linhas, matriz };
  }

  function nomeArquivo(ext) {
    const carimbo = new Date()
      .toLocaleString('sv-SE') /* "2026-10-21 14:03" */
      .replace(' ', '-')
      .replace(/:/g, '');
    return (state.baseNome || 'logs') + (filtrada ? '-filtrado' : '') + '-' + carimbo + '.' + ext;
  }

  function baixar(blob, nome) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportarCsv(delimitador) {
    const { matriz } = recorte();
    const cel = (v) => {
      const s = v instanceof Date ? v.toLocaleString('pt-BR') : conteudo(v);
      if (!s) return '';
      /* Citar: contém delimitador, aspas ou quebra de linha. */
      return (new RegExp('["\\n\\r' + delimitador.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + ']').test(s)
        ? '"' + s.replace(/"/g, '""') + '"'
        : s);
    };
    const csv = '\uFEFF' + matriz.map((r) => r.map(cel).join(delimitador)).join('\r\n');
    baixar(new Blob([csv], { type: 'text/csv;charset=utf-8' }), nomeArquivo('csv'));
    toast('CSV exportado — ' + descricaoExportacao());
  }

  function exportarExcel() {
    const { matriz } = recorte();
    const ws = XLSX.utils.aoa_to_sheet(matriz, { cellDates: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Logs');
    XLSX.writeFile(wb, nomeArquivo('xlsx'), { bookType: 'xlsx' });
    toast('Excel exportado — ' + descricaoExportacao());
  }

  async function exportarClipboard() {
    const { matriz } = recorte();
    const tsv = matriz
      .map((r) => r.map((v) => (v instanceof Date ? v.toLocaleString('pt-BR') : conteudo(v))).join('\t'))
      .join('\n');
    await navigator.clipboard.writeText(tsv);
    toast('Copiado (' + descricaoExportacao() + ') — cole na planilha');
  }

  function descricaoExportacao() {
    const n = linhasFiltradas().length;
    return filtrada
      ? fmt(n) + ' registros filtrados'
      : 'todos os ' + fmt(state.linhas.length) + ' registros';
  }

  /* ---------------------------------------------------------
     Exemplo (dados de teste, para brincar sem arquivo)
     --------------------------------------------------------- */
  function carregarExemplo() {
    const niveis = ['info', 'info', 'info', 'warn', 'error', 'debug'];
    const rotas = ['/api/v1/pedidos', '/api/v1/clientes', '/login', '/api/v1/relatorios', '/health'];
    const agentes = ['Chrome/126', 'Firefox/128', 'Safari/17.4', 'App-mobile/2.1'];
    const mensagens = {
      info: 'requisição processada com sucesso',
      debug: 'resposta montada em memória',
      warn: 'latência acima do esperado no serviço a jusante',
      error: 'falha na conexão com o banco de pedidos',
    };
    const agora = Date.now();
    const itens = [];
    for (let i = 0; i < 180; i++) {
      const nivel = niveis[i % niveis.length];
      itens.push({
        timestamp: new Date(agora - i * 4700),
        nivel,
        metodo: nivel === 'error' ? 'POST' : 'GET',
        rota: rotas[i % rotas.length],
        status: nivel === 'error' ? 503 : 200,
        tempo_ms: nivel === 'error' ? 1000 + ((i * 137) % 3000) : 20 + ((i * 53) % 900),
        ip: '10.0.' + (i % 40) + '.' + ((i * 7) % 254),
        usuario: 'user-' + (1 + (i % 23)),
        user_agent: agentes[i % agentes.length],
        mensagem: mensagens[nivel],
        detalhe: nivel === 'error' ? { codigo: 'ECONNRESET', tentativas: 2 } : null,
      });
    }
    state.bufferExcel = null;
    instalar({ linhasCru: itens, nome: 'exemplo de log' });
  }

  /* ---------------------------------------------------------
     Eventos
     --------------------------------------------------------- */

  /* Zona de arrastar */
  ['dragenter', 'dragover'].forEach((tipo) =>
    el.drop.addEventListener(tipo, (ev) => {
      ev.preventDefault();
      el.drop.classList.add('is-over');
    })
  );
  ['dragleave', 'drop'].forEach((tipo) =>
    el.drop.addEventListener(tipo, (ev) => {
      ev.preventDefault();
      el.drop.classList.remove('is-over');
    })
  );
  el.drop.addEventListener('drop', (ev) => {
    const arquivo = ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (arquivo) carregarArquivo(arquivo);
  });
  el.drop.addEventListener('click', () => el.input.click());
  el.reload.addEventListener('click', () => el.input.click());
  el.input.addEventListener('change', () => {
    if (el.input.files && el.input.files[0]) carregarArquivo(el.input.files[0]);
    el.input.value = '';
  });

  /* Enquanto o dado não chegou, a janela inteira aceita o arrasto — evita
     que o navegador abra o arquivo por engano. */
  document.addEventListener('dragover', (ev) => {
    if (el.chrome.hidden) ev.preventDefault();
  });
  document.addEventListener('drop', (ev) => {
    if (el.chrome.hidden) {
      ev.preventDefault();
      const arquivo = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (arquivo) carregarArquivo(arquivo);
    }
  });

  /* Pesquisa */
  el.search.addEventListener('input', debounce(() => {
    state.search = el.search.value;
    state.page = 1;
    renderizar();
  }, 180));

  el.clear.addEventListener('click', limparFiltros);
  el.clear2.addEventListener('click', limparFiltros);

  /* Paginação */
  el.pageSize.addEventListener('change', () => {
    state.pageSize = Number(el.pageSize.value);
    state.page = 1;
    renderizar();
  });
  el.pagePrev.addEventListener('click', () => { state.page -= 1; renderizar(); });
  el.pageNext.addEventListener('click', () => { state.page += 1; renderizar(); });

  /* Troca de aba (Excel multi-aba) */
  el.sheet.addEventListener('change', () => {
    const nomeAba = el.sheet.value;
    if (!state.bufferExcel || !state.bufferExcel.Sheets[nomeAba]) return;
    const matriz = XLSX.utils.sheet_to_json(state.bufferExcel.Sheets[nomeAba], { header: 1, raw: true, defval: null });
    try {
      instalar({ matriz, aba: nomeAba, nome: state.baseNome + '.xlsx' });
    } catch (err) {
      toast('Não consegui abrir a aba: ' + (err.message || err), 'error');
    }
  });

  /* Delegação na tabela: rótulo ordena (asc → desc → sem), funil abre menu */
  el.thead.addEventListener('click', (ev) => {
    const sortBtn = ev.target.closest('[data-sort]');
    if (sortBtn) {
      const key = sortBtn.getAttribute('data-sort');
      state.sort = state.sort.key === key && state.sort.dir === 1
        ? { key, dir: -1 }
        : (state.sort.key === key && state.sort.dir === -1 ? { key: null, dir: 0 } : { key, dir: 1 });
      state.page = 1;
      renderizar();
      return;
    }
    const menuBtn = ev.target.closest('[data-menu]');
    if (menuBtn) {
      const coluna = state.colunas.find((c) => c.key === menuBtn.getAttribute('data-menu'));
      if (coluna) abrirMenu(coluna, menuBtn.closest('th'));
      return;
    }
  });

  /* Popover de colunas */
  el.columnsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const abrindo = el.columnsPop.hidden;
    fecharMenus();
    if (abrindo) {
      atualizarColunasPop();
      el.columnsPop.hidden = false;
    }
  });
  el.columnsPop.addEventListener('click', (ev) => {
    const mini = ev.target.closest('[data-col-all]');
    if (mini) {
      const marcar = mini.getAttribute('data-col-all') === '1';
      el.columnsPop.querySelectorAll('input[data-col-check]').forEach((c) => { c.checked = marcar; });
      return;
    }
    const caixa = ev.target.closest('input[data-col-check]');
    if (caixa) {
      const coluna = state.colunas.find((c) => c.key === caixa.getAttribute('data-col-check'));
      if (coluna) coluna.hidden = !caixa.checked;
      renderizar();
    }
  });

  /* Popover de exportação */
  el.exportBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const abrindo = el.exportPop.hidden;
    fecharMenus();
    if (abrindo) el.exportPop.hidden = false;
  });
  el.exportPop.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-export]');
    if (!item) return;
    ev.stopPropagation();
    fecharMenus();
    try {
      const modo = item.getAttribute('data-export');
      if (modo === 'xlsx') exportarExcel();
      else if (modo === 'csv') exportarCsv(',');
      else if (modo === 'csv-semicolon') exportarCsv(';');
      else if (modo === 'copy') exportarClipboard().catch(() => toast('Sem acesso à área de transferência', 'error'));
    } catch (err) {
      toast('Falha na exportação: ' + (err.message || err), 'error');
    }
  });

  /* Colar dados */
  el.pasteBtn.addEventListener('click', () => {
    el.modal.hidden = false;
    el.pasteText.focus();
  });
  el.pasteClose.addEventListener('click', () => { el.modal.hidden = true; });
  el.pasteLoad.addEventListener('click', () => {
    const texto = el.pasteText.value;
    if (!texto.trim()) { toast('Cole algum conteúdo primeiro'); return; }
    el.modal.hidden = true;
    const kind = pareceJson(texto) ? 'dados colados.json' : 'dados colados.csv';
    carregarArquivo({ text: () => Promise.resolve(texto), name: kind }, kind);
    el.pasteText.value = '';
  });

  el.sampleBtn.addEventListener('click', carregarExemplo);

  /* "Aplica ao fechar" também quando o fechamento vem de fora (clique no
     vazio ou Esc): o menu guarda o que foi editado, mas a tabela só
     reage ao renderizar(). */
  function dispensarMenus() {
    const menu = $('#logv-menu');
    fecharMenus();
    if (menu) renderizar();
  }

  /* Fora de foco / Esc dispensam menus e modal */
  document.addEventListener('click', (ev) => {
    if (
      !ev.target.closest('#logv-menu') &&
      !ev.target.closest('[data-menu]') &&
      !ev.target.closest('#logv-columns-btn') &&
      !ev.target.closest('#logv-columns-pop') &&
      !ev.target.closest('#logv-export-btn') &&
      !ev.target.closest('#logv-export-pop')
    ) {
      dispensarMenus();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      dispensarMenus();
      if (!el.modal.hidden) el.modal.hidden = true;
    }
  });

  /* Marcador para sondas/espera: o script inteiro ligou os listeners. */
  document.body.setAttribute('data-logs-ready', '1');
})();
