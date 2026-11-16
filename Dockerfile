# syntax=docker/dockerfile:1
#
# dogfight — багатоетапна збірка (Лаба 8).
#   docker build -t dogfight --build-arg APP_VERSION=$(git describe --tags --always) .
#   docker run --init -p 8080:8080 dogfight
#
# Етап 1 (build): повний workspace + dev-залежності (Vite, TypeScript) → client/dist.
# Етап 2 (runtime): лише production-залежності, server/src + shared/src (.ts виконує сам Node —
# вбудоване зрізання типів, без tsc і tsx) і зібраний client/dist. Без Vite, TS, тестів, .git.

ARG NODE_IMAGE=node:22-alpine

# ---------- 1. build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Спершу ЛИШЕ маніфести: шар з npm ci кешується, поки не змінились залежності
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --ignore-scripts --no-audit --no-fund
# Тепер код (зміна одного рядка не інвалідує шар з node_modules)
COPY tsconfig.base.json ./
COPY shared shared
COPY client client
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
# Render передає свої змінні як build-arg лише для оголошених ARG — SHA коміту для HUD клієнта
ARG RENDER_GIT_COMMIT=
ENV RENDER_GIT_COMMIT=${RENDER_GIT_COMMIT}
RUN npm run build -w client

# ---------- 2. production deps ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace server --include-workspace-root=false \
 && npm cache clean --force

# ---------- 3. runtime ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    LOG_DIR=/data/logs
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node shared/package.json shared/
COPY --chown=node:node shared/src shared/src
COPY --chown=node:node server/package.json server/
COPY --chown=node:node server/src server/src
COPY --from=build --chown=node:node /app/client/dist client/dist
RUN mkdir -p /data/logs && chown -R node:node /data
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
# Не root: процес гри не має права писати ніде, крім /data
USER node
EXPOSE 8080
# Liveness: /health відповідає → процес живий. Node замість curl/wget — нічого не доставляємо.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# exec-форма: PID 1 — сам node, SIGTERM від `docker stop` доходить до нашого обробника.
# (`CMD npm start` → PID 1 = npm/sh, сигнал не передається, через 10 с — SIGKILL.)
CMD ["node", "server/src/index.ts"]
