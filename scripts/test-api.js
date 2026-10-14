'use strict';
/**
 * Testes de ponta a ponta da API. Sobe contra o servidor rodando em :3000.
 * Uso: node scripts/test-api.js
 */

const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n         ' + (err && err.message));
  }
}

function post(path, body) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const MD = '# Olá\n\nUm **texto** com `código`.\n\n## Seção\n\n- a\n- b\n';

(async () => {
  console.log('\n== páginas ==');

  await check('home responde 200', async () => {
    const r = await fetch(BASE + '/');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(/Markdown Studio/.test(t), 'título ausente');
  });

  await check('visualizador responde 200', async () => {
    const r = await fetch(BASE + '/visualizar');
    assert.strictEqual(r.status, 200);
  });

  await check('página de PDF responde 200', async () => {
    const r = await fetch(BASE + '/pdf');
    assert.strictEqual(r.status, 200);
  });

  await check('página de formatar responde 200', async () => {
    const r = await fetch(BASE + '/formatar');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(/Formatar/.test(t), 'título ausente');
    // sem o bundle do highlight.js a prévia sai sem cor nenhuma
    assert.ok(t.includes('src="/vendor/hljs.js'), 'formatar sem o bundle do highlight.js');
  });

  // Regressão: as ferramentas usam classes que vivem no app.css. Se ele deixar
  // de ser carregado, as páginas funcionam mas aparecem sem estilo nenhum.
  await check('todas as páginas carregam os três CSS', async () => {
    for (const url of ['/', '/visualizar', '/pdf', '/formatar']) {
      const html = await (await fetch(BASE + url)).text();
      for (const css of ['/css/base.css', '/css/markdown.css', '/css/app.css']) {
        // o href pode trazer ?v=<mtime>, por isso o prefixo
        assert.ok(html.includes('href="' + css), url + ' sem ' + css);
      }
    }
  });

  await check('ferramentas carregam common.js antes do seu script', async () => {
    for (const [url, script] of [
      ['/visualizar', '/js/viewer.js'],
      ['/pdf', '/js/pdf.js'],
      ['/formatar', '/js/format.js'],
    ]) {
      const html = await (await fetch(BASE + url)).text();
      const common = html.indexOf('src="/js/common.js');
      const own = html.indexOf('src="' + script);
      assert.ok(common !== -1, url + ' sem common.js');
      assert.ok(own !== -1, url + ' sem ' + script);
      assert.ok(common < own, url + ': common.js precisa vir antes de ' + script);
      assert.ok(html.includes('src="/js/shared-settings.js'), url + ' sem shared-settings.js');
    }
  });

  // Regressão: sem carimbo de versão o navegador segura o js/css antigo por uma
  // hora, e a pessoa recebe o HTML novo com o script velho — botões novos
  // simplesmente não respondem.
  await check('os assets levam carimbo de versão', async () => {
    const html = await (await fetch(BASE + '/visualizar')).text();
    for (const asset of ['/css/app.css', '/js/common.js', '/js/viewer.js']) {
      const m = new RegExp('(href|src)="' + asset + '\\?v=\\d+"').exec(html);
      assert.ok(m, 'sem ?v= em ' + asset + ' (cache velho vai sobrar)');
    }
  });

  await check('assets não são servidos com cache longo', async () => {
    for (const asset of ['/js/viewer.js', '/css/app.css']) {
      const res = await fetch(BASE + asset);
      const cache = res.headers.get('cache-control') || '';
      assert.ok(!/max-age=[1-9]/.test(cache), asset + ' com ' + cache);
    }
  });

  await check('as páginas não são cacheadas', async () => {
    for (const url of ['/', '/visualizar', '/pdf', '/formatar']) {
      const cache = (await fetch(BASE + url)).headers.get('cache-control') || '';
      assert.ok(/no-cache|no-store/.test(cache), url + ' com cache "' + cache + '"');
    }
  });

  await check('elementos que o JS usa existem na página', async () => {
    const viewer = await (await fetch(BASE + '/visualizar')).text();
    for (const id of ['stage', 'doc', 'source', 'drawer', 'toolbar', 'outline-list', 'toast', 'file-input']) {
      assert.ok(viewer.includes('id="' + id + '"'), 'visualizar sem #' + id);
    }
    const pdf = await (await fetch(BASE + '/pdf')).text();
    for (const id of ['source', 'preview-pages', 'settings', 'toast', 'file-input', 'btn-settings']) {
      assert.ok(pdf.includes('id="' + id + '"'), 'pdf sem #' + id);
    }
    const fmt = await (await fetch(BASE + '/formatar')).text();
    for (const id of ['fmt-type', 'fmt-input', 'fmt-preview', 'grp-text', 'grp-json', 'grp-csv',
      'opt-unescape', 'opt-one-line', 'opt-remove-escapes', 'fmt-copy', 'fmt-download', 'file-input', 'toast']) {
      assert.ok(fmt.includes('id="' + id + '"'), 'formatar sem #' + id);
    }
  });

  console.log('\n== estáticos ==');

  for (const asset of [
    '/css/base.css',
    '/css/markdown.css',
    '/css/app.css',
    '/js/common.js',
    '/js/shared-settings.js',
    '/js/home.js',
    '/js/viewer.js',
    '/js/pdf.js',
    '/js/format.js',
    '/js/format-core.js',
    '/vendor/paged.js',
    '/vendor/hljs.js',
  ]) {
    await check('serve ' + asset, async () => {
      const r = await fetch(BASE + asset);
      assert.strictEqual(r.status, 200, r.status + ' em ' + asset);
    });
  }

  console.log('\n== API ==');

  await check('GET /api/settings devolve defaults e presets', async () => {
    const r = await fetch(BASE + '/api/settings');
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    for (const k of ['defaults', 'presets', 'themes', 'pageSizes', 'fontFamilies', 'listStyles', 'positions']) {
      assert.ok(j[k] && Object.keys(j[k]).length, 'vazio: ' + k);
    }
  });

  await check('POST /api/render devolve html + headings + stats', async () => {
    const r = await post('/api/render', { markdown: MD });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(j.html.includes('<h1 id="ola">'), j.html);
    assert.ok(j.html.includes('<strong>texto</strong>'), j.html);
    assert.deepStrictEqual(j.headings.map((h) => h.id), ['ola', 'secao']);
    assert.ok(j.stats.words > 0);
  });

  await check('POST /api/render higieniza HTML perigoso', async () => {
    const r = await post('/api/render', {
      markdown: '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[z](javascript:alert(3))',
    });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(!/<\s*script/i.test(j.html), 'script no html');
    assert.ok(!/onerror/i.test(j.html), 'onerror no html');
  });

  await check('POST /api/render com corpo vazio não quebra', async () => {
    const r = await post('/api/render', {});
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.html, '');
    assert.deepStrictEqual(j.headings, []);
  });

  await check('POST /api/stats devolve contagens', async () => {
    const r = await post('/api/stats', { markdown: MD });
    const j = await r.json();
    assert.strictEqual(typeof j.words, 'number');
    assert.strictEqual(j.headings, 2);
  });

  await check('POST /api/pdf devolve PDF binário', async () => {
    const r = await post('/api/pdf', { markdown: MD, title: 'Teste de API' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
    assert.ok(/attachment; filename="teste-de-api\.pdf"/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
    assert.ok(buf.length > 800, 'pdf pequeno demais: ' + buf.length);
  });

  await check('POST /api/pdf com settings parciais não quebra', async () => {
    const r = await post('/api/pdf', { markdown: MD, settings: { fontSize: 11, unknown: 'x' } });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  });

  await check('POST /api/pdf inline abre no navegador', async () => {
    const r = await post('/api/pdf', { markdown: MD, inline: true });
    assert.ok(/^inline;/.test(r.headers.get('content-disposition')), r.headers.get('content-disposition'));
  });

  console.log('\n== fontes externas ==');

  await check('GET /api/fonts traz catálogo e instaladas', async () => {
    const j = await (await fetch(BASE + '/api/fonts')).json();
    assert.ok(Array.isArray(j.catalog) && j.catalog.length > 5, 'catálogo curto');
    assert.ok(Array.isArray(j.installed), 'installed não é lista');
    assert.ok(j.catalog.every((f) => f.family && f.kind), 'item de catálogo sem família ou gênero');
  });

  await check('POST /api/fonts sem endereço explica o motivo', async () => {
    const r = await post('/api/fonts', {});
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.ok(/Google Fonts/.test(j.error), j.error);
  });

  // Regressão: aceitar um endereço arbitrário transformaria a aplicação em um
  // downloader de qualquer URL apontando para a rede.
  await check('POST /api/fonts recusa host fora do Google', async () => {
    for (const url of [
      'https://evil.example/css2?family=Lora',
      'http://fonts.googleapis.com/css2?family=Lora',
      'https://fonts.gstatic.com/s/lora/x.ttf',
    ]) {
      const r = await post('/api/fonts', { url });
      const j = await r.json();
      assert.strictEqual(r.status, 400, 'aceitou ' + url);
      assert.ok(j && typeof j.error === 'string' && j.error.length > 10, 'sem mensagem em ' + url);
    }
  });

  await check('POST /api/fonts recusa família que o Google não tem', async () => {
    const r = await post('/api/fonts', { url: 'Zzqx Inventada 999' });
    assert.strictEqual(r.status, 400);
  });

  await check('/fonts não serve o índice nem sai da pasta', async () => {
    const indice = await fetch(BASE + '/fonts/index.json');
    assert.strictEqual(indice.status, 404, 'index.json está público');
    const fuga = await fetch(BASE + '/fonts/../biblioteca.json');
    assert.ok(fuga.status >= 400, 'aceitou traversal: ' + fuga.status);
  });

  let fonteBaixada = null;

  await check('POST /api/fonts baixa uma família com os quatro estilos', async () => {
    const r = await post('/api/fonts', { url: 'Lora' });
    const j = await r.json();
    assert.strictEqual(r.status, 201, 'status ' + r.status + ': ' + j.error);
    assert.strictEqual(j.key, 'gf:lora');
    assert.strictEqual(j.family, 'Lora');
    for (const estilo of ['normal', 'bold', 'italic', 'boldItalic']) {
      assert.ok(j.files[estilo], 'faltou ' + estilo);
      const arquivo = await fetch(BASE + '/fonts/' + j.files[estilo]);
      assert.strictEqual(arquivo.status, 200, estilo + ' não é servido');
      const buf = Buffer.from(await arquivo.arrayBuffer());
      assert.ok(buf.length > 10000, estilo + ' veio pequeno: ' + buf.length);
      // TTF ou OTF: começa com 0x00010000, "true" ou "OTTO"
      const assinatura = buf.toString('latin1', 0, 4);
      const ehFonte = assinatura === 'OTTO' || assinatura === 'true' ||
        (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0);
      assert.ok(ehFonte, estilo + ' não é um arquivo de fonte: ' + JSON.stringify(assinatura));
    }
    assert.ok(/@font-face/.test(j.faces), 'descritor sem @font-face');
    assert.ok(j.faces.includes('/fonts/'), 'faces sem o caminho servido');
    fonteBaixada = j;
  });

  await check('GET /api/fonts lista a família recém-baixada', async () => {
    const j = await (await fetch(BASE + '/api/fonts')).json();
    assert.ok(j.installed.some((f) => f.key === fonteBaixada.key), 'não apareceu na lista');
  });

  await check('POST /api/fonts completa as variações que faltam no link', async () => {
    // O link traz só 400 e 700; sem reescrever o pedido o PDF sairia sem
    // itálico. A resposta precisa ter as quatro.
    const r = await post('/api/fonts', { url: 'https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;700' });
    const j = await r.json();
    assert.strictEqual(r.status, 201, 'status ' + r.status + ': ' + j.error);
    for (const estilo of ['normal', 'bold', 'italic', 'boldItalic']) {
      assert.ok(j.files[estilo], 'faltou ' + estilo);
    }
  });

  await check('POST /api/pdf com fonte externa embute o arquivo da fonte', async () => {
    const r = await post('/api/pdf', {
      markdown: MD,
      settings: { fontFamily: 'gf:lora', pageNumbers: true },
    });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
    assert.ok(/\/FontFile2?\b/.test(buf.toString('latin1')), 'nenhuma fonte embutida no PDF');
  });

  await check('POST /api/pdf com chave de fonte inexistente não quebra', async () => {
    const r = await post('/api/pdf', {
      markdown: MD,
      settings: { fontFamily: 'gf:nao-existe-nenhuma' },
    });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  });

  await check('POST /api/pdf ignora chave de fonte mal formada', async () => {
    const r = await post('/api/pdf', {
      markdown: MD,
      settings: { fontFamily: 'serif; DROP TABLE', headingFontFamily: '../../etc/passwd' },
    });
    assert.strictEqual(r.status, 200);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  });

  console.log('\n== biblioteca ==');

  let savedId = null;

  await check('POST /api/library cria documento', async () => {
    const r = await post('/api/library', { title: 'Meu Doc', content: MD, kind: 'viewer' });
    assert.strictEqual(r.status, 201);
    const j = await r.json();
    assert.ok(j.id, 'sem id');
    assert.strictEqual(j.title, 'Meu Doc');
    assert.strictEqual(j.kind, 'viewer');
    savedId = j.id;
  });

  await check('GET /api/library lista resumido sem conteúdo', async () => {
    const r = await fetch(BASE + '/api/library');
    const j = await r.json();
    assert.ok(Array.isArray(j), 'não é lista');
    const found = j.find((d) => d.id === savedId);
    assert.ok(found, 'documento ausente na lista');
    assert.ok(found.content === undefined, 'a lista não deve trazer o conteúdo');
    assert.strictEqual(typeof found.words, 'number');
  });

  await check('GET /api/library/:id devolve o documento', async () => {
    const r = await fetch(BASE + '/api/library/' + savedId);
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.content, MD);
  });

  await check('POST /api/library aceita "markdown" como alias', async () => {
    const r = await post('/api/library', { title: 'Alias', markdown: '# curto' });
    assert.strictEqual(r.status, 201);
    const j = await r.json();
    const full = await (await fetch(BASE + '/api/library/' + j.id)).json();
    assert.strictEqual(full.content, '# curto');
    await fetch(BASE + '/api/library/' + j.id, { method: 'DELETE' });
  });

  await check('GET /api/library/:id inexistente dá 404', async () => {
    const r = await fetch(BASE + '/api/library/nao-existe-123');
    assert.strictEqual(r.status, 404);
  });

  await check('DELETE /api/library/:id remove', async () => {
    const r = await fetch(BASE + '/api/library/' + savedId, { method: 'DELETE' });
    assert.strictEqual(r.status, 200);
    const check2 = await fetch(BASE + '/api/library/' + savedId);
    assert.strictEqual(check2.status, 404);
  });

  await check('DELETE /api/library/:id inexistente dá 404', async () => {
    const r = await fetch(BASE + '/api/library/nao-existe-123', { method: 'DELETE' });
    assert.strictEqual(r.status, 404);
  });

  await check('rota inexistente devolve 404', async () => {
    const r = await fetch(BASE + '/api/nao-existe');
    assert.strictEqual(r.status, 404);
  });

  /* ---------------------------------------------------------- *
     Salas compartilhadas: notas + drive
     ---------------------------------------------------------- */
  console.log('\n== salas: notas ==');

  const dorme = (ms) => new Promise((res) => setTimeout(res, ms));
  let notaId = '';

  await check('/notas carrega com os elementos do editor', async () => {
    const r = await fetch(BASE + '/notas');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    for (const trecho of ['nt-criar-btn', 'nt-entrada-senha', 'id="nt-texto"', 'id="nt-sala"', '/js/salas.js', '/js/notas.js']) {
      assert.ok(t.includes(trecho), 'sem "' + trecho + '"');
    }
    assert.ok(!t.includes('undefined'), 'alguém interpolou indefinido no HTML');
  });

  await check('criar sala de notas e salvar texto', async () => {
    const criada = await (await post('/api/notas', {})).json();
    assert.ok(criada.id, 'sem id');
    assert.strictEqual(criada.privada, false);

    const salvo = await (
      await post('/api/notas/' + criada.id, { texto: 'primeira anotação' })
    ).json();
    assert.strictEqual(salvo.versao, 1);

    const estado = await (await fetch(BASE + '/api/notas/' + criada.id)).json();
    assert.strictEqual(estado.texto, 'primeira anotação');
    assert.strictEqual(typeof estado.online, 'number');
    notaId = criada.id;
  });

  await check('nota privada: 401 sem senha, 403 errada, 200 certa', async () => {
    const criada = await (await post('/api/notas', { senha: 'segredo' })).json();
    assert.strictEqual(criada.privada, true);

    const sem = await fetch(BASE + '/api/notas/' + criada.id);
    assert.strictEqual(sem.status, 401);
    const corpoSem = await sem.json();
    assert.strictEqual(corpoSem.precisaSenha, true);

    const errada = await fetch(BASE + '/api/notas/' + criada.id, { headers: { 'x-sala-senha': 'x' } });
    assert.strictEqual(errada.status, 403);

    const certa = await fetch(BASE + '/api/notas/' + criada.id, { headers: { 'x-sala-senha': 'segredo' } });
    assert.strictEqual(certa.status, 200);
  });

  await check('sala de notas inexistente dá 404', async () => {
    const r = await fetch(BASE + '/api/notas/naoexiste99');
    assert.strictEqual(r.status, 404);
  });

  await check('nota acima do limite de caracteres dá 413', async () => {
    const estado = await (await fetch(BASE + '/api/notas/' + notaId)).json();
    const r = await post('/api/notas/' + notaId, { texto: 'x'.repeat(estado.maxTexto + 1) });
    assert.strictEqual(r.status, 413);
  });

  await check('o canal de eventos entrega o estado na primeira mensagem', async () => {
    const ctrl = new AbortController();
    const r = await fetch(BASE + '/api/notas/' + notaId + '/eventos', { signal: ctrl.signal });
    assert.strictEqual(r.status, 200);
    assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'), 'content-type errado');

    const leitor = r.body.getReader();
    const primeira = await Promise.race([leitor.read(), dorme(2500).then(() => null)]);
    ctrl.abort();
    assert.ok(primeira && !primeira.done, 'sem primeira mensagem');
    const texto = Buffer.from(primeira.value).toString('utf8');
    assert.ok(texto.includes('event: '), 'mensagem sem evento: ' + JSON.stringify(texto.slice(0, 80)));
    assert.ok(texto.includes('"versao"'), 'estado sem versão');
  });

  await check('o estado traz o relógio do servidor junto do prazo', async () => {
    const estado = await (await fetch(BASE + '/api/notas/' + notaId)).json();
    assert.ok(Number.isFinite(estado.agora), 'sem relógio no estado');
    assert.ok(estado.expiraEm > estado.agora, 'prazo antes do agora');
  });

  await check('entrar na sala não renova o prazo (só edição reinicia)', async () => {
    const criada = await (await post('/api/notas', {})).json();
    const antes = await (await fetch(BASE + '/api/notas/' + criada.id)).json();

    /* Abre o canal (entrar na sala) e fecha na hora. */
    const ctrl = new AbortController();
    await fetch(BASE + '/api/notas/' + criada.id + '/eventos', { signal: ctrl.signal });
    ctrl.abort();

    const depois = await (await fetch(BASE + '/api/notas/' + criada.id)).json();
    assert.strictEqual(depois.expiraEm, antes.expiraEm, 'o prazo andou sem edição');

    /* Editar, sim, reinicia a contagem. */
    await post('/api/notas/' + criada.id, { texto: 'edição manda no relógio' });
    const editado = await (await fetch(BASE + '/api/notas/' + criada.id)).json();
    assert.ok(editado.expiraEm > depois.expiraEm, 'edição não renovou o prazo');
  });

  await check('o ping do canal reenvia o prazo do backend (evento relogio)', async () => {
    /* O relógio é do servidor: a cada volta do ping (25 s) ele reenvia o
       prazo atual para todas as abas — e o teste confere que o ping
       apenas REPETE o prazo, sem renová-lo: a renovação é só edição. */
    const antes = await (await fetch(BASE + '/api/notas/' + notaId)).json();
    const ctrl = new AbortController();
    const r = await fetch(BASE + '/api/notas/' + notaId + '/eventos', { signal: ctrl.signal });
    const leitor = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let achou = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 32000) {
      const { value, done } = await leitor.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const inicio = buf.indexOf('event: relogio');
      if (inicio < 0) continue;
      const fim = buf.indexOf('\n\n', inicio);
      if (fim < 0) continue;
      const bloco = buf.slice(inicio, fim);
      achou = JSON.parse(bloco.slice(bloco.indexOf('data: ') + 6));
      break;
    }
    ctrl.abort();
    assert.ok(achou, 'sem evento relogio em 32 s');
    assert.ok(Number.isFinite(achou.expiraEm), 'relogio sem prazo');
    assert.ok(Number.isFinite(achou.agora), 'relogio sem relógio');
    assert.ok(achou.expiraEm > achou.agora, 'prazo já vencido no relogio');
    assert.ok(typeof achou.online === 'number', 'relogio sem contador de gente');
    assert.strictEqual(achou.expiraEm, antes.expiraEm, 'o ping renovou o prazo sem edição');
  });

  console.log('\n== salas: drive ==');

  let driveId = '';
  let driveSenha = '';

  await check('/drive carrega com o dropzone', async () => {
    const r = await fetch(BASE + '/drive');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    for (const trecho of ['dv-criar-btn', 'id="dv-drop"', 'id="dv-input"', 'id="dv-lista"', '/js/drive.js']) {
      assert.ok(t.includes(trecho), 'sem "' + trecho + '"');
    }
  });

  await check('criar sala de drive expõe o limite por arquivo', async () => {
    driveSenha = 'xyz';
    const criada = await (await post('/api/drive', { senha: driveSenha })).json();
    assert.ok(criada.id, 'sem id');
    assert.strictEqual(criada.privada, true);
    assert.ok(criada.tamMaxBytes > 0, 'sem limite exposto');
    driveId = criada.id;
  });

  await check('upload em fluxo, lista e download byte a byte (com acento)', async () => {
    const conteudo = 'arquivo de teste com acentuação: ção';
    const nome = 'relatório nº 1.txt';
    const up = await fetch(BASE + '/api/drive/' + driveId + '/arquivos?nome=' + encodeURIComponent(nome), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-sala-senha': driveSenha },
      body: conteudo,
    });
    assert.strictEqual(up.status, 201);
    const { arquivo } = await up.json();
    assert.strictEqual(arquivo.nome, nome);
    assert.strictEqual(arquivo.tamanho, Buffer.byteLength(conteudo));

    const estado = await (await fetch(BASE + '/api/drive/' + driveId, { headers: { 'x-sala-senha': driveSenha } })).json();
    const naLista = estado.arquivos.find((a) => a.id === arquivo.id);
    assert.ok(naLista, 'arquivo fora da lista');

    const dl = await fetch(BASE + '/api/drive/' + driveId + '/arquivos/' + arquivo.id + '?senha=' + driveSenha);
    assert.strictEqual(dl.status, 200);
    const baixado = await dl.text();
    assert.strictEqual(baixado, conteudo, 'bytes diferentes no download');
    const disp = dl.headers.get('content-disposition') || '';
    assert.ok(disp.includes("filename*=UTF-8''"), 'sem filename UTF-8: ' + disp);
  });

  await check('drive privado: upload sem senha dá 401', async () => {
    const r = await fetch(BASE + '/api/drive/' + driveId + '/arquivos?nome=x.txt', { method: 'POST', body: 'oi' });
    assert.strictEqual(r.status, 401);
  });

  await check('download de arquivo morto dá 404', async () => {
    const r = await fetch(BASE + '/api/drive/' + driveId + '/arquivos/naoexiste99?senha=' + driveSenha);
    assert.strictEqual(r.status, 404);
  });

  await check('upload acima do limite anunciado dá 413', async () => {
    const estado = await (await fetch(BASE + '/api/drive/' + driveId, { headers: { 'x-sala-senha': driveSenha } })).json();
    if (estado.tamMaxBytes > 8 * 1024 * 1024) {
      console.log('         (limite de ' + estado.tamMaxBytes + ' bytes: teste de corpo pulado)');
      return;
    }
    const r = await fetch(BASE + '/api/drive/' + driveId + '/arquivos?nome=g.txt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-sala-senha': driveSenha },
      body: 'x'.repeat(estado.tamMaxBytes + 1024),
    });
    assert.strictEqual(r.status, 413);
  });

  console.log('\n' + pass + ' passaram, ' + failures.length + ' falharam\n');
  process.exit(failures.length ? 1 : 0);
})();