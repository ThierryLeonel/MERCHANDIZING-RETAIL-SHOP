# API + worker image (not built in the development session — no Docker daemon was available there).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && PRISMA_SCHEMA_ENGINE_BINARY=/bin/true pnpm db:generate \
 && pnpm --filter @retail/api-contracts build && pnpm --filter @retail/db build && pnpm --filter @retail/api build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
