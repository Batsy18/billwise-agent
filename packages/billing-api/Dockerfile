# billing-api image for Cloud Run. Build from the repo root:
#   docker build --platform linux/amd64 -f packages/billing-api/Dockerfile -t billing-api .
# Config comes from env vars (Cloud Run: Secret Manager); no .env is copied into the image.

# --- 1. build: all deps (incl. dev), prisma generate, tsc ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
# Every workspace manifest: npm ci checks them against the lockfile.
COPY packages/billing-api/package.json packages/billing-api/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN npm ci --ignore-scripts --workspace=@billwise/billing-api --include-workspace-root
COPY packages/billing-api packages/billing-api
RUN npm run prisma:generate -w @billwise/billing-api \
 && npm run build -w @billwise/billing-api

# --- 2. production dependencies only ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/billing-api/package.json packages/billing-api/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
# --ignore-scripts: skips the postinstall `prisma generate` (prisma CLI is a dev dep; the
# client is already compiled into dist/generated). bcrypt loads its bundled prebuild.
# --omit=optional: @prisma/client lists the prisma CLI + typescript as optional peers, which npm
# marks devOptional and would otherwise install (~430 MB with their deps; not used at runtime).
RUN mkdir -p packages/billing-api/node_modules \
 && npm ci --omit=dev --omit=optional --ignore-scripts --workspace=@billwise/billing-api \
 && npm cache clean --force

# --- 3. runtime ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/billing-api/node_modules packages/billing-api/node_modules
COPY packages/billing-api/package.json packages/billing-api/
COPY --from=build /app/packages/billing-api/dist packages/billing-api/dist
# Swagger UI is served from the repo-root docs/openapi.yaml (same relative path as in the repo).
COPY docs/openapi.yaml docs/openapi.yaml
USER node
# Cloud Run sets PORT (8080); the app reads it.
EXPOSE 8080
ENV PORT=8080
CMD ["node", "packages/billing-api/dist/index.js"]
