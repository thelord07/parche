# parche

**parche** is the sync server for chamba's collective vault. Groups share an Obsidian-compatible vault; `@chamba/mcp` clients push and pull blobs through this server.

> **WARNING: No authentication.** The blob endpoints (`/api/blob/*`) have no auth yet. Do **not** expose this server publicly until authentication is added (a future ticket).

## Stack

- Node 22, TypeScript 5.6, ESM
- Fastify 5
- zod 3
- pnpm

## Running locally

```bash
cp .env.example .env
# Edit .env as needed
pnpm install
pnpm dev           # tsx watch — auto-restarts on change
```

Or with the built output:

```bash
pnpm build
pnpm start
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Host to bind to |
| `PARCHE_DATA_DIR` | `./data` | Directory where blobs are stored |
| `PARCHE_MAX_BLOB_BYTES` | `20971520` | Maximum blob size (20 MiB) |
| `PARCHE_LOG_LEVEL` | `info` | Pino log level: `fatal\|error\|warn\|info\|debug\|trace\|silent` |

Invalid values cause the process to exit with a non-zero code and a message naming the variable.

## API

### `GET /health`

```json
{ "status": "ok", "version": "0.1.0" }
```

### `PUT /api/blob/:hash`

Store a blob. The `hash` must be a lowercase hex sha256 of the body.

- `201` — blob stored successfully
- `200` — blob already existed (idempotent)
- `400` — invalid hash or body sha256 does not match
- `413` — body exceeds `PARCHE_MAX_BLOB_BYTES`

**Every PUT verifies the sha256 of the body**, even if the blob already exists.

### `GET /api/blob/:hash`

Retrieve a stored blob.

- `200 application/octet-stream` — the blob bytes
- `404` — not found
- `400` — invalid hash

### `HEAD /api/blob/:hash`

Check existence (same status codes as GET, no body).

## Tests

```bash
pnpm test
```

Tests use `app.inject()` — no port binding required. Each test creates a fresh temporary `PARCHE_DATA_DIR`.

## Lint and build

```bash
pnpm lint          # biome check
pnpm lint:write    # biome check --write (auto-fix)
pnpm typecheck     # tsc --noEmit
pnpm build         # typecheck + tsup
```

## Blob storage layout

Blobs are stored content-addressed under `<PARCHE_DATA_DIR>/blobs/`:

```
data/blobs/ab/cd/<full-sha256-hash>
```

**parche never removes blobs.** This is intentional: the vault's history is append-only.
