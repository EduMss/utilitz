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

## Páginas

| Rota | O que faz |
| --- | --- |
| `/` | Página inicial: atalhos, exemplos e biblioteca de documentos salvos. |
| `/visualizar` | Visualizador em tela cheia. Editor e sumário guardam o texto em uma gaveta para deixar a leitura limpia. |
| `/pdf` | Conversor com tela dividida e painel de configurações. |

As duas ferramentas são de tela cheia e por isso não repetem a barra de
navegação do site. Para não ficarem sem identidade, cada uma mostra a marca
`M↓` no canto: no visualizador ela fica na barra flutuante, no conversor na
barra do editor, e as duas levam de volta para `/`.

O texto escrito na página inicial segue para a ferramenta escolhida. A passagem
é feita por uma chave de uso único (`md:handoff`), separada do rascunho de cada
página, para o título não se misturar ao texto salvo.

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

## Como funciona

O HTML é gerado **no servidor** por `src/lib/markdown.js` (markdown-it + highlight.js) e higienizado antes de voltar ao navegador. O visualizador e a pré-visualização do PDF consomem exatamente o mesmo HTML, então os dois modos nunca divergem.

O PDF é montado no servidor por `src/lib/pdf.js`, que percorre os tokens do Markdown e desenha cada bloco com PDFKit usando fontes padrão (Helvetica, Times e Courier). A pré-visualização usa o Paged.js para paginar o mesmo CSS no navegador — é por isso que ela reflete quebra de página, cabeçalho, rodapé e sumário reais. Usamos o bundle `public/vendor/paged.js` (e não o `paged.polyfill`): o polyfill se auto-executa e consome as folhas de estilo do documento, o que quebraria o layout da página.

As configurações vivem em um único arquivo, `public/js/shared-settings.js`, carregado tanto pelo Node quanto pelo navegador. Isso evita que servidor e cliente se desalinham.

```
server.js              bootstrap do Express
src/lib/markdown.js    Markdown -> HTML (+ higienização)
src/lib/pdf.js         Markdown -> PDF (PDFKit)
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
npm test              # integridade + renderização + matriz completa de PDF
npm run check         # encoding, chaves CSS e assets referenciados
npm run test:render   # renderização e higienização
npm run test:pdf      # matriz de presets, temas, numeração e casos-limite
npm run test:api      # ponta a ponta (exige o servidor rodando)
npm run test:browser  # render real em Chrome/Edge headless (exige o servidor)
npm run smoke         # gera um PDF de exemplo com todos os recursos
```

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

## Testes

```bash

**Conversor para PDF**

| Atalho | Ação |
| --- | --- |
| `Ctrl+B` / `Ctrl+I` | Negrito / itálico (dentro do editor) |
| `Ctrl+S` | Baixar o PDF |
| `G` | Abrir as configurações |
| `Esc` | Fechar as configurações |

## Licença

MIT