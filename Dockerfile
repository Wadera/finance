# Multi-stage hardened build for Skyday Finance & Budget
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/db /data/attachments /data/backups \
  && chown -R node:node /data

WORKDIR /app
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    HOST=0.0.0.0 \
    PORT=3020 \
    DATA_DIR=/data

EXPOSE 3020
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3020/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/server/index.js"]
