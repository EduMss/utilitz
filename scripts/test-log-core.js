'use strict';
/**
 * Testes unitários do núcleo de logs de linha (public/js/log-core.js), incluindo
 * os arquivos reais em logs-exemplo/: IIS (u_ex261020.log) e pm2/Nest
 * (homologawebdeskworker-out-26.log).
 * Uso: node scripts/test-log-core.js
 */

const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');

const { limparAnsi, isTextoLinhasLog, parsearLinhasLog } = require('../public/js/log-core.js');

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

const EXEMPLOS = path.join(__dirname, '..', 'logs-exemplo');

(async () => {
  console.log('\n== núcleo de logs (log-core) ==');

  await check('limpa ANSI da linha do Nest', async () => {
    const sujo = '\u001B[32m[Nest] 22796   - \u001B[39m14:39:54 \u001B[38;5;3m[NestFactory]\u001B[39m';
    assert.strictEqual(
      limparAnsi(sujo),
      '[Nest] 22796   - 14:39:54 [NestFactory]'
    );
  });

  await check('detecta IIS, pm2 e NÃO marca CSV/JSON comum', async () => {
    assert.ok(isTextoLinhasLog('#Software: Microsoft Internet Information Services 10.0\n#Fields: date time\n'));
    assert.ok(isTextoLinhasLog('\u001B[32m[Nest] pm2 - 16/10/2026, 14:39:54\n'));
    assert.ok(isTextoLinhasLog('Executing (default): SELECT 1\n'));
    assert.ok(!isTextoLinhasLog('nivel,msg,tempo_ms\ninfo,ok,12\n'));
    assert.ok(!isTextoLinhasLog('{"nivel":"info"}\n'));
  });

  await check('IIS: cabeçalhos repetidos, datahora mesclada, "-" vira vazio', async () => {
    const texto = [
      '#Software: Microsoft Internet Information Services 10.0',
      '#Version: 1.0',
      '#Date: 2026-10-20 00:05:47',
      '#Fields: date time s-ip cs-method sc-status time-taken',
      '2026-10-20 00:05:47 10.10.10.70 POST 200 1642',
      '#Software: Microsoft Internet Information Services 10.0',
      '#Fields: date time c-ip cs-uri-stem sc-status',
      '2026-10-20 01:55:39 193.32.162.164 /.git/config 404',
    ].join('\n');
    const linhas = parsearLinhasLog(texto);
    assert.strictEqual(linhas.length, 2, 'número de registros: ' + linhas.length);
    assert.ok(linhas[0].datahora instanceof Date, 'datahora não é Date');
    assert.strictEqual(linhas[0].datahora.getHours(), 0);
    assert.strictEqual(linhas[0]['cs-method'], 'POST');
    assert.strictEqual(linhas[0]['sc-status'], '200');
    assert.strictEqual(linhas[0].date, undefined, 'date solto não devia existir');
    assert.strictEqual(linhas[0].time, undefined, 'time solto não devia existir');
    assert.ok(!linhas[1]['cs-method'], 'novo segmento não pode herdar campo antigo');
    assert.strictEqual(linhas[1]['c-ip'], '193.32.162.164');
  });

  await check('pm2/Nest: ANSI, módulo, delta e SQL colado no anterior', async () => {
    const texto = [
      '\u001B[32m[Nest] 22796   - \u001B[39m16/10/2026, 14:39:57   \u001B[38;5;3m[InstanceLoader] \u001B[39m\u001B[32mSequelizeModule dependencies initialized\u001B[39m\u001B[38;5;3m \u001B[38;5;3m+2563ms\u001B[39m',
      '\u001B[32m[Nest] 22796   - \u001B[39m16/10/2026, 14:39:57   \u001B[38;5;3m[MessagesWorkerService] \u001B[39m\u001B[32mFound 0 pending messages\u001B[39m',
      'Executing (default): SELECT [Id] FROM [Outbox]',
    ].join('\n');
    const linhas = parsearLinhasLog(texto);
    assert.strictEqual(linhas.length, 2, 'SQL deve grudar no anterior: ' + linhas.length);
    const primeiro = linhas[0];
    assert.strictEqual(primeiro.origem, 'Nest');
    assert.strictEqual(primeiro.pid, 22796);
    assert.ok(primeiro.datahora instanceof Date);
    assert.strictEqual(primeiro.datahora.getHours(), 14);
    assert.strictEqual(primeiro.modulo, 'InstanceLoader');
    assert.strictEqual(primeiro.mensagem, 'SequelizeModule dependencies initialized');
    assert.strictEqual(primeiro.delta_ms, 2563);
    const segundo = linhas[1];
    assert.strictEqual(segundo.modulo, 'MessagesWorkerService');
    assert.strictEqual(segundo.sql, 'SELECT [Id] FROM [Outbox]');
  });

  await check('carimbo sozinho e rastro de pilha', async () => {
    const texto = [
      '2026-10-20T13:37:12.410Z aplicação parada',
      '2026-10-20 13:37:14 outra mensagem',
      'TypeError: falhou',
      '    at handler (index.js:40:11)',
    ].join('\n');
    const linhas = parsearLinhasLog(texto);
    assert.strictEqual(linhas.length, 2, 'rastro deve grudar: ' + linhas.length);
    assert.strictEqual(linhas[0].mensagem, 'aplicação parada');
    assert.strictEqual(linhas[1].mensagem, 'outra mensagem\nTypeError: falhou\n    at handler (index.js:40:11)');
  });

  await check('pendente: SQL sem anterior vira registro próprio', async () => {
    const linhas = parsearLinhasLog('Executing (default): SELECT 1 FROM x');
    assert.strictEqual(linhas.length, 1);
    assert.strictEqual(linhas[0].sql, 'SELECT 1 FROM x');
  });

  await check('nginx acesso combined: pedido partido e fuso descontado', async () => {
    const linhas = parsearLinhasLog(
      '192.168.112.1 - joao [16/Oct/2026:19:43:38 +0000] "GET /versao.json HTTP/1.1" 200 21 "-" "axios/0.19.2" "-"'
    );
    assert.strictEqual(linhas.length, 1);
    const r = linhas[0];
    assert.strictEqual(r.ip, '192.168.112.1');
    assert.strictEqual(r.usuario, 'joao');
    assert.ok(r.datahora instanceof Date, 'datahora não é Date');
    assert.strictEqual(r.datahora.toISOString(), '2026-10-16T19:43:38.000Z');
    assert.strictEqual(r.metodo, 'GET');
    assert.strictEqual(r.rota, '/versao.json');
    assert.strictEqual(r.protocolo, 'HTTP/1.1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.bytes, 21);
    assert.strictEqual(r.user_agent, 'axios/0.19.2');
    assert.strictEqual(r.referer, undefined, 'referer "-" devia vir vazio');
    assert.strictEqual(r.ident, undefined);
  });

  await check('nginx erro do stderr: severidade, worker e kv pares', async () => {
    const linhas = parsearLinhasLog(
      '2026/10/19 14:14:39 [warn] 34#34: *80662 an upstream response is buffered to a temporary file while reading upstream, client: 10.0.8.4, server: frontend, request: "POST /backend/api HTTP/1.1", upstream: "http://up:8080/x"'
    );
    assert.strictEqual(linhas.length, 1);
    const r = linhas[0];
    assert.strictEqual(r.severidade, 'warn');
    assert.strictEqual(r.pid, 34);
    assert.strictEqual(r.tid, 34);
    assert.strictEqual(r.conexao, 80662);
    assert.ok(r.datahora instanceof Date);
    assert.strictEqual(r.datahora.getHours(), 14);
    assert.strictEqual(r.ip, '10.0.8.4');
    assert.strictEqual(r.servidor, 'frontend');
    assert.strictEqual(r.metodo, 'POST');
    assert.strictEqual(r.rota, '/backend/api');
    assert.strictEqual(r.protocolo, 'HTTP/1.1');
    assert.ok(r.mensagem.startsWith('an upstream'), 'mensagem errada: ' + r.mensagem.slice(0, 40));
  });

  await check('docker: log de dentro vira linha e stream/time vão pro registro', async () => {
    const texto =
      '{"log":"192.168.112.1 - - [16/Oct/2026:19:43:38 +0000] \\"GET /versao.json HTTP/1.1\\" 200 21 \\"-\\" \\"axios/0.19.2\\" \\"-\\"\\n","stream":"stdout","time":"2026-10-16T19:43:38.515002172Z"}\n' +
      '{"log":"2026/10/19 14:14:39 [warn] 34#34: an upstream response is buffered while reading upstream, client: 10.0.8.4, server: frontend\\n","stream":"stderr","time":"2026-10-19T14:14:40.000000000Z"}\n';
    const linhas = parsearLinhasLog(texto);
    assert.strictEqual(linhas.length, 2, 'registros: ' + linhas.length);
    assert.strictEqual(linhas[0].ip, '192.168.112.1');
    assert.strictEqual(linhas[0].stream, 'stdout');
    assert.ok(linhas[0].time instanceof Date, 'time não é Date');
    assert.strictEqual(linhas[0].time.toISOString(), '2026-10-16T19:43:38.515Z');
    assert.strictEqual(linhas[1].stream, 'stderr');
    assert.strictEqual(linhas[1].severidade, 'warn');
    assert.ok(!('log' in linhas[0]), 'coluna perigosa "log" apareceu');
  });

  await check('docker NÃO engole JSON comum de ndjson', async () => {
    const linhas = parsearLinhasLog('{"msg":"oi"}\n{"msg":"tchau"}');
    assert.strictEqual(linhas.length, 2, 'cada JSON próprio é um registro: ' + linhas.length);
    assert.strictEqual(linhas[0].mensagem, '{"msg":"oi"}');
    assert.strictEqual(linhas[1].mensagem, '{"msg":"tchau"}');
  });

  console.log('\n== arquivos reais (logs-exemplo) ==');

  await check('IIS real: campos e tipos do u_ex261020.log', async () => {
    const texto = fs.readFileSync(path.join(EXEMPLOS, 'u_ex261020.log'), 'utf8');
    const linhas = parsearLinhasLog(texto);
    assert.ok(linhas.length > 100, 'poucas linhas: ' + linhas.length);
    const primeira = linhas[0];
    assert.ok(primeira.datahora instanceof Date, 'datahora ausente');
    assert.strictEqual(primeira['cs-method'], 'POST');
    assert.strictEqual(primeira['sc-status'], '200');
    assert.ok(!('date' in primeira), 'date solto persistiu');
    assert.ok(linhas[0]['cs(User-Agent)'], 'campo com parênteses sumiu');
    assert.ok(linhas.every((l) => l.datahora instanceof Date), 'registro sem datahora');
  });

  await check('pm2 real: 172 mil linhas viram registros com datahora e sql', async () => {
    const inicio = Date.now();
    const texto = fs.readFileSync(path.join(EXEMPLOS, 'homologawebdeskworker-out-26.log'), 'utf8');
    const t1 = Date.now();
    const linhas = parsearLinhasLog(texto);
    const t2 = Date.now();
    console.log('         (' + (t1 - inicio) + ' ms lendo, ' + (t2 - t1) + ' ms parseando, ' + linhas.length + ' registros)');
    assert.ok(linhas.length > 40000, 'poucos registros: ' + linhas.length);
    const comDatahora = linhas.filter((l) => l.datahora instanceof Date).length;
    const comSql = linhas.filter((l) => typeof l.sql === 'string').length;
    console.log('         (datahora: ' + comDatahora + ' · sql colados: ' + comSql + ')');
    assert.ok(comDatahora > 40000, 'registros sem datahora demais');
    assert.ok(comDatahora === linhas.length, 'todo registro Nest deve ter datahora');
    assert.ok(comSql > 10000, 'SQL não grudou');
    /* primeiro registro: começo do arquivo */
    assert.strictEqual(linhas[0].origem, 'Nest');
    /* nenhum registro pode ter escapado para "mensagem crua" */
    const crudos = linhas.filter((l) => !l.origem && !l.sql && !l.datahora);
    assert.ok(crudos.length <= linhas.length * 0.05, 'linhas cruas demais: ' + crudos.length);
  });

  await check('nginx real: docker JSON com acesso combined e erros no stderr', async () => {
    const inicio = Date.now();
    const texto = fs.readFileSync(path.join(EXEMPLOS, 'nginx.log'), 'utf8');
    const t1 = Date.now();
    const linhas = parsearLinhasLog(texto);
    const t2 = Date.now();
    console.log('         (' + (t1 - inicio) + ' ms lendo, ' + (t2 - t1) + ' ms parseando, ' + linhas.length + ' registros)');
    assert.strictEqual(linhas.length, 36499, 'total de registros: ' + linhas.length);
    const comDatahora = linhas.filter((l) => l.datahora instanceof Date).length;
    const comStream = linhas.filter((l) => typeof l.stream === 'string').length;
    const comRota = linhas.filter((l) => l.rota).length;
    const comStatus = linhas.filter((l) => typeof l.status === 'number').length;
    const comSeveridade = linhas.filter((l) => l.severidade).length;
    console.log('         (datahora: ' + comDatahora + ' · stream: ' + comStream + ' · rota: ' + comRota + ' · status: ' + comStatus + ' · severidade: ' + comSeveridade + ')');
    assert.strictEqual(comDatahora, 36499, 'todo registro precisa de datahora');
    assert.strictEqual(comStream, 36499, 'todo registro vem do docker');
    assert.strictEqual(comRota, 36499, 'pedidos (acesso + request dos erros): ' + comRota);
    assert.strictEqual(comStatus, 36484, 'acessos com status: ' + comStatus);
    assert.strictEqual(comSeveridade, 15, 'erros do stderr: ' + comSeveridade);
    /* miolo do arquivo: tudo acesso */
    const meio = linhas[Math.floor(linhas.length / 2)];
    assert.strictEqual(meio.stream, 'stdout');
    assert.ok(meio.rota, 'registro do meio sem rota');
    assert.ok(typeof meio.status === 'number', 'status não virou número');
    /* um erro do stderr tem pid */
    const comErro = linhas.find((l) => l.severidade === 'warn');
    assert.ok(comErro && comErro.pid === 34, 'erro sem pid: ' + JSON.stringify(comErro));
  });

  console.log('');
  if (failures.length) {
    console.log('  ' + failures.length + ' falha(s): ' + failures.join(', '));
    process.exitCode = 1;
  } else {
    console.log('  ' + pass + ' ok');
  }
})();
