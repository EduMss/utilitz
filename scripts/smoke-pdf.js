'use strict';

/**
 * Gera um PDF de exemplo com todos os recursos suportados.
 * Uso: node scripts/smoke-pdf.js [destino]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderPdf } = require('../src/lib/pdf');
const shared = require('../public/js/shared-settings.js');

const SAMPLE = `---
title: Relatório de Teste
author: Equipe Markdown Studio
---

# Introdução

Este parágrafo contém **negrito**, *itálico*, ***ambos***, \`código inline\`,
~~riscado~~ e um [link](https://example.com). Texto com acentuação: ação,
corações, informações, órfãos, avô.

Segundo parágrafo com recuo e justificação automática do texto para conferir
se a quebra de linha está funcionando corretamente mesmo em textos mais
longos e com muitas palavras diferentes.

## Lista de tarefas

- Primeiro item
- Segundo item
  - Item aninhado
  - Outro item aninhado
- Terceiro item

1. Ordenado um
2. Ordenado dois
   1. Sub-ordem
   2. Outra sub-ordem
3. Ordenado três

## Citação

> Uma citação em bloco, com **formatação** e um
> link [de referência](https://example.com).

## Código

\`\`\`javascript
function somar(a, b) {
  // Comentário de linha
  return a + b; /* comentário de bloco */
}

const lista = [1, 2, 3].map((n) => n * 2);
console.log("Olá", \`template\`, lista);
\`\`\`

\`\`\`python
def saudacao(nome: str) -> str:
    """Retorna uma saudação."""
    return f"Olá, {nome}!"
\`\`\`

## Tabela

| Recurso | Status | Observação |
|:--------|:------:|-----------:|
| Títulos | ok | h1 até h6 |
| Listas | ok | aninhadas |
| Tabelas | ok | com alinhamento |
| Código | ok | realce de sintaxe |
| Imagens | ok | remotas e locais |

## Página quebrada

${Array.from({ length: 22 }, (_, i) => `Parágrafo ${i + 1} para forçar a quebra de página e validar o cabeçalho, o rodapé e a numeração.`).join('\n\n')}
`;

async function main() {
  // por padrão gera na pasta temporária do sistema, para não sujar o projeto
  const target = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'markdown-studio-exemplo.pdf'));
  const settings = Object.assign(shared.applyPreset('relatorio'), {
    showToc: true,
    tocDepth: 3,
    pageNumbers: true,
    runningTitle: 'Relatório de Teste',
  });

  const started = Date.now();
  const buffer = await renderPdf(SAMPLE, settings, { fallbackName: 'exemplo' });
  fs.writeFileSync(target, buffer);

  console.log('PDF gerado em ' + target);
  console.log('Tamanho: ' + (buffer.length / 1024).toFixed(1) + ' KB');
  console.log('Tempo:   ' + (Date.now() - started) + ' ms');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});