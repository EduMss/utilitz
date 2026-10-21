# Utilitz Studio

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
| `/logs` | Logs em planilha: JSON, NDJSON, CSV, TSV, XLSX, XLS, ODS e logs de linha (.log do IIS e de pm2/Nest) viram tabela no navegador, com pesquisa, filtro por coluna (texto ou caixa de valores), ordenação, paginação e exportação de volta para CSV e Excel. |
| `/html-pdf` | Conversor de HTML para PDF: página inteira ou pedaço solto, com prévia em iframe, papel, margens, orientação e impressão de fundos. |
| `/notas` | Bloco de notas compartilhado: uma sala efêmera por link, edição em tempo real e senha opcional. |
| `/drive` | Drive temporário: arquivos por link público ou privado, com limite por upload e limpeza automática depois do prazo. |

As duas ferramentas são de tela cheia e por isso não repetem a barra de
navegação do site. Para não ficarem sem identidade, cada uma mostra a marca
`M↓` no canto: no visualizador ela fica na barra flutuante, no conversor na
barra do editor, e as duas levam de volta para `/`.

O texto escrito na página inicial segue para a ferramenta escolhida. A passagem
é feita por uma chave de uso único (`md:handoff`), separada do rascunho de cada
página, para o título não se misturar ao texto salvo.

## Conversor de HTML para PDF

A `/html-pdf` recebe o HTML colado (uma página inteira ou só um pedaço), mostra
a prévia num iframe isolado e manda gerar o PDF pela `POST /api/html-pdf`. O
servidor monta o documento com `src/lib/chrome.js` — um pedaço solto ganha
`<doctype>`, charset e a regra `@page` com o papel e as margens escolhidos na
tela; uma página inteira é preservada, e um `@page` escrito nela continua
valendo mais, porque o CSS de impressão entra no começo do `<head>`. As imagens
são decodificadas e as fontes carregadas antes da impressão, e um sinal
`data-pdf-ready` (o mesmo protocolo do Paged.js) segura o Chrome até o
documento estar pronto — um `<img>` preso nunca vira PDF em branco.

