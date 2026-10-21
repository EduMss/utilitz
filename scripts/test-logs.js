'use strict';
/**
 * Testes HTTP da tela de logs (/logs) e do bundle vendido do SheetJS.
 * Uso: node scripts/test-logs.js   (exige o servidor rodando em :3000)
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

(async () => {
  console.log('\n== logs ==');

  await check('página de logs responde 200', async () => {
    const r = await fetch(BASE + '/logs');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(/Visualizador de logs|Seus <span class="grad">logs<\/span>/.test(t), 'título ausente');
  });

  await check('página carrega o bundle do SheetJS antes do script próprio', async () => {
    const t = await (await fetch(BASE + '/logs')).text();
    const vend = t.indexOf('src="/vendor/xlsx.min.js');
    const prop = t.indexOf('src="/js/logs.js');
    assert.ok(vend >= 0, 'vendor do xlsx ausente');
    assert.ok(prop >= 0, 'script de logs ausente');
    assert.ok(vend < prop, 'o SheetJS precisa entrar antes do logs.js');
  });

  await check('bundle do SheetJS presente e completo', async () => {
    const r = await fetch(BASE + '/vendor/xlsx.min.js');
    assert.strictEqual(r.status, 200);
    const t = await r.text();
    assert.ok(t.length > 400000, 'bundle curto demais: ' + t.length);
    assert.ok(/SheetJS/.test(t), 'assinatura do SheetJS ausente');
  });

  await check('navegação tem o item Logs em destaque', async () => {
    const t = await (await fetch(BASE + '/logs')).text();
    assert.ok(/<a class="nav-link is-active" href="\/logs">Logs<\/a>/.test(t), 'link ativo ausente na navegação');
  });

  await check('home aponta para /logs', async () => {
    const t = await (await fetch(BASE + '/')).text();
    assert.ok(t.includes('href="/logs"'), 'link /logs ausente na home');
  });

  await check('tabela tem armação para cabeçalho e corpo', async () => {
    const t = await (await fetch(BASE + '/logs')).text();
    assert.ok(t.includes('id="logv-thead"'), 'thead ausente');
    assert.ok(t.includes('id="logv-tbody"'), 'tbody ausente');
    assert.ok(t.includes('id="logv-search"'), 'pesquisa ausente');
    assert.ok(t.includes('id="logv-export-pop"'), 'menu de exportação ausente');
  });

  await check('404 da navegação não engole o /logs', async () => {
    const r = await fetch(BASE + '/logsz');
    assert.strictEqual(r.status, 404);
  });

  console.log('');
  if (failures.length) {
    console.log('  ' + failures.length + ' falha(s): ' + failures.join(', '));
    process.exitCode = 1;
  } else {
    console.log('  ' + pass + ' ok');
  }
})();
