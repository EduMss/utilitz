# Markdown Studio

Estúdio de Markdown em Node.js com duas ferramentas:

- **Visualizador** — cole um Markdown e veja o resultado renderizado em tela cheia.
- **Conversor para PDF** — tela dividida com editor à esquerda e pré-visualização paginada em tempo real à direita, além de um gerador de PDF no servidor com controle tipográfico.

Nenhuma conta, nenhum banco de dados. Os documentos ficam no navegador (localStorage) ou na biblioteca local em `data/biblioteca.json`.

## Requisitos

- Node.js 18 ou superior (testado no 24)

## Como rodar

```bash
npm install
npm start
```

Depois abra <http://localhost:3000>.

Durante o desenvolvimento, com recarregamento automático do servidor:

```bash
npm run dev
```

### Com Docker

```bash
docker compose up --build
```

Depois abra <http://localhost:3000>. Para escolher a porta do host (a do
container continua 3000):

```bash
APP_PORT=8080 docker compose up --build
```

A biblioteca e as fontes baixadas do Google Fonts ficam no volume nomeado
`markdown-studio-data`, montado em `/app/data`. Num volume recém-criado o
Docker copia o `data/` que veio na imagem, então as fontes já instaladas
continuam lá; para começar do zero, `docker compose down -v` apaga o volume.

O container sobe sem privilégio, com o usuário `node`, e traz um healthcheck
em `/api/settings`. Os logs e o rebuild seguem o padrão do Compose:

```bash
docker compose logs -f        # logs
docker compose up -d --build  # sobe em segundo plano
docker compose down           # derruba (preserva o volume)
```

## Páginas