Diferente do PDF de markdown, não há plano B no servidor: o PDFKit não lê HTML,
então sem Chrome/Chromium/Edge a API responde `503` com a explicação e o botão
**Imprimir** da página resolve pelo diálogo nativo do navegador ("Salvar como
PDF"). O HTML só trafega entre a página e o servidor da sua própria máquina.

## Logs em planilha

A `/logs` lê JSON, NDJSON, CSV, TSV, XLSX, XLS e ODS no navegador, com o
build do SheetJS vendido em `public/vendor/xlsx.min.js` (cópia do pacote
`xlsx` do npm; para renovar: `npm i xlsx` e recopie
`node_modules/xlsx/dist/xlsx.full.min.js`).
Também lê logs de linha em `.log` (ou colados no modal): IIS em formato W3C
(diretivas `#Fields`, que podem se repetir entre segmentos; `date` + `time`
viram uma coluna `datahora` e `-` vira célula vazia), saída de pm2/Nest
(cores ANSI removidas, `[Nest] pid - 16/10/2026, 14:39:57 [Módulo] mensagem
+2ms` vira colunas `origem`, `pid`, `datahora`, `modulo`, `mensagem` e
`delta_ms`; o SQL do Sequelize da linha seguinte gruda no registro anterior
na coluna `sql`) e o nginx no docker: o embrulho JSON do Docker
(`{"log":"…","stream":…,"time":…}`) é aberto a cada linha, o acesso em
formato combined vira `ip`, `usuario`, `datahora` (fuso da linha descontado),
`metodo`, `rota`, `protocolo`, `status`, `bytes`, `referer` e `user_agent`,
o log de erro do `stderr` vira `severidade`, `pid`/`tid`, `conexao`,
`mensagem`, `ip` e `servidor`, e o registro ganha as colunas `stream` e
`time` do Docker. Linha sem carimbo entra como continuação da mensagem
anterior (rastro de pilha). O parser fica em `public/js/log-core.js`, módulo
puro compartilhado entre a página e o `node scripts/test-log-core.js`.
O dado é achatado automaticamente — objetos aninhados viram colunas `a.b.c`,
envelopes de API (`{ "data": [...] }`) abrem sozinhos, NDJSON (um objeto por
linha) vira um registro por linha e planilhas de várias abas ganham um seletor
que abre a maior por padrão. A primeira linha de rótulos vira cabeçalho; a
segunda "status" vira "status (2)".

Em cima disso há pesquisa global, ordenação por coluna (asc → desc → sem,
vazios sempre por último), menu de filtro por coluna com operadores de texto
(ou numérico, nas colunas do tipo número) e caixa de valores à la Excel
(busca + contagem por valor, aplicada ao fechar), colunas escondidas, paginação
e exportação do que está filtrado — Excel `.xlsx`, CSV (vírgula ou ponto e
vírgula, ambos com BOM para o Excel de pt-BR) e copiar para a área de
transferência como TSV. Nada sai do navegador.

## Salas compartilhadas

`/notas` e `/drive` são salas por link: quem tem a URL entra, ninguém precisa
de cadastro. As duas podem ser públicas ou privadas com senha — no criar, o
campo de senha já deixa a sala protegida, e quem abrir sem ela vê o pedido de
senha (nunca o conteúdo). A senha só trafega como hash SHA-256 misturado com o
id da sala, comparada em tempo constante; no navegador ela fica no
`sessionStorage` da aba, então sobrevive ao F5 e morre junto com a aba.

**Notas.** Um texto só para toda sala: quem digita vê o cursor e o texto
entrarem a cada pausa, e o que os outros escrevem chega pelo canal de
atualizações (SSE). Se você estiver no meio de uma frase quando o texto
remoto chegar, ele fica em espera e entra quando você soltar o foco — com um
aviso na tela. Dá para forçar o salvamento no desligar da aba (best-effort,
corpo pequeno) e abrir uma prévia opcional de markdown. O relógio conta da
**última edição** (ou da criação): entrar na sala e só olhar não reinicia
nada — quem está assistindo vê o prazo descer em tempo real em todas as abas,
e quando ele acaba a sala some e as abas abertas trocam para o painel de sala
expirada. Digitar de novo é que recomeça a contagem.

**Drive.** O envio vai no corpo cru da requisição (`octet-stream`), sem
multipart: a barra de progresso é medida de verdade, byte a byte. O limite por
arquivo (`DRIVE_MAX_MB`, padrão 25 MB) é lido do servidor e mostrado na tela;
acima dele a resposta é `413` antes de gravar qualquer coisa. O relógio de
vida de cada arquivo só começa quando o **upload termina**, e um download em
andamento segura a exclusão até a pessoa terminar de baixar (com uma trava de
segurança de mais um prazo cheio para downloads presos). A sala de drive em
si some depois do mesmo prazo sem uploads — ver a lista não renova. Os nomes
de arquivo nunca viram caminho: o servidor grava com um id aleatório e devolve
`Content-Disposition` com o nome real em UTF-8.

As duas páginas conversam com o servidor por **SSE** (`text/event-stream`),
sem dependência nova: o navegador abre o `EventSource` e o servidor empurra
`estado`, `relogio`, `texto`/`arquivo-novo`, `online` e `encerrada`. **O
relógio é do backend**: a cada volta do ping (25 s) o servidor reenvia o
prazo atual com o próprio `agora` — sem renová-lo, a renovação é só edição —,
então todas as abas contam a partir do mesmo número, mesmo com máquinas de
relógios descasados, a régua é a diferença `expiraEm - agora`. Quando a sala expira, o servidor avisa `encerrada` e a
página troca para o painel de "sala expirada"; se a conexão cair no meio e a
sala já tiver morrido, a reconexão leva `404` e o cliente re-pergunta ao
servidor — que também troca o painel, em vez de deixar a aba órfã contando
para um prazo morto.

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
| `POST` | `/api/html-pdf` | Recebe `{ html, title, pageSize, orientation, margins, printBackground, inline }` e devolve o PDF impresso pelo Chrome. Responde `503` com instruções quando não há navegador instalado. |
| `GET` | `/api/settings` | Devolve os padrões, presets, temas, tamanhos de página e fontes. |
| `GET` | `/api/library` | Lista os documentos salvos (sem o conteúdo). |
| `GET` | `/api/library/:id` | Devolve um documento completo. |
| `POST` | `/api/library` | Salva um documento: `{ title, content, kind, settings }`. |
| `DELETE` | `/api/library/:id` | Remove um documento. |
| `POST` | `/api/notas` | Cria uma sala de notas: `{ senha }` opcional → `{ id, privada }`. |
| `GET` | `/api/notas/:id` | Estado da sala: `{ id, texto, versao, online, expiraEm, maxTexto }`. Salas privadas respondem `401` sem senha (`precisaSenha`) e `403` com senha errada. |
| `POST` | `/api/notas/:id` | Salva o texto: `{ texto }` → `{ versao, expiraEm }`. Acima de 500 mil caracteres responde `413`. |
| `GET` | `/api/notas/:id/eventos` | Canal SSE da sala: eventos `estado`, `relogio` (o prazo atualizado, a cada ping), `texto`, `online` e `encerrada`. |
| `POST` | `/api/drive` | Cria uma sala de drive: `{ senha }` opcional → `{ id, privada, tamMaxBytes }`. |
| `GET` | `/api/drive/:id` | Estado da sala: `{ arquivos, tamMaxBytes, online, expiraEm }`. Mesmo tratamento de senha do `/api/notas/:id`. |
| `POST` | `/api/drive/:id/arquivos?nome=` | Envia o arquivo no corpo cru (`application/octet-stream`) → `201` com os metadados. Recusa com `413` acima do limite. |
| `GET` | `/api/drive/:id/arquivos/:fid` | Baixa o arquivo (e renova a janela de exclusão enquanto baixa). |
| `GET` | `/api/drive/:id/eventos` | Canal SSE da sala: `estado`, `relogio`, `arquivo-novo`, `arquivo-expirou`, `online` e `encerrada`. |

Salas privadas: envie a senha no cabeçalho `x-sala-senha` (ou na query
`?senha=` nas rotas que não têm corpo — eventos e downloads).

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
npm test              # integridade + formatação + renderização + matriz de PDF + html->pdf + salas + logs
npm run check         # encoding, chaves CSS e assets referenciados
npm run test:format   # núcleo de formatação (JSON, XML/HTML, Markdown, CSV, texto, código)
npm run test:render   # renderização e higienização
npm run test:pdf      # matriz de presets, temas, numeração e casos-limite
npm run test:html-pdf # montador de documento e impressão do conversor de HTML para PDF
npm run test:salas    # núcleo das salas: expiração, senha, limites, upload e download
npm run test:logs     # núcleo de logs de linha (com os exemplos reais) + página de logs (exige o servidor)
npm run test:api      # ponta a ponta (exige o servidor rodando)
npm run test:browser  # render real em Chrome/Edge headless (exige o servidor)
npm run test:logs:probe # sonda do /logs em Chrome/Edge headless (exige o servidor)
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
aparece no `curl`. O mesmo harness abre o `/html-pdf`, cola um HTML na tela
dividida, confere a prévia no iframe e clica em *Gerar PDF* — o download é
interceptado na âncora, como no `/pdf`. Se faltar o Chrome ou o Edge, ele é
pulado em vez de falhar.

O `test:salas` é unitário e não precisa de servidor: cobre o núcleo de
`src/lib/salas.js` — expiração por inatividade e renovação do relógio, hash
de senha, teto de texto (`413`) e de salas (`429`), upload interrompido sem
resíduo no disco e download segurando a exclusão do arquivo. A sonda estende
isso no navegador: `/notas` e `/drive` são conferidas em tempo real (o SSE
aberto vive esperando dentro do `--dump-dom` de orçamento virtual, então essas
salas usam o helper CDP com predicado próprio), uma sala privada para no
pedido de senha sem entregar o editor, a sala semeada mostra o texto e o
arquivo enviado, e um quadro com duas cópias da mesma sala prova que o que um
digita chega no outro.

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