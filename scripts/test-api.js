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

  console.log('\n' + pass + ' passaram, ' + failures.length + ' falharam\n');
  process.exit(failures.length ? 1 : 0);
})();