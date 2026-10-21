'use strict';
/**
 * Sonda do visualizador de logs (/logs): abre o Chrome headless via DevTools
 * Protocol e exercita a página como usuário — exemplo carregado na tela,
 * pesquisa, ordenação, filtro por coluna (menu de valores), colunas escondidas,
 * upload de XLSX gerado na própria página (2 abas), colar NDJSON e CSV e
 * exportação CSV capturando o Blob gerado.
 *
 * Uso: node scripts/probe-logs.js   (exige o servidor rodando em :3000)
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const ROOT_EXEMPLO = path.join(__dirname, '..', 'logs-exemplo');

const BASE = process.env.BASE || 'http://localhost:3000';

const chrome = BROWSERS.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('Sem Chrome/Edge instalado para a sonda.');
  process.exit(1);
}

let pass = 0;
const falhas = [];

async function passa(nome, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + nome);
  } catch (err) {
    falhas.push(nome);
    console.log('  FAIL ' + nome + '\n         ' + (err && err.message));
  }
}

(async () => {
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'md-probe-logs-'));
  const porta = 9500 + (process.pid % 400);
  const proc = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1400,900',
    '--remote-debugging-port=' + porta,
    '--user-data-dir=' + perfil,
    '--disable-application-cache',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    /* --- conexão CDP --- */
    let alvo = null;
    for (let i = 0; i < 100 && !alvo; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + porta + '/json/new?' + BASE + '/logs', { method: 'PUT' });
        if (r.ok) alvo = await r.json();
      } catch (err) { /* Chrome ainda subindo */ }
      if (!alvo) await new Promise((res) => setTimeout(res, 100));
    }
    if (!alvo || !alvo.webSocketDebuggerUrl) throw new Error('Chrome não abriu a aba para /logs');

    const ws = new WebSocket(alvo.webSocketDebuggerUrl);
    let seq = 0;
    const pendentes = new Map();
    const rpc = (method, params) => new Promise((res, rej) => {
      const id = ++seq;
      pendentes.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const pend = pendentes.get(msg.id);
      if (!pend) return;
      pendentes.delete(msg.id);
      if (msg.error) pend.rej(new Error(msg.error.message));
      else pend.res(msg.result);
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });

    const evalua = (expression, awaitPromise) =>
      rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });

    const valor = async (expression, awaitPromise) => {
      const r = await evalua(expression, awaitPromise);
      if (r.exceptionDetails) throw new Error('| ' + expression.slice(0, 80) + ' → ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'exceção'));
      return r.result && r.result.value;
    };

    const espera = async (expression, tetoMs, descricao) => {
      const teto = tetoMs || 10000;
      const inicio = Date.now();
      for (;;) {
        if (await valor(expression)) return true;
        if (Date.now() - inicio > teto) throw new Error('condição não veio: ' + (descricao || expression));
        await new Promise((res) => setTimeout(res, 200));
      }
    };

    /* Página certa e com o script ligado (título + marcador de prontidão). */
    await espera(
      "document.title.indexOf('Logs') >= 0 && document.body.hasAttribute('data-logs-ready')",
      20000,
      'página /logs carregada com o script pronto'
    );

    console.log('\n== exemplo carregado ==');

    await passa('tela inicial: sem dado, zona de arrasto à vista', async () => {
      assert2(await valor(
        "document.querySelector('#logv-drop') && document.querySelector('#logv-chrome') && document.querySelector('#logv-drop').hidden === false && document.querySelector('#logv-chrome').hidden === true"
      ), 'esperava dropzone visível e painel escondido');
    });

    await passa('exemplo carrega 180 linhas e pagina 100', async () => {
      await valor("document.getElementById('logv-sample-btn').click()");
      await espera("document.querySelector('#logv-chrome').hidden === false", 8000, 'painel apareceu');
      await espera("document.querySelectorAll('#logv-tbody tr').length === 100", 4000, '100 linhas na página');
      const status = await valor("document.getElementById('logv-status').textContent");
      assert2(/180 linhas/.test(status), 'status sem 180 linhas: ' + status);
      const info = await valor("document.getElementById('logv-pager-info').textContent");
      assert2(/1\u2013100/.test(info), 'pager inesperado: ' + info);
    });

    await passa('detalhe aninhado virou coluna (achatamento de objeto)', async () => {
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('detalhe.codigo'), 'faltou detalhe.codigo: ' + JSON.stringify(chaves));
      assert2(chaves.includes('detalhe.tentativas'), 'faltou detalhe.tentativas');
    });

    await passa('pesquisa global filtra para 30 linhas', async () => {
      await valor(
        "var b = document.getElementById('logv-search'); b.value = 'erro'; b.dispatchEvent(new Event('input', {bubbles:true}));"
      );
      await espera(
        "document.getElementById('logv-status').textContent.indexOf('filtradas: 30') >= 0",
        4000, 'status com filtradas: 30'
      );
      await valor(
        "var b = document.getElementById('logv-search'); b.value = ''; b.dispatchEvent(new Event('input', {bubbles:true}));"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('180 linhas') >= 0", 4000, 'pesquisa zerada');
    });

    await passa('ordenação cicla asc→desc→sem', async () => {
      await valor("document.querySelector('#logv-thead [data-sort=\"tempo_ms\"]').click()");
      await espera("document.querySelector('#logv-thead .logv-sort') && document.querySelector('#logv-thead .logv-sort').textContent === '▲'", 4000, 'seta asc');
      await valor("document.querySelector('#logv-thead [data-sort=\"tempo_ms\"]').click()");
      await espera("(document.querySelector('#logv-thead .logv-sort')||{}).textContent === '▼'", 4000, 'seta desc');
      await valor("document.querySelector('#logv-thead [data-sort=\"tempo_ms\"]').click()");
      await espera("!document.querySelector('#logv-thead .logv-sort')", 4000, 'sem ordenação');
    });

    await passa('ordenar por tempo de fato reordena', async () => {
      await valor("document.querySelector('#logv-thead [data-sort=\"tempo_ms\"]').click()");
      await espera("!!document.querySelector('#logv-thead th.is-sorted')", 4000, 'coluna marcada');
      const tempos = await valor(
        "Array.from(document.querySelectorAll('#logv-tbody tr td:nth-child(6)')).map(function(t){ return t.textContent; });"
      );
      const numero = (s) => Number(s.replace(/\./g, '').replace(',', '.'));
      for (let i = 1; i < tempos.length; i++) {
        assert2(numero(tempos[i - 1]) <= numero(tempos[i]), 'asc não ordenou: posição ' + i);
      }
    });

    console.log('\n== filtro por coluna ==');

    await passa('menu de valores da coluna nivel', async () => {
      await valor("document.querySelector('#logv-thead [data-menu=\"nivel\"]').click()");
      await espera("!!document.querySelector('#logv-menu')", 4000, 'menu aberto');
      const itens = await valor("document.querySelectorAll('#logv-menu .logv-val-list input').length");
      assert2(itens === 4, 'esperava 4 níveis, veio ' + itens);
    });

    await passa('desmarcar info esconde 90 linhas', async () => {
      await valor(
        "var c = document.querySelector('#logv-menu .logv-val-list input[data-val=\"info\"]'); c.checked = false; c.dispatchEvent(new Event('change', {bubbles:true}));"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('filtradas: 90') >= 0", 4000, 'status 90');
      const botão = await valor("!!document.getElementById('logv-clear') && !document.getElementById('logv-clear').hidden");
      assert2(botão, 'botão limpar filtros não apareceu');
    });

    await passa('marcar todos devolve as 180', async () => {
      await valor("document.querySelector('#logv-menu [data-todos=\"1\"]').click()");
      await espera("document.getElementById('logv-status').textContent.indexOf('180 linhas') >= 0", 4000, 'status 180');
    });

    await passa('filtro numérico: tempo_ms maior que 3000', async () => {
      await valor(
        "document.querySelector('#logv-menu [data-fechar]').click();" +
        "document.querySelector('#logv-thead [data-menu=\"tempo_ms\"]').click();"
      );
      await espera("!!document.querySelector('#logv-menu')", 4000, 'menu do tempo_ms');
      await valor(
        "var s = document.querySelector('#logv-menu .logv-op'); s.value = 'maior'; s.dispatchEvent(new Event('change', {bubbles:true}));" +
        "var v = document.querySelector('#logv-menu .logv-valor'); v.value = '3000'; v.dispatchEvent(new Event('input', {bubbles:true}));" +
        "v.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('filtradas: 8') >= 0", 6000, 'status 8 (tempos acima de 3000)');
    });

    await passa('limpar filtros restaura a vista', async () => {
      await valor("document.getElementById('logv-clear').click()");
      await espera("document.getElementById('logv-status').textContent.indexOf('180 linhas') >= 0", 4000, 'status 180');
      await espera("!document.querySelector('#logv-menu')", 4000, 'menus fechados');
    });

    await passa('filtra ao clicar FORA do menu (sem Enter nem Aplicar)', async () => {
      await valor("document.querySelector('#logv-thead [data-menu=\"tempo_ms\"]').click()");
      await espera("!!document.querySelector('#logv-menu')", 4000, 'menu aberto');
      await valor(
        "var s = document.querySelector('#logv-menu .logv-op'); s.value = 'maior'; s.dispatchEvent(new Event('change', {bubbles:true}));" +
        "var v = document.querySelector('#logv-menu .logv-valor'); v.value = '3000'; v.dispatchEvent(new Event('input', {bubbles:true}));"
      );
      /* clique fora: nenhum dos refinamentos, direto no documento */
      await valor("document.body.click()");
      await espera(
        "document.getElementById('logv-status').textContent.indexOf('filtradas: 8') >= 0",
        6000, 'status filtradas: 8 (tempo_ms maior que 3000, sem Enter)'
      );
      await valor("document.getElementById('logv-clear').click()");
      await espera("document.getElementById('logv-status').textContent.indexOf('180 linhas') >= 0", 4000, 'filtro limpo');
    });

    await passa('colunas: esconder nivel sumiu do cabeçalho', async () => {
      await valor("document.getElementById('logv-columns-btn').click()");
      await espera("!document.querySelector('#logv-columns-pop').hidden", 4000, 'popover aberto');
      await valor(
        "var c = document.querySelector('#logv-columns-pop input[data-col-check=\"nivel\"]'); c.click();"
      );
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.indexOf('nivel') === -1, 'nivel ainda visível');
      const status = await valor("document.getElementById('logv-status').textContent");
      assert2(/11\/12 colunas/.test(status), 'contagem de colunas no status: ' + status);
      await valor("document.getElementById('logv-columns-pop').hidden = true");
    });

    console.log('\n== XLSX ==');

    await passa('upload de workbook de 2 abas lê a maior', async () => {
      const codigo =
        "var wb = XLSX.utils.book_new();" +
        "var a = XLSX.utils.aoa_to_sheet([['chave','valor'],['a',1],['b',0.5],['c',true]]);" +
        "XLSX.utils.book_append_sheet(wb, a, 'A');" +
        "var b = XLSX.utils.aoa_to_sheet([['s'],[true],[0]]);" +
        "XLSX.utils.book_append_sheet(wb, b, 'B');" +
        "var bytes = XLSX.write(wb, {type:'array', bookType:'xlsx'});" +
        "var arquivo = new File([bytes], 'tabela.xlsx');" +
        "var dt = new DataTransfer(); dt.items.add(arquivo);" +
        "document.getElementById('logv-input').files = dt.files;" +
        "document.getElementById('logv-input').dispatchEvent(new Event('change', {bubbles:true})); true";
      await valor(codigo, false);
      await espera(
        "document.getElementById('logv-status').textContent.indexOf('3 linhas') >= 0",
        8000, 'maior aba (3 linhas de dados)'
      );
      await espera(
        "!document.getElementById('logv-sheet').hidden && document.querySelectorAll('#logv-sheet option').length === 2",
        4000, 'seletor de abas com 2 opções'
      );
      const colunas = await valor("document.querySelectorAll('#logv-thead th').length");
      assert2(colunas === 2, 'esperava 2 colunas na aba A, veio ' + colunas);
    });

    await passa('troca de aba carrega a B (números lógicos)', async () => {
      await valor(
        "var s = document.getElementById('logv-sheet'); s.value = 'B'; s.dispatchEvent(new Event('change', {bubbles:true}));"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('2 linhas') >= 0", 8000, 'aba B com 2 linhas');
    });

    console.log('\n== colados ==');

    await passa('NDJSON colado vira tabela', async () => {
      await valor("document.getElementById('logv-paste-btn').click();");
      await espera("!document.getElementById('logv-modal').hidden", 4000, 'modal aberto');
      const bruto = '{"nivel":"info","msg":"ok","tempo_ms":12}\n{"nivel":"error","msg":"cá cedilha ã","tempo_ms":3000}';
      await valor(
        "var t = document.getElementById('logv-paste-text'); t.value = " + JSON.stringify(bruto) + ';' +
        "document.getElementById('logv-paste-load').click();"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('2 linhas') >= 0", 6000, '2 linhas NDJSON');
      const status = await valor("document.getElementById('logv-status').textContent");
      assert2(/3 colunas/.test(status), 'colunas do NDJSON: ' + status);
      const corpo = await valor("document.querySelector('#logv-tbody').textContent.includes('cá cedilha ã')");
      assert2(corpo, 'caracteres acentuados sumiram');
    });

    await passa('CSV colado (pt-BR com ponto e vírgula) vira tabela', async () => {
      await valor("document.getElementById('logv-paste-btn').click()");
      const bruto = 'nivel;msg;tempo_ms\ninfo;ok;12\nerro;falha;3.000';
      await valor(
        "document.getElementById('logv-paste-text').value = " + JSON.stringify(bruto) + ';' +
        "document.getElementById('logv-paste-load').click();"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('2 linhas') >= 0", 6000, '2 linhas CSV');
      const tempos = await valor(
        "Array.from(document.querySelectorAll('#logv-tbody tr td.is-numeric')).map(function(t){return t.textContent;});"
      );
      assert2(tempos.length === 2, 'coluna numérica deve ser reconhecida: ' + JSON.stringify(tempos));
    });

    console.log('\n== logs de linha (IIS e pm2) ==');

    await passa('IIS colado: datahora mesclada e campos W3C', async () => {
      await valor("document.getElementById('logv-paste-btn').click()");
      await espera("!document.getElementById('logv-modal').hidden", 4000, 'modal aberto');
      const bruto = [
        '#Software: Microsoft Internet Information Services 10.0',
        '#Version: 1.0',
        '#Date: 2026-10-20 00:05:47',
        '#Fields: date time s-ip cs-method cs-uri-stem s-port c-ip sc-status',
        '2026-10-20 00:05:47 10.10.10.70 POST /boleto/pdf 443 201.91.149.26 200',
        '#Date: 2026-10-20 01:55:39',
        '#Fields: date time s-ip cs-method cs-uri-stem s-port c-ip sc-status',
        '2026-10-20 01:55:39 10.10.10.70 GET /.git/config 443 193.32.162.164 404',
      ].join('\n');
      await valor(
        "document.getElementById('logv-paste-text').value = " + JSON.stringify(bruto) + ';' +
        "document.getElementById('logv-paste-load').click();"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('2 linhas') >= 0", 6000, '2 linhas IIS');
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('datahora'), 'faltou datahora: ' + JSON.stringify(chaves));
      assert2(chaves.includes('cs-method') && chaves.includes('sc-status'), 'campos W3C sumiram: ' + JSON.stringify(chaves));
      assert2(!chaves.includes('date') && !chaves.includes('time'), 'date/time soltos ficaram: ' + JSON.stringify(chaves));
      const corpo = await valor("document.querySelector('#logv-tbody').textContent.includes('/boleto/pdf')");
      assert2(corpo, 'dado do IIS não entrou na tabela');
    });

    await passa('pm2/Nest colado: ANSI fora, módulo, delta e SQL gravado no anterior', async () => {
      await valor("document.getElementById('logv-paste-btn').click()");
      const frag =
        "var E = String.fromCharCode(27);" +
        "return (" +
        "E+'[32m[Nest] 22796   - '+E+'[39m16/10/2026, 14:39:57   '+E+'[38;5;3m[MessagesWorkerService] '+E+'[39m'+E+'[32mFound 0 pending messages'+E+'[39m' + '\\n' +" +
        "'Executing (default): SELECT [Id] FROM [OutboxNotification]' + '\\n' +" +
        "E+'[32m[Nest] 22796   - '+E+'[39m16/10/2026, 14:39:58   '+E+'[38;5;3m[InstanceLoader] '+E+'[39m'+E+'[32mSequelizeModule dependencies initialized '+E+'[38;5;3m+2563ms'+E+'[39m');";
      await valor(
        "document.getElementById('logv-paste-text').value = (function(){ " + frag + " })();" +
        "document.getElementById('logv-paste-load').click();"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('2 linhas') >= 0", 6000, '2 linhas pm2 (SQL gruda no anterior)');
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('origem') && chaves.includes('pid'), 'colunas pm2 ausentes: ' + JSON.stringify(chaves));
      assert2(chaves.includes('datahora') && chaves.includes('modulo') && chaves.includes('sql'), 'colunas pm2 ausentes: ' + JSON.stringify(chaves));
      assert2(chaves.includes('delta_ms'), 'faltou delta_ms: ' + JSON.stringify(chaves));
      const corpo = await valor("document.querySelector('#logv-tbody').textContent");
      assert2(corpo.includes('SELECT [Id] FROM [OutboxNotification]'), 'SQL não aparece na linha anterior');
      assert2(corpo.includes('SequelizeModule dependencies initialized') && !corpo.includes('+2563ms'), 'delta ficou na mensagem');
      assert2(!corpo.includes(String.fromCharCode(27)), 'escape ANSI vazou para a tabela');
    });

    await passa('nginx/docker colado: combined partido, stream e time do Docker', async () => {
      await valor("document.getElementById('logv-paste-btn').click()");
      const bruto = [
        '{"log":"192.168.112.1 - - [16/Oct/2026:19:43:38 +0000] \\"GET /versao.json HTTP/1.1\\" 200 21 \\"-\\" \\"axios/0.19.2\\" \\"-\\"\\n","stream":"stdout","time":"2026-10-16T19:43:38.515002172Z"}',
        '{"log":"10.0.8.4 - - [17/Oct/2026:08:00:01 +0000] \\"POST /backend/api HTTP/1.1\\" 500 12 \\"-\\" \\"bot\\" \\"-\\"\\n","stream":"stdout","time":"2026-10-17T08:00:01.100000000Z"}',
        '{"log":"2026/10/19 14:14:39 [warn] 34#34: an upstream response is buffered while reading upstream, client: 10.0.8.4, server: frontend\\n","stream":"stderr","time":"2026-10-19T14:14:40.000000000Z"}',
      ].join('\n');
      await valor(
        "document.getElementById('logv-paste-text').value = " + JSON.stringify(bruto) + ';' +
        "document.getElementById('logv-paste-load').click();"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('3 linhas') >= 0", 6000, '3 linhas nginx');
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('ip') && chaves.includes('rota') && chaves.includes('metodo'), 'colunas de acesso ausentes: ' + JSON.stringify(chaves));
      assert2(chaves.includes('status') && chaves.includes('user_agent'), 'colunas de acesso ausentes: ' + JSON.stringify(chaves));
      assert2(chaves.includes('stream') && chaves.includes('time'), 'colunas do Docker ausentes: ' + JSON.stringify(chaves));
      assert2(chaves.includes('severidade') && chaves.includes('servidor'), 'colunas do erro não sairam: ' + JSON.stringify(chaves));
      const corpo = await valor("document.querySelector('#logv-tbody').textContent");
      assert2(corpo.includes('/versao.json') && corpo.includes('axios/0.19.2'), 'acesso não veio: ' + corpo.slice(0, 200));
      assert2(corpo.includes('warn') && corpo.includes('stderr'), 'erro do stderr não veio');
      assert2(!corpo.includes('{"log"'), 'embrulho do Docker vazou na tabela');
    });

    console.log('\n== arquivos reais (logs-exemplo) ==');

    /* Anexa um arquivo de verdade ao input, como um usuário faria. */
    const anexar = async (caminhoAbs) => {
      const { root } = await rpc('DOM.getDocument', {});
      const alvo = await rpc('DOM.querySelector', { nodeId: root.nodeId, selector: '#logv-input' });
      await rpc('DOM.setFileInputFiles', { files: [caminhoAbs], nodeId: alvo.nodeId });
    };

    await passa('IIS real carregado diretamente no input', async () => {
      await anexar(path.join(ROOT_EXEMPLO, 'u_ex261020.log'));
      await espera("document.querySelector('#logv-chrome').hidden === false", 20000, 'painel com o IIS real');
      const status = await valor("document.getElementById('logv-status').textContent");
      const n = Number(status.replace(/\D/g, ''));
      assert2(n > 10000, 'poucas linhas do IIS: ' + status);
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('datahora') && chaves.includes('cs-method') && chaves.includes('s-port'), 'colunas IIS erradas: ' + JSON.stringify(chaves));
      const corpo = await valor("document.querySelector('#logv-tbody').textContent");
      assert2(corpo.includes('443') || corpo.includes('.git'), 'célula do IIS fora: ' + corpo.slice(0, 200));
    });

    await passa('pm2 real (44 MB) parseia na página', async () => {
      await anexar(path.join(ROOT_EXEMPLO, 'homologawebdeskworker-out-26.log'));
      await espera("document.getElementById('logv-tbody').textContent.indexOf('Nest') >= 0", 60000, 'tabela com o pm2 real');
      const status = await valor("document.getElementById('logv-status').textContent");
      const n = Number(status.replace(/\D/g, ''));
      assert2(n > 40000, 'poucos registros do pm2: ' + status);
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('origem') && chaves.includes('datahora') && chaves.includes('sql'), 'colunas pm2 erradas: ' + JSON.stringify(chaves));
    });

    await passa('nginx real (docker JSON) carregado diretamente no input', async () => {
      await anexar(path.join(ROOT_EXEMPLO, 'nginx.log'));
      await espera("document.getElementById('logv-tbody').textContent.indexOf('HTTP') >= 0", 60000, 'tabela com o nginx real');
      const status = await valor("document.getElementById('logv-status').textContent");
      const n = Number(status.replace(/\D/g, ''));
      assert2(n >= 36499, 'registros do nginx: ' + status);
      const chaves = await valor("Array.from(document.querySelectorAll('#logv-thead th')).map(function(t){return t.getAttribute('data-key');})");
      assert2(chaves.includes('ip') && chaves.includes('rota') && chaves.includes('stream'), 'colunas nginx erradas: ' + JSON.stringify(chaves));
      /* filtro por severidade says [warn] existe */
      await valor("var b = document.getElementById('logv-search'); b.value = 'warn'; b.dispatchEvent(new Event('input', {bubbles:true}));");
      await espera("document.getElementById('logv-status').textContent.indexOf('filtradas: 15') >= 0", 10000, '15 linhas filtradas com warn');
      await valor("var b = document.getElementById('logv-search'); b.value = ''; b.dispatchEvent(new Event('input', {bubbles:true}));");
    });

    console.log('\n== exportação ==');

    await passa('exemplo recarregado para as checagens de export', async () => {
      await valor("document.getElementById('logv-sample-btn').click()");
      await espera("document.getElementById('logv-status').textContent.indexOf('180 linhas') >= 0", 6000, '180 linhas de volta');
    });

    await passa('export CSV captura blob com BOM e cabeçalho', async () => {
      const codigo =
        "window.__blobCapturado = null;" +
        "var cr = URL.createObjectURL.bind(URL);" +
        "URL.createObjectURL = function(blob){ window.__blobCapturado = blob; return 'blob:x'; };" +
        "document.getElementById('logv-export-btn').click();" +
        "document.querySelector('#logv-export-pop [data-export=\"csv\"]').click();" +
        "true";
      await valor(codigo, false);
      await espera(
        "document.getElementById('toast').textContent.indexOf('CSV exportado') >= 0",
        6000, 'toast de exportação'
      );
      const conteudo = await valor(
        "(async function(){ var b = new Uint8Array(await window.__blobCapturado.arrayBuffer()); " +
        "var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; })()",
        true
      );
      const primeiroTrio = [
        conteudo.charCodeAt(0), conteudo.charCodeAt(1), conteudo.charCodeAt(2),
      ];
      assert2(primeiroTrio[0] === 239 && primeiroTrio[1] === 187 && primeiroTrio[2] === 191, 'sem BOM UTF-8 (bytes: ' + primeiroTrio.join(',') + ')');
      const cab = conteudo.slice(0, 160);
      assert2(cab.includes('nivel') && cab.includes('tempo_ms'), 'cabeçalho CSV errado: ' + JSON.stringify(cab.slice(0, 100)));
      assert2(conteudo.includes('erro') && conteudo.length > 2000, 'valores do exemplo não saíram (tamanho: ' + conteudo.length + ')');
    });

    await passa('legenda do export reflete filtros', async () => {
      await valor(
        "var b = document.getElementById('logv-search'); b.value = 'info'; b.dispatchEvent(new Event('input', {bubbles:true}));"
      );
      await espera("document.getElementById('logv-status').textContent.indexOf('filtradas') >= 0", 4000, 'filtro aplicado');
      await valor(
        "document.getElementById('logv-export-btn').click();" +
        "document.querySelector('#logv-export-pop [data-export=\"csv\"]').click(); true"
      );
      await espera(
        "document.getElementById('toast').textContent.indexOf('registros filtrados') >= 0",
        6000, 'toast filtrado'
      );
      await valor(
        "var b = document.getElementById('logv-search'); b.value = ''; b.dispatchEvent(new Event('input', {bubbles:true}));"
      );
    });

    console.log('');
    if (falhas.length) {
      console.log('  ' + falhas.length + ' falha(s): ' + falhas.join(', '));
      process.exitCode = 1;
    } else {
      console.log('  tudo verde (' + pass + ' checagens)');
    }
  } finally {
    try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (err) { /* já saiu */ }
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (err) { /* tmp limpa */ }
  }
})();

function assert2(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem || 'assert sem mensagem');
}
