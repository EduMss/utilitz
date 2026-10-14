'use strict';

/**
 * API das salas compartilhadas: bloco de notas e drive.
 *
 * Duas formas de passar a senha, porque o navegador nem sempre deixa mandar
 * cabeçalho: API em JSON leva `x-sala-senha`, e os pontos que não podem
 * (o EventSource das atualizações e o link de download do `<a>`) levam
 * `?senha=`. A senha nunca volta em resposta — só o resultado dela.
 */

const fs = require('node:fs');

const express = require('express');

const { salas, TIPOS, formatarTamanho } = require('../lib/salas');

const router = express.Router();

/** Senha da requisição: cabeçalho da API ou query (links sem JS). */
function senhaDe(req) {
  const cabecalho = req.get('x-sala-senha');
  if (cabecalho != null && cabecalho !== '') return cabecalho;
  return typeof req.query.senha === 'string' ? req.query.senha : '';
}

/** Resolve a sala ou escreve a resposta de erro que cabe no caso. */
function achar(req, res, tipo) {
  const sala = salas.obter(tipo, req.params.id);
  if (!sala) {
    res.status(404).json({ error: 'Sala não encontrada — ela expirou ou nunca existiu.', expirada: true });
    return null;
  }
  const senha = senhaDe(req);
  if (salas.autenticado(sala, senha)) return sala;
  if (!senha) {
    res.status(401).json({ error: 'Essa sala é privada: informe a senha.', precisaSenha: true });
  } else {
    res.status(403).json({ error: 'Senha incorreta.', precisaSenha: true });
  }
  return null;
}

/** `Content-Disposition` com o nome real em UTF-8 e cópia ASCII segura. */
function disposicao(nome) {
  const ascii = String(nome).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'arquivo';
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nome);
}

/** O que a página recebe ao entrar e o que o SSE repete como primeira mensagem. */
function estadoDe(sala) {
  const base = {
    tipo: 'estado',
    id: sala.id,
    privada: !!sala.senhaHash,
    online: salas.online(sala),
    agora: Date.now(),
  };
  if (sala.tipo === TIPOS.NOTAS) return Object.assign(base, salas.ler(sala));
  return Object.assign(base, {
    arquivos: salas.lista(sala),
    tamMaxBytes: salas.cfg.tamMaxBytes,
    ttlArquivoMs: salas.cfg.ttlArquivoMs,
    expiraEm: sala.expiraEm,
  });
}

/**
 * O relógio do backend, mandado a cada ping: prazo e gente, para todas as
 * abas contarem a partir do mesmo número. Sem isto cada aba guarda o prazo
 * da última mensagem que recebeu e os contadores divergem.
 */
function relogioDe(sala) {
  return {
    tipo: 'relogio',
    id: sala.id,
    expiraEm: sala.expiraEm,
    agora: Date.now(),
    online: salas.online(sala),
  };
}

/**
 * Abre o canal de atualizações: estado inicial, eventos da sala, ping que
 * repete o prazo do backend (sem renová-lo — só edição reinicia o relógio)
 * e desligamento limpo.
 */
function abrirEventos(req, res, sala) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const enviar = (evento) => {
    res.write('event: ' + evento.tipo + '\ndata: ' + JSON.stringify(evento) + '\n\n');
  };

  /* Registra antes do estado inicial: JavaScript é sequencial, então nenhum
     evento se perde entre a assinatura e a primeira mensagem. */
  const remover = salas.ouvir(sala, '', (evento) => {
    enviar(evento);
    if (evento.tipo === 'encerrada') res.end();
  });
  enviar(estadoDe(sala));

  const ping = setInterval(() => {
    /* O relógio do backend, sem renová-lo: quem está olhando vê o prazo
       descer em todas as abas, e a sala morre no tempo marcado — a
       renovação é só edição (e upload no drive). */
    enviar(relogioDe(sala));
  }, salas.cfg.pingMs);
  if (ping.unref) ping.unref();

  /* O sair avisa o resto da sala — `remover` faz isso sozinho. */
  req.on('close', () => {
    clearInterval(ping);
    remover();
  });
}

/* ------------------------------------------------------------------ *
 * Bloco de notas
 * ------------------------------------------------------------------ */
