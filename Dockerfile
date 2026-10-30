# ---------------------------------------------------------------------------
# parche — multi-stage Dockerfile
# Base: node:22-bookworm-slim (glibc; required for better-sqlite3 prebuilds)
# pnpm is enabled via corepack (matches packageManager in package.json)
# ---------------------------------------------------------------------------

# ---- base ----
FROM node:22-bookworm-slim AS base
# Never prompt to download pnpm (builds have no TTY; keep it explicit).
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---- build ----
FROM base AS build
# Copy manifests first for layer-cache efficiency
COPY package.json pnpm-lock.yaml ./
# Install all deps (dev + prod) — includes tsup, tsx, tsc, biome
RUN pnpm install --frozen-lockfile
# Copy source and config files
COPY src ./src
COPY web ./web
COPY tsconfig.json tsup.config.ts drizzle.config.ts biome.json ./
# Build: typecheck + vite SPA build + tsup bundle + copies migrations/web to dist/
RUN pnpm build

# ---- prod-deps ----
# Install only production deps on the same base so the native better-sqlite3
# binary is ABI-compatible with the runtime stage.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ---- runtime (final) ----
FROM base AS runtime
# Copy production node_modules (includes the compiled better-sqlite3 binding)
COPY --from=prod-deps /app/node_modules ./node_modules
# Copy built output: main.js, admin-cli.js, migrations/
COPY --from=build /app/dist ./dist
# package.json is read at runtime by version.ts (readFileSync package.json)
COPY package.json ./

# Default environment — docker-compose.yml overrides HOST and PARCHE_DATA_DIR
# via `environment:` which takes precedence over both ENV and env_file.
ENV HOST=0.0.0.0 \
    PARCHE_DATA_DIR=/data \
    NODE_ENV=production

# Create the data directory and give ownership to the node user (uid 1000)
RUN mkdir -p /data && chown node:node /data

# Run as non-root
USER node

EXPOSE 8787

# HEALTHCHECK uses Node 22's built-in fetch — no curl required in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
