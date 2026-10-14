'use strict';

const { layout, tempoLegivel } = require('./layout');

/**
 * Página do bloco de notas compartilhado.
 *
 * A mesma view serve para `/notas` (criar) e `/notas/:id` (sala aberta): quem
 * monta o HTML não sabe da sala — o cliente JS lê a URL, pergunta à API e
 * mostra um painel ou outro. Assim nenhum segredo de sala vaza no HTML.
 */
function notas({ ttlMs } = {}) {
  const ttl = tempoLegivel(ttlMs == null ? 10 * 60000 : ttlMs);

  return layout({
    title: 'Notas compartilhadas',
    description:
      'Bloco de notas efêmero para escrever juntos em tempo real. Sala pública ou com senha, tudo some depois do prazo.',
    active: '/notas',
    bodyClass: 'page-notas',
    scripts: ['/js/salas.js', '/js/notas.js'],
    body: `
<main class="home sala">
  <section class="hero sala-hero" id="nt-hero">
    <p class="eyebrow">Salas temporárias</p>
    <h1>Bloco de notas <span class="grad">compartilhado</span>.</h1>
    <p class="lead">
      Crie a sala, mande o link e escrevam ao mesmo tempo: o que um digita
      aparece na tela do outro na hora. Depois de ${ttl} sem atividade a sala
      some sozinha — sem histórico, sem servidor guardando nada.
    </p>
    <div class="hero-actions">
      <a class="btn btn-ghost" href="/drive">Abrir o drive</a>
    </div>
  </section>

  <section class="sala-card" id="nt-criar">
    <h2>Criar sala de notas</h2>
    <p class="sala-hint">
      Senha é opcional: sem senha, qualquer pessoa com o link entra e edita.
      Com senha, só quem souber.
    </p>
    <div class="sala-form">
      <input type="password" id="nt-nova-senha" class="text-input sala-input"
        placeholder="Senha (opcional)" autocomplete="new-password" maxlength="100">
      <button type="button" class="btn btn-primary" id="nt-criar-btn">Criar sala</button>
    </div>
  </section>

  <section class="sala-card" id="nt-senha" hidden>
    <h2>Sala privada</h2>
    <p class="sala-hint" id="nt-senha-msg">Essa sala é protegida — informe a senha para entrar.</p>
    <div class="sala-form">
      <input type="password" id="nt-entrada-senha" class="text-input sala-input"
        placeholder="Senha da sala" autocomplete="current-password" maxlength="100">
      <button type="button" class="btn btn-primary" id="nt-entrar-btn">Entrar</button>
    </div>
    <p class="sala-erro" id="nt-senha-erro" hidden></p>
  </section>

  <section class="sala-card" id="nt-expirou" hidden>
    <h2>Essa sala acabou</h2>
    <p class="sala-hint">
      Sala não encontrada: o prazo passou, ela foi encerrada ou o link está
      errado. É assim que funciona — tudo é temporário.
    </p>
    <div class="sala-form">
      <a class="btn btn-primary" href="/notas">Criar outra sala</a>
    </div>
  </section>

  <section class="sala-mesa" id="nt-sala" hidden>
    <header class="sala-head">
      <span class="sala-codigo" id="nt-codigo"></span>
      <span class="chip sala-chip" id="nt-privada" hidden>privada</span>
      <span class="sala-meta" id="nt-online-wrap"><strong id="nt-online">1</strong> online</span>
      <span class="sala-meta" id="nt-expira">—</span>
      <span class="sala-estado">
        <span class="sala-dot" id="nt-dot"></span><span id="nt-status">conectando</span>
      </span>
      <span class="grow"></span>
      <button type="button" class="btn btn-soft btn-sm" id="nt-previa-btn">Prévia</button>
      <button type="button" class="btn btn-ghost btn-sm" id="nt-copiar">Copiar link</button>
      <button type="button" class="btn btn-ghost btn-sm" id="nt-sair">Sair</button>
    </header>

    <div class="sala-wrap">
      <textarea id="nt-texto" class="nt-texto" spellcheck="true" maxlength="500000"
        placeholder="Escreva aqui — quem estiver na sala acompanha em tempo real."></textarea>
      <div class="md nt-previa" id="nt-previa" hidden></div>
    </div>

    <p class="sala-aviso" id="nt-pendente" hidden>
      Outro participante editou — solte o foco do texto para aplicar a versão dele.
    </p>
  </section>
</main>

<div class="toast" id="toast" role="status"></div>
`,
  });
}

module.exports = { notas };
