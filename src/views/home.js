'use strict';

const { layout } = require('./layout');

const FEATURES = [
  {
    title: 'Renderização no servidor',
    text: 'O mesmo markdown-it cuida da tela e do PDF, então o que você vê é exatamente o que é exportado.',
  },
  {
    title: 'Página de visualização',
    text: 'Tela cheia, apenas o documento renderizado. O editor fica escondido numa gaveta que você abre quando quiser.',
  },
  {
    title: 'Conversor para PDF',
    text: 'Tela dividida: você escreve à esquerda e acompanha as páginas paginadas à direita, em tempo real.',
  },
  {
    title: 'Conversor de imagens',
    text: 'Troque o formato de PNG, JPEG, WebP, GIF, BMP, TIFF, ICO e SVG sem sair do navegador — nada é enviado ao servidor.',
  },
  {
    title: 'Formatador de arquivos',
    text: 'JSON, XML, HTML, Markdown, CSV, texto e código (Python, C#, Java…) saem arrumados, realçados e com número de linha.',
  },
  {
    title: 'Conversor de HTML para PDF',
    text: 'Cole uma página inteira ou um pedaço de HTML e baixe o PDF com papel, margens e orientação à sua escolha.',
  },
  {
    title: 'Notas compartilhadas',
    text: 'Um bloco de notas efêmero por link: dois (ou vinte) escrevem ao mesmo tempo e a sala some sozinha sem atividade.',
  },
  {
    title: 'Drive temporário',
    text: 'Envie arquivos por link público ou privado, com limite configurável — e deixe o servidor se limpar depois do prazo.',
  },
  {
    title: 'Tipografia a seu gosto',
    text: 'Fonte, corpo, entrelinha, margens, tamanho do papel, tema, cabeçalho, rodapé, sumário e muito mais.',
  },
  {
    title: 'Biblioteca',
    text: 'Salve os documentos no servidor e reabra depois, sem perder nada ao fechar o navegador.',
  },
  {
    title: 'Sem dependência externa',
    text: 'Node.js, Express, markdown-it e PDFKit. Os arquivos .md podem ser abertos e salvos direto no navegador.',
  },
];

const SAMPLES = [
  {
    name: 'Artigo',
    text: `# Anatomia de um bom texto

Escrever bem é antes de tudo **enxugar**. Este documento reúne alguns
princípios que uso no dia a dia.

## Princípio 1: corte tudo que não sustenta a ideia

> Se uma frase não acrescenta nada, ela é ruído.

## Princípio 2: varia a estrutura

- Frases curtas para bater o ponto.
- Frases longas para construir a cena.
- Listas quando a ordem importa.

| Sinal | O que costuma indicar |
|:------|:---------------------|
| Muito "a" | Run-on sentence |
| Muita vírgula | Parágrafo pesado |

\`\`\`js
const texto = ['corte', 'varie', 'clareza'];
console.log(texto.join(' → '));
\`\`\`

## Princípio 3: releia em voz alta

Se você tropeça lendo, o leitor também tropeça.
`,
  },
  {
    name: 'Documento técnico',
    text: `# API de exemplo

## Autenticação

Envie o token no cabeçalho:

\`\`\`bash
curl -H "Authorization: Bearer TOKEN" https://api.exemplo.com/v1/usuarios
\`\`\`

### Resposta

\`\`\`json
{
  "id": 42,
  "nome": "Maria",
  "ativo": true
}
\`\`\`

1. Valide o token.
2. Processe a requisição.
3. Devolva JSON com status 200.

| Código | Significado |
|:------:|:------------|
| 200    | Sucesso     |
| 401    | Sem token   |
| 404    | Não existe  |

> Erros sempre retornam \`{ "erro": "mensagem" }\`.
`,
  },
];

function home() {
  const featureCards = FEATURES.map(
    (item) => `
      <article class="feature">
        <h3>${item.title}</h3>
        <p>${item.text}</p>
      </article>`
  ).join('');

  const sampleButtons = SAMPLES.map(
    (sample, index) =>
      `<button type="button" class="chip" data-sample="${index}">${sample.name}</button>`
  ).join('');

  return layout({
    title: 'Início',
    active: '/',
    bodyClass: 'page-home',
    body: `
<main class="home">
  <section class="hero">
    <p class="eyebrow">Aplicação fullstack Node.js</p>
    <h1>Markdown em dois modos:<br><span class="grad">ler na tela</span> e <span class="grad">virar PDF</span>.</h1>
    <p class="lead">
      Escreva markdown, veja o resultado renderizado em tela cheia ou converta em PDF
      com controle de fonte, margens, tema, cabeçalho e paginação.
    </p>
    <div class="hero-actions">
      <a class="btn btn-primary" href="/visualizar">Visualizar em tela cheia</a>
      <a class="btn btn-ghost" href="/pdf">Converter para PDF</a>
      <a class="btn btn-ghost" href="/imagens">Converter imagens</a>
      <a class="btn btn-ghost" href="/formatar">Formatar arquivos</a>
      <a class="btn btn-ghost" href="/html-pdf">HTML para PDF</a>
      <a class="btn btn-ghost" href="/notas">Notas compartilhadas</a>
      <a class="btn btn-ghost" href="/drive">Drive temporário</a>
    </div>
  </section>

  <section class="start">
    <div class="start-head">
      <h2>Comece colando seu markdown</h2>
      <p>Escreva ou cole o conteúdo abaixo e escolha o destino.</p>
    </div>
    <textarea id="home-source" class="home-editor" spellcheck="false"
      placeholder="# Seu título&#10;&#10;Escreva aqui..."></textarea>
    <div class="start-actions">
      <div class="samples">
        <span class="samples-label">Exemplos:</span>
        ${sampleButtons}
        <button type="button" class="chip" id="btn-image" title="Inserir imagem (colar, arrastar ou escolher arquivo)">🖼 Imagem</button>
      </div>
      <div class="start-buttons">
        <button type="button" class="btn btn-soft" data-go="viewer">Abrir no visualizador</button>
        <button type="button" class="btn btn-primary" data-go="pdf">Gerar PDF</button>
      </div>
    </div>
  </section>

  <section class="grid">
    ${featureCards}
  </section>

  <section class="library" id="library">
    <div class="library-head">
      <h2>Biblioteca</h2>
      <button type="button" class="btn btn-ghost btn-sm" id="library-refresh">Atualizar</button>
    </div>
    <div class="library-list" id="library-list">
      <p class="empty">Carregando…</p>
    </div>
  </section>

  <footer class="foot">
    <span>Markdown Studio · Express + markdown-it + PDFKit + Paged.js</span>
  </footer>
</main>

<input type="file" id="img-input" accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp" hidden>

<div class="dropzone dropzone-screen" id="screen-drop" aria-hidden="true">
  <div>
    <strong>Solte a imagem aqui para inserir no markdown</strong>
    <small>No editor, ela entra exatamente no ponto do mouse.</small>
  </div>
</div>`,
    scripts: ['/js/home.js'],
  });
}

module.exports = { home };