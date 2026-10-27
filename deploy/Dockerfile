# Alternative image for a bare VPS without Dokploy. Dokploy builds /Dockerfile.
# syntax=docker/dockerfile:1

# Stage 1: install the workspace and build the React app.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci
RUN npm run build:web

# Stage 2: runtime. The API has no runtime dependencies, but it imports the
# workspace packages, so node_modules from the install stage is kept as-is.
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

EXPOSE 8080
CMD ["node", "apps/api/src/index.js"]
