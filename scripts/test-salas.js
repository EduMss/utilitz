'use strict';

/**
 * Testes das salas temporárias: ciclo de vida, senha, upload e exclusão
 * adiada enquanto há download.
 *
 * Os prazos entram minúsculos (250 ms) e os relógios rodam de verdade: o
 * coração da feature é justamente quando as coisas somem.
 * Uso: node scripts/test-salas.js
 */

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { criarSalas, TIPOS } = require('../src/lib/salas');

const TTL = 250;
const dirRaiz = path.join(os.tmpdir(), 'md-test-salas-' + process.pid);

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

const dorme = (ms) => new Promise((res) => setTimeout(res, ms));

/** Salas de teste: prazos minúsculos e pasta própria descartável. */
function novo(opts) {
  return criarSalas(Object.assign({
    ttlNotaMs: TTL,
    ttlArquivoMs: TTL,
    tamMaxBytes: 50,
    ttlDownloadMs: 60000,
    maxSalas: 50,
    maxArquivos: 10,
    maxTexto: 100,
    dirBase: path.join(dirRaiz, 'drive-' + Math.random().toString(36).slice(2)),
  }, opts || {}));
}

function bytesDe(caminho) {
  return fs.readFileSync(caminho);
}

(async () => {
  console.log('\n== salas temporárias ==\n');

  const s = novo();

  await check('sala pública aceita qualquer senha', () => {
    const sala = s.criar(TIPOS.NOTAS);
    assert.strictEqual(s.autenticado(sala, ''), true);
    assert.strictEqual(s.autenticado(sala, 'qualquer'), true);
  });

  await check('sala privada só abre com a senha certa', () => {
    const sala = s.criar(TIPOS.NOTAS, 'segredo');
    assert.strictEqual(s.autenticado(sala, ''), false);
    assert.strictEqual(s.autenticado(sala, 'errada'), false);
    assert.strictEqual(s.autenticado(sala, 'segredo'), true);
  });

  await check('a senha fica guardada como hash, nunca em claro', () => {
    const sala = s.criar(TIPOS.NOTAS, 'segredo');
    assert.ok(sala.senhaHash, 'sem hash');
    assert.ok(!String(sala.senhaHash).includes('segredo'), 'senha em claro na memória');
  });

  await check('a nota guarda texto e versão, e avisa quem assiste', async () => {
    const sala = s.criar(TIPOS.NOTAS);
    const eventos = [];
    s.ouvir(sala, 'cliente-a', (ev) => eventos.push(ev));

    const salvo = s.escrever(sala, 'lista de compras');
    assert.strictEqual(salvo.versao, 1);
    assert.strictEqual(s.ler(sala).texto, 'lista de compras');

    s.escrever(sala, 'lista de compras + pão');
    assert.strictEqual(s.ler(sala).versao, 2);
    assert.ok(eventos.some((ev) => ev.tipo === 'texto' && ev.versao === 2), 'sem evento de texto');
  });

  await check('a sala de notas some depois do prazo sem atividade', async () => {
    const sala = s.criar(TIPOS.NOTAS);
    const id = sala.id;
    const encerradas = [];
    s.ouvir(sala, 'cliente-b', (ev) => encerradas.push(ev.tipo));

    await dorme(TTL * 1.6);
    assert.strictEqual(s.obter(TIPOS.NOTAS, id), null, 'sala deveria ter expirado');
    assert.ok(encerradas.includes('encerrada'), 'ouvinte não foi avisado do fim');
  });

  await check('editar reinicia a contagem da sala de notas', async () => {
    const sala = s.criar(TIPOS.NOTAS);
    const id = sala.id;

    await dorme(TTL / 2);
    s.escrever(sala, 'renova o prazo');
    await dorme(TTL * 0.6); /* já passaria do prazo original */
    assert.ok(s.obter(TIPOS.NOTAS, id), 'sala morreu mesmo com edição recente');

    await dorme(TTL * 1.6); /* e some quando a atividade para */
    assert.strictEqual(s.obter(TIPOS.NOTAS, id), null, 'sala não expirou depois de parar');
  });

  await check('o estado traz o relógio do servidor junto do prazo', () => {
    const sala = s.criar(TIPOS.NOTAS);
    const antes = Date.now();
    const estado = s.ler(sala);
    assert.ok(Number.isFinite(estado.agora), 'sem relógio no estado');
    assert.ok(estado.agora >= antes && estado.agora <= Date.now() + 5, 'relógio fora do intervalo');
    assert.ok(estado.expiraEm > estado.agora, 'prazo tem que vir depois do agora');
  });

  await check('quem assiste recebe prazo novo a cada renovação', async () => {
    const sala = s.criar(TIPOS.NOTAS);
    const eventos = [];
    s.ouvir(sala, 'cliente-relogio', (ev) => eventos.push(ev));

    const primeiro = s.ler(sala).expiraEm;
    await dorme(30);
    s.ativar(sala);
    s.escrever(sala, 'depois da batida'); /* o broadcast carrega o prazo renovado */

    const aviso = eventos.find((ev) => ev.tipo === 'texto');
    assert.ok(aviso, 'sem evento de texto');
    assert.ok(aviso.expiraEm > primeiro, 'evento com prazo antigo');
    assert.ok(Number.isFinite(aviso.agora), 'evento sem relógio do servidor');
  });

  await check('entrar e assistir não renova o prazo da sala', async () => {
    const sala = s.criar(TIPOS.NOTAS);
    const id = sala.id;
    const antes = sala.expiraEm;

    s.ouvir(sala, 'cliente-olheiro', () => {});
    assert.strictEqual(sala.expiraEm, antes, 'assinar o canal não pode renovar o relógio');

    await dorme(TTL * 1.6);
    assert.strictEqual(s.obter(TIPOS.NOTAS, id), null, 'sala sobreviveu só de ter alguém olhando');
  });

  await check('o anúncio de arquivo novo traz o relógio do servidor', async () => {
    const sala = s.criar(TIPOS.DRIVE);
    const eventos = [];
    s.ouvir(sala, 'cliente-relogio2', (ev) => eventos.push(ev));

    const arq = await s.enviarArquivo(sala, 'relogio.bin', Readable.from(['x']));
    assert.ok(Number.isFinite(arq.agora), 'resposta do upload sem relógio');
    const aviso = eventos.find((ev) => ev.tipo === 'arquivo-novo');
    assert.ok(aviso, 'sem arquivo-novo');
    assert.ok(Number.isFinite(aviso.agora), 'evento sem relógio');
    assert.ok(aviso.arquivo.expiraEm > aviso.agora, 'prazo do arquivo antes do agora');
  });

  await check('o upload grava os bytes certos e anuncia na sala', async () => {
    const sala = s.criar(TIPOS.DRIVE);
    const eventos = [];
    s.ouvir(sala, 'cliente-c', (ev) => eventos.push(ev.tipo));

    const conteudo = 'ola mundo';
    const arq = await s.enviarArquivo(sala, 'recado.txt', Readable.from([conteudo]));
    assert.strictEqual(arq.tamanho, Buffer.byteLength(conteudo));
    assert.strictEqual(arq.nome, 'recado.txt');
    assert.ok(eventos.includes('arquivo-novo'), 'sem evento de arquivo-novo');

    const caminho = path.join(s.cfg.dirBase, arq.id);
    assert.strictEqual(bytesDe(caminho).toString('utf8'), conteudo);
    assert.strictEqual(s.lista(sala).length, 1);
  });

  await check('o arquivo some do disco e da lista ao fim do prazo', async () => {
    const sala = s.criar(TIPOS.DRIVE);
    const eventos = [];
    s.ouvir(sala, 'cliente-d', (ev) => eventos.push(ev.tipo));

    /* Batendo o "pingue" de quem está conectado, a sala sobrevive e só o
       relógio do arquivo conta — é o cenário de quem está vendo a lista. */
    const batida = setInterval(() => s.ativar(sala), TTL / 3);

    try {
      const arq = await s.enviarArquivo(sala, 'efemero.bin', Readable.from(['abc']));
      const caminho = path.join(s.cfg.dirBase, arq.id);

      await dorme(TTL * 1.6);
      assert.ok(!fs.existsSync(caminho), 'arquivo no disco depois do prazo');
      assert.strictEqual(s.lista(sala).length, 0, 'arquivo ainda na lista');
      assert.ok(eventos.includes('arquivo-expirou'), 'sem evento de expiração');
    } finally {
      clearInterval(batida);
    }
  });

  await check('download em andamento segura a exclusão até terminar', async () => {
    const sala = s.criar(TIPOS.DRIVE);
    const arq = await s.enviarArquivo(sala, 'filme.mkv', Readable.from(['bytes']));
    const caminho = path.join(s.cfg.dirBase, arq.id);
    const aberto = s.arquivo(sala, arq.id);
    assert.ok(aberto, 'arquivo sumiu antes da hora');

    s.iniciarBaixando(aberto);
    await dorme(TTL * 1.6); /* prazo do arquivo vence com o download aberto */

    assert.strictEqual(s.lista(sala).length, 0, 'expirado deve sair da lista');
    assert.ok(fs.existsSync(caminho), 'disco não pode ser tocado com resposta aberta');

    s.finalizarBaixando(aberto);
    assert.ok(!fs.existsSync(caminho), 'com o download fechado, apaga agora');
    assert.strictEqual(s.lista(sala).length, 0);
  });

  await check('upload acima do limite é cortado e não deixa resíduo', async () => {
    const s2 = novo({ tamMaxBytes: 10 });
    const sala = s2.criar(TIPOS.DRIVE);
    let erro = null;
    try {
      await s2.enviarArquivo(sala, 'grande.txt', Readable.from([Buffer.alloc(64)]));
    } catch (err) {
      erro = err;
    }
    assert.ok(erro, 'deveria recusar');
    assert.strictEqual(erro.status, 413, 'status=' + (erro && erro.status));
    assert.strictEqual(fs.readdirSync(s2.cfg.dirBase).length, 0, 'resíduo no disco');
    assert.strictEqual(s2.lista(sala).length, 0, 'arquivo recusado entrou na lista');
  });

  await check('upload interrompido também limpa o disco', async () => {
    const sala = s.criar(TIPOS.DRIVE);
    const fonte = new Readable({
      read() { this.destroy(new Error('corte de rede')); },
    });
    let erro = null;
    try {
      await s.enviarArquivo(sala, 'metade.txt', fonte);
    } catch (err) {
      erro = err;
    }
    assert.ok(erro, 'deveria falhar');
    assert.strictEqual(fs.readdirSync(s.cfg.dirBase).length, 0, 'parcial no disco');
    assert.strictEqual(s.lista(sala).length, 0);
  });

  await check('o teto de salas barra a terceira sala', () => {
    const s2 = novo({ maxSalas: 2 });
    s2.criar(TIPOS.NOTAS);
    s2.criar(TIPOS.NOTAS);
    let erro = null;
    try {
      s2.criar(TIPOS.NOTAS);
    } catch (err) {
      erro = err;
    }
    assert.ok(erro, 'deveria barra');
    assert.strictEqual(erro.status, 429);
  });

  await check('o teto de arquivos barra o terceiro envio', async () => {
    const s2 = novo({ maxArquivos: 2 });
    const sala = s2.criar(TIPOS.DRIVE);
    await s2.enviarArquivo(sala, '1.txt', Readable.from(['a']));
    await s2.enviarArquivo(sala, '2.txt', Readable.from(['b']));
    let erro = null;
    try {
      await s2.enviarArquivo(sala, '3.txt', Readable.from(['c']));
    } catch (err) {
      erro = err;
    }
    assert.ok(erro, 'deveria barra');
    assert.strictEqual(erro.status, 429);
  });

  await check('a nota tem teto de caracteres', () => {
    const sala = s.criar(TIPOS.NOTAS);
    let erro = null;
    try {
      s.escrever(sala, 'x'.repeat(101));
    } catch (err) {
      erro = err;
    }
    assert.ok(erro, 'deveria barra');
    assert.strictEqual(erro.status, 413);
    assert.strictEqual(s.ler(sala).texto, '', 'nota gigante não pode entrar');
  });

  fs.rmSync(dirRaiz, { recursive: true, force: true });

  console.log(
    failures ? '\n' + pass + ' passaram, ' + failures.length + ' falharam\n' : '\n' + pass + ' passaram, 0 falharam\n'
  );
  process.exit(failures.length ? 1 : 0);
})();
