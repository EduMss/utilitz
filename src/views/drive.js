'use strict';

const { layout, tempoLegivel } = require('./layout');
const { formatarTamanho } = require('../lib/salas');

/**
 * Página do drive compartilhado.
 *
 * Mesma casca da notas: `/drive` cria a sala, `/drive/:id` abre — e o cliente
 * JS decide qual painel mostrar. O limite por arquivo e o prazo vêm do
 * servidor (config do `.env`) e entram no texto da página para ninguém ter
 * que adivinhar.
 */
function drive({ tamMaxBytes, ttlMs } = {}) {
  const limite = formatarTamanho(tamMaxBytes == null ? 25 * 1024 * 1024 : tamMaxBytes);
  const ttl = tempoLegivel(ttlMs == null ? 10 * 60000 : ttlMs);

  return layout({
    title: 'Drive compartilhado',
    description:
      'Drive efêmero: envie arquivos até o limite configurado, compartilhe por link público ou privado e deixe tudo sumir sozinho.',
    active: '/drive',
    bodyClass: 'page-drive',
    scripts: ['/js/salas.js', '/js/drive.js'],
    body: `
<main class="home sala">
  <section class="hero sala-hero" id="dv-hero">
    <p class="eyebrow">Salas temporárias</p>
    <h1>Drive <span class="grad">compartilhado</span>, sem cadastro.</h1>
    <p class="lead">
      Envie arquivos de até ${limite} por sala, mande o link e todo mundo baixa
      de onde estiver. Cada arquivo some ${ttl} depois do envio terminar — e a
      contagem só começa quando os bytes chegam de verdade.
    </p>
    <div class="hero-actions">
      <a class="btn btn-ghost" href="/notas">Abrir as notas</a>
    </div>
  </section>

  <section class="sala-card" id="dv-criar">
    <h2>Criar sala de arquivos</h2>
    <p class="sala-hint">
      Com senha, só quem souber dela envia e baixa. Sem senha, o link já é
      suficiente.
    </p>
    <div class="sala-form">
      <input type="password" id="dv-nova-senha" class="text-input sala-input"
        placeholder="Senha (opcional)" autocomplete="new-password" maxlength="100">
      <button type="button" class="btn btn-primary" id="dv-criar-btn">Criar sala</button>
    </div>
  </section>

  <section class="sala-card" id="dv-senha" hidden>
    <h2>Sala privada</h2>
    <p class="sala-hint" id="dv-senha-msg">Essa sala é protegida — informe a senha para entrar.</p>
    <div class="sala-form">
      <input type="password" id="dv-entrada-senha" class="text-input sala-input"
        placeholder="Senha da sala" autocomplete="current-password" maxlength="100">
      <button type="button" class="btn btn-primary" id="dv-entrar-btn">Entrar</button>
    </div>
    <p class="sala-erro" id="dv-senha-erro" hidden></p>
  </section>

  <section class="sala-card" id="dv-expirou" hidden>
    <h2>Essa sala acabou</h2>
    <p class="sala-hint">
      Sala não encontrada: o prazo passou ou o link está errado. Os arquivos
      dela já saíram do servidor.
    </p>
    <div class="sala-form">
      <a class="btn btn-primary" href="/drive">Criar outra sala</a>
    </div>
  </section>

  <section class="sala-mesa" id="dv-sala" hidden>
    <header class="sala-head">
      <span class="sala-codigo" id="dv-codigo"></span>
      <span class="chip sala-chip" id="dv-privada" hidden>privada</span>
      <span class="sala-meta"><strong id="dv-online">1</strong> online</span>
      <span class="sala-estado">
        <span class="sala-dot" id="dv-dot"></span><span id="dv-status">conectando</span>
      </span>
      <span class="grow"></span>
      <button type="button" class="btn btn-ghost btn-sm" id="dv-copiar">Copiar link</button>
      <button type="button" class="btn btn-ghost btn-sm" id="dv-sair">Sair</button>
    </header>

    <section class="convi-drop dv-drop" id="dv-drop">
      <input type="file" id="dv-input" multiple hidden>
      <div class="convi-drop-inner">
        <strong>Arraste arquivos para cá</strong>
        <span id="dv-limite">até ${limite} por arquivo · some ${ttl} depois do envio</span>
      </div>
    </section>

    <div class="dv-uploads" id="dv-uploads" hidden></div>
    <div class="dv-lista" id="dv-lista">
      <p class="empty">Nenhum arquivo ainda — envie o primeiro.</p>
    </div>
  </section>
</main>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { drive };