router.post('/notas', (req, res, next) => {
  try {
    const body = req.body || {};
    const senha = body.senha ? String(body.senha).slice(0, 100) : '';
    const sala = salas.criar(TIPOS.NOTAS, senha);
    res.status(201).json({ id: sala.id, privada: !!sala.senhaHash });
  } catch (err) {
    next(err);
  }
});

router.get('/notas/:id', (req, res) => {
  const sala = achar(req, res, TIPOS.NOTAS);
  if (!sala) return;
  /* Abrir a página não renova o prazo: o relógio conta da última edição. */
  res.json(estadoDe(sala));
});

router.post('/notas/:id', (req, res, next) => {
  try {
    const sala = achar(req, res, TIPOS.NOTAS);
    if (!sala) return;
    const body = req.body || {};
    const texto = body.texto == null ? '' : body.texto;
    res.json(salas.escrever(sala, texto));
  } catch (err) {
    next(err);
  }
});

router.get('/notas/:id/eventos', (req, res) => {
  const sala = achar(req, res, TIPOS.NOTAS);
  if (!sala) return;
  abrirEventos(req, res, sala);
});

/* ------------------------------------------------------------------ *
 * Drive
 * ------------------------------------------------------------------ */
router.post('/drive', (req, res, next) => {
  try {
    const body = req.body || {};
    const senha = body.senha ? String(body.senha).slice(0, 100) : '';
    const sala = salas.criar(TIPOS.DRIVE, senha);
    res.status(201).json({ id: sala.id, privada: !!sala.senhaHash, tamMaxBytes: salas.cfg.tamMaxBytes });
  } catch (err) {
    next(err);
  }
});

router.get('/drive/:id', (req, res) => {
  const sala = achar(req, res, TIPOS.DRIVE);
  if (!sala) return;
  /* Ver a lista não renova o prazo da sala: só um upload novo segura. */
  res.json(estadoDe(sala));
});

/**
 * Upload sem multipart: o corpo da requisição É o arquivo (octet-stream), o
 * nome vem na query. Assim o arquivo chega em fluxo, direto para o disco,
 * sem biblioteca de form-data e sem passar inteiro pela RAM.
 */
router.post('/drive/:id/arquivos', async (req, res, next) => {
  try {
    const sala = achar(req, res, TIPOS.DRIVE);
    if (!sala) return;

    /* Content-Length prometido já grande: recusa antes de receber um byte. */
    const prometido = Number(req.get('content-length'));
    if (Number.isFinite(prometido) && prometido > salas.cfg.tamMaxBytes) {
      return res.status(413).json({
        error: 'Arquivo maior que o limite de ' + formatarTamanho(salas.cfg.tamMaxBytes) + '.',
      });
    }

    const arquivo = await salas.enviarArquivo(
      sala,
      typeof req.query.nome === 'string' ? req.query.nome : 'arquivo',
      req
    );
    res.status(201).json({ arquivo });
  } catch (err) {
    next(err);
  }
});

router.get('/drive/:id/arquivos/:fid', (req, res) => {
  const sala = achar(req, res, TIPOS.DRIVE);
  if (!sala) return;

  const arq = salas.arquivo(sala, req.params.fid);
  if (!arq) {
    return res.status(404).json({ error: 'Arquivo não encontrado — ele expirou.' });
  }

  /* Enquanto a resposta estiver aberta, o relógio não tira o arquivo do
     disco: `iniciarBaixando` segura a exclusão até `finalizarBaixando`. */
  salas.iniciarBaixando(arq);
  let terminado = false;
  const terminar = () => {
    if (terminado) return;
    terminado = true;
    salas.finalizarBaixando(arq);
  };
  res.on('finish', terminar);
  res.on('close', terminar);

  res.status(200);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(arq.tamanho),
    'Cache-Control': 'no-store',
    'Content-Disposition': disposicao(arq.nome),
  });

  /* `arq.caminho` é montado pelo servidor a partir do id gerado por nós — o
     nome que o usuário mandou nunca vira caminho. */
  const leitor = fs.createReadStream(arq.caminho);
  leitor.on('error', (err) => {
    terminar();
    if (!res.headersSent) res.status(500).json({ error: 'Não consegui ler o arquivo.' });
    else res.destroy(err);
  });
  leitor.pipe(res);
});

router.get('/drive/:id/eventos', (req, res) => {
  const sala = achar(req, res, TIPOS.DRIVE);
  if (!sala) return;
  abrirEventos(req, res, sala);
});

module.exports = router;
