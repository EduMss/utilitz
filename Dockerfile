# syntax=docker/dockerfile:1

# ------------------------------------------------------------------ *
# Dependências
# ------------------------------------------------------------------ *
# Estágio separado para que o `npm ci` só seja refeito quando o
# lockfile muda. Todas as libs estão em "dependencies" (não há
# devDependencies), então `--omit=dev` não deixa nada de fora.
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ------------------------------------------------------------------ *
# Runtime
# ------------------------------------------------------------------ *
FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data

# data/ guarda a biblioteca (biblioteca.json) e as fontes baixadas do Google
# Fonts em tempo de execução (src/lib/fonts.js). O dono precisa ser o usuário
# node: o volume nomeado do compose é criado a partir deste caminho e herda
# essa titularidade, então o servidor sobe sem privilégio e ainda escreve.
RUN chown -R node:node /app/data

USER node

EXPOSE 3000

# `PORT` é lido no runtime para respeitar a variável de ambiente. /api/settings
# é o endpoint mais barato que responde 200 sem renderizar PDF nem tocar a rede.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/settings" || exit 1

CMD ["node", "server.js"]