| Rota | O que faz |
| --- | --- |
| `/` | Página inicial: atalhos, exemplos e biblioteca de documentos salvos. |
| `/visualizar` | Visualizador em tela cheia. Editor e sumário guardam o texto em uma gaveta para deixar a leitura limpia. |
| `/pdf` | Conversor com tela dividida e painel de configurações. |
| `/formatar` | Formatação de arquivos: JSON, XML, HTML, Markdown, CSV, texto e código (Python, C#, Java…). Prévia com números de linha, realce de sintaxe e botões de copiar/baixar — tudo no navegador, nada vai para o servidor. |

As duas ferramentas são de tela cheia e por isso não repetem a barra de
navegação do site. Para não ficarem sem identidade, cada uma mostra a marca
`M↓` no canto: no visualizador ela fica na barra flutuante, no conversor na
barra do editor, e as duas levam de volta para `/`.

O texto escrito na página inicial segue para a ferramenta escolhida. A passagem
é feita por uma chave de uso único (`md:handoff`), separada do rascunho de cada
página, para o título não se misturar ao texto salvo.

## Inserir imagens

Os três editores — página inicial, visualizador e conversor — aceitam imagens de
três formas, todas convertendo o arquivo para base64 e embutindo no markdown:

- **Colar** com `Ctrl+V` enquanto a imagem está na área de transferência;
- **Arrastar** um arquivo de imagem para dentro da página (surge a área de soltar);
  soltar sobre o editor coloca a imagem exatamente no ponto do mouse;
- **Escolher o arquivo** pelo botão 🖼 (na barra do editor ou na gaveta).

A imagem entra no texto como `![alt](data:image/...;base64,...)`. Como está no
markdown, ela é renderizada na pré-visualização e entra no PDF exportado da mesma
forma que qualquer outra imagem — sem depender de hospedagem externa.

Formatos: PNG, JPG, GIF, WebP, AVIF e BMP, até 15 MB por arquivo. SVG fica de fora
de propósito, pois um SVG embutido poderia carregar scripts. A leitura e a
inserção ficam em um módulo compartilhado, `public/js/images.js`.

## API

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/api/render` | Recebe `{ markdown }` e devolve `{ html, headings, stats }`. |
| `POST` | `/api/stats` | Recebe `{ markdown }` e devolve contagens de palavras, caracteres, títulos e tempo de leitura. |
| `POST` | `/api/pdf` | Recebe `{ markdown, settings, title, inline }` e devolve o arquivo PDF. |
| `GET` | `/api/settings` | Devolve os padrões, presets, temas, tamanhos de página e fontes. |
| `GET` | `/api/library` | Lista os documentos salvos (sem o conteúdo). |
| `GET` | `/api/library/:id` | Devolve um documento completo. |
| `POST` | `/api/library` | Salva um documento: `{ title, content, kind, settings }`. |
| `DELETE` | `/api/library/:id` | Remove um documento. |

## Configurações do PDF

Tudo é ajustável pelo painel lateral e salvo no navegador.

- **Página** — tamanho (A4, Carta, A5, Legal), orientação e margens em milímetros.
- **Tipografia** — fonte do texto e dos títulos, corpo do texto, entrelinha, espaço entre parágrafos, escala dos títulos, recuo da primeira linha, alinhamento e estilo dos marcadores de lista.
- **Cores** — tema pronto (claro, sepia, noite) ou ajuste fino de texto, títulos, links, código, realce, fundo, bordas e fundo do código.
- **Cabeçalho e rodapé** — posição e formato da numeração de páginas e título corrido.
- **Sumário** — geração automática no início do documento, com escolha de profundidade.
- **Detalhes** — largura das imagens, legendas, realce de sintaxe e hifenização.

Há presets prontos (artigo, relatório, manual, slides e afins) que definem tudo de uma vez.

## Gerar o PDF com o Chrome

Por padrão o PDF sai do gerador em PDFKit (`src/lib/pdf.js`). Dá para trocar por
uma renderização no Chrome/Chromium headless, que imprime o mesmo HTML paginado
pela pré-visualização (Paged.js): útil quando você quer o PDF idêntico à tela,
com as fontes e o realce de código do navegador.

A escolha é feita no `.env` (veja `.env.example`):

```dotenv
# false = PDFKit (padrão) | true = Chrome/Chromium headless
USER_CHROME=true

# Pasta (ou executável) do Chrome/Chromium/Edge. Vazio = detecta sozinho.
DIR_CHROME=
```

- `USER_CHROME` ausente ou `false` mantém o gerador atual. Qualquer valor
  diferente de `false`/`0`/`off` liga o modo Chrome (`USER_CHROME` e o apelido
  `USE_CHROME` são aceitos).
- `DIR_CHROME` aceita o caminho do executável ou a pasta que o contém. Em
  branco, o servidor procura nos caminhos comuns (Chrome, Chromium e Edge, em
  Windows, macOS e Linux) e no `PATH`.
- A impressão usa o DevTools Protocol do Chrome (Node 22+ precisa do `WebSocket`
  global). Em Node mais antigo, cai para o modo `--print-to-pdf` — funciona,
  mas depende de orçamento de tempo virtual e pode, em condições extremas,
  cortar a paginação no meio; em qualquer caso, o conteúdo nunca sai em branco.
- Se o Chrome estiver ligado mas não for encontrado — ou falhar ao gerar —
  o servidor volta sozinho para o PDFKit, sem quebrar o download. A resposta
  diz qual motor foi usado no cabeçalho `X-Pdf-Engine` (`chrome` ou `pdfkit`).

Variáveis já definidas no ambiente ganham do `.env`, então dá para ligar o modo
na hora sem editar o arquivo:

```bash
USER_CHROME=true npm start
```

No Docker, o modo Chrome precisa de um navegador na imagem (o `Dockerfile`
não traz Chromium por padrão). Se instalar um, aponte `DIR_CHROME` para o
caminho dele pelas variáveis do `docker-compose.yml`.

## Como funciona

O HTML é gerado **no servidor** por `src/lib/markdown.js` (markdown-it + highlight.js) e higienizado antes de voltar ao navegador. O visualizador e a pré-visualização do PDF consomem exatamente o mesmo HTML, então os dois modos nunca divergem.

O PDF é montado no servidor por `src/lib/pdf.js`, que percorre os tokens do Markdown e desenha cada bloco com PDFKit usando fontes padrão (Helvetica, Times e Courier). Com `USER_CHROME` ligado, `src/lib/chrome.js` monta o mesmo HTML da prévia, deixa o Paged.js paginar e imprime com o Chrome headless pelo DevTools Protocol (`Page.printToPDF`), esperando a paginação confirmar antes de imprimir — sem navegador disponível, o PDFKit assume. A pré-visualização usa o Paged.js para paginar o mesmo CSS no navegador — é por isso que ela reflete quebra de página, cabeçalho, rodapé e sumário reais. Usamos o bundle `public/vendor/paged.js` (e não o `paged.polyfill`): o polyfill se auto-executa e consome as folhas de estilo do documento, o que quebraria o layout da página.

As configurações vivem em um único arquivo, `public/js/shared-settings.js`, carregado tanto pelo Node quanto pelo navegador. Isso evita que servidor e cliente se desalinham.

```
server.js              bootstrap do Express
src/lib/env.js         leitura do .env
src/lib/markdown.js    Markdown -> HTML (+ higienização)
src/lib/pdf.js         Markdown -> PDF (PDFKit)
src/lib/chrome.js      Markdown -> PDF no Chrome headless (opcional)
src/lib/settings.js    normalização de configurações, geometria, cores
src/lib/syntax.js      realce de código (highlight.js -> linhas coloridas)
src/lib/library.js     biblioteca em JSON
src/routes/            rotas de página e de API
src/views/             templates HTML
public/                CSS, JS do cliente, favicon e o Paged.js
scripts/               testes e gerador de exemplo
```

## Segurança

O Markdown aceita HTML bruto, então a saída passa por um higienizador que remove `<script>`, `<iframe>`, `<style>`, `<object>`, `<embed>`, `<form>`, atributos `on*` e URLs `javascript:`/`vbscript:`/`data:text/html`. Links internos do Markdown também são recusados na origem. Imagens embutidas em base64 continuam funcionando.

## Testes

```bash
npm test              # integridade + formatação + renderização + matriz completa de PDF
npm run check         # encoding, chaves CSS e assets referenciados
npm run test:format   # núcleo de formatação (JSON, XML/HTML, Markdown, CSV, texto, código)
npm run test:render   # renderização e higienização
npm run test:pdf      # matriz de presets, temas, numeração e casos-limite
npm run test:api      # ponta a ponta (exige o servidor rodando)
npm run test:browser  # render real em Chrome/Edge headless (exige o servidor)
npm run smoke         # gera um PDF de exemplo com todos os recursos
```

O `test:format` exercita `public/js/format-core.js` — o mesmo módulo que roda no
navegador, carregado direto pelo Node. Cobre o JSON (inclusive o erro com linha e
coluna), a árvore do XML/HTML, o Markdown (títulos, cercas de código intactas,
front matter), a tabela do CSV, o `\n` literal do texto simples, o recuo do
código e a detecção automática; confere também o bundle do highlight.js usado
pela prévia.

O `test:browser` é o teste que mais importa: ele abre as duas ferramentas em um
navegador de verdade, semeia um documento e confere se o conteúdo renderizado
está no DOM, se a prévia do PDF paginou em mais de uma folha e se o `@page`
(tamanho e margens) chegou ao Paged.js. Também confere que o texto da página
inicial chega às ferramentas. A gaveta do visualizador é testada com clique de
verdade, num iframe de mesma origem: confirma que o botão *Fechar* está
visível, não está coberto e realmente fecha. O mesmo harness abre o `/pdf` e
mede a área do editor, da prévia e dos botões, checando que o clique chega ao
*Baixar PDF*. Conferir o HTML não bastaria — um botão pode estar no DOM com o
listener faltando, ou presente e rolado para fora da tela, e nenhum dos dois
aparece no `curl`. Se faltar o Chrome ou o Edge, ele é pulado em vez de
falhar.

A paginação do Paged.js faz trabalho real de layout, então a sonda repete o
carregamento com orçamentos de tempo virtual crescentes até a prévia ficar
pronta. Numa máquina lenta isso evita falha falso-positiva por dump
acomodado no meio da paginação.

O `smoke` grava o arquivo na pasta temporária do sistema. Para escolher o destino:

```bash
node scripts/smoke-pdf.js saida.pdf
```

## Atalhos

**Visualizador**

| Atalho | Ação |
| --- | --- |
| `E` | Abrir ou fechar a gaveta do editor |
| `T` | Mostrar ou esconder o sumário |
| `F` | Tela cheia |
| `P` | Imprimir |
| `O` | Abrir arquivo `.md` |
| `+` / `-` / `0` | Zoom |
| `Ctrl+S` | Salvar na biblioteca |
| `Esc` | Fechar a gaveta ou o sumário |
| `↑` / `↓` | Rolar a página |

A gaveta do editor cobre a barra flutuante, então ela traz o próprio botão
**Fechar** e um fundo escuro: clicar fora também fecha.

**Conversor para PDF**

| Atalho | Ação |
| --- | --- |
| `Ctrl+B` / `Ctrl+I` | Negrito / itálico (dentro do editor) |
| `Ctrl+S` | Baixar o PDF |
| `G` | Abrir as configurações |
| `Esc` | Fechar as configurações |

## Cache dos arquivos estáticos

`js` e `css` são servidos com `Cache-Control: no-cache` e as URLs das páginas
carregam um carimbo `?v=<mtime>`, montado em `src/views/layout.js`. Sem isso o
navegador segura o script antigo enquanto o HTML chega novo: o botão aparece na
tela, mas o JS que rodou não tem o listener dele, e nada acontece — sem erro no
console para denunciar. Editar qualquer arquivo de `public/` passa a valer na
hora, sem Ctrl+F5.

## Paged.js e as regras de impressão

O Paged.js trata a saída paginada como meio de impressão: ao receber uma folha
de estilo ele **descarta a condição `print`** e joga as regras dela no escopo da
tela. Como o `app.css` tem um bloco `@media print` que esconde a interface ao
imprimir (`display: none !important` na coluna do editor, `display: block
!important` na tela dividida), ele desmontava o conversor inteiro: o editor
colapsava para 0x0 e a prévia tomava a janela, engolindo o editor e o botão de
baixar.

Por isso `pageStylesheets()` entrega ao Paged.js apenas o CSS do documento
(`markdown.css`) mais o CSS gerado, já sem as regras de impressão, na forma
`{ url: css }`. É um detalhe fácil de perder: o layout continua correto no
`curl` e quebra só no navegador.

## Itens de grid e altura da tela

As colunas do conversor precisam de `min-height: 0` e de uma
`grid-template-columns` explícita. Item de grid tem `min-height: auto` por
padrão, então sem isso a coluna cresce até a altura do conteúdo e o rodapé com
o *Baixar PDF* sai da tela — presente no DOM e visível no `curl`, impossível de
clicar. A sonda mede a área real dos painéis e do botão para pegar isso.

## Licença

MIT