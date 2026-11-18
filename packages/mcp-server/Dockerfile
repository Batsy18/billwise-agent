# mcp-server image for Cloud Run (Streamable HTTP, POST /mcp). Build from the repo root:
#   docker build --platform linux/amd64 -f packages/mcp-server/Dockerfile -t mcp-server .
# MCP_API_KEY comes from env vars (Cloud Run: Secret Manager); no .env is copied.

# --- 1. build: all deps, tsc + build-index (search index baked into the image) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/billing-api/package.json packages/billing-api/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN npm ci --ignore-scripts --workspace=@billwise/mcp-server --include-workspace-root
COPY packages/mcp-server packages/mcp-server
RUN npm run build -w @billwise/mcp-server

# --- 2. production dependencies only ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/billing-api/package.json packages/billing-api/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN mkdir -p packages/mcp-server/node_modules \
 && npm ci --omit=dev --ignore-scripts --workspace=@billwise/mcp-server \
 && npm cache clean --force

# --- 3. runtime ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/mcp-server/node_modules packages/mcp-server/node_modules
COPY packages/mcp-server/package.json packages/mcp-server/
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
COPY --from=build /app/packages/mcp-server/generated packages/mcp-server/generated
# The guide itself: the server checks the index's sha256 against it at startup.
COPY packages/mcp-server/data packages/mcp-server/data
USER node
EXPOSE 8080
ENV MCP_PORT=8080
CMD ["node", "packages/mcp-server/dist/http.js"]
