# syntax=docker/dockerfile:1

# Dokploy build target: build from the repository root.
# Runtime data (SQLite) must be mounted at /app/data, otherwise the data dies
# with the container.

# Stage 1: install the workspace and build the React app.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci
RUN npm --workspace @balanza/web run build

# Stage 2: runtime. The API is dependency-free and imports the workspace
# packages by relative path, so no node_modules is needed here.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY apps ./apps
COPY packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist

RUN mkdir -p /app/data && chown -R node:node /app

ENV PORT=8080 \
    DB_PATH=/app/data/balanzaweb.db \
    WEB_DIR=/app/apps/web/dist \
    TRUST_PROXY=1

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:${PORT}/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/api/src/index.js"]
