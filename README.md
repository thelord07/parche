# parche

**parche** is the sync server for chamba's collective vault. Groups share an Obsidian-compatible vault; `@chamba/mcp` clients push and pull blobs through this server.

## Stack

- Node 22, TypeScript 5.6, ESM
- Fastify 5 with pino logger (redacts Bearer tokens and deviceToken)
- @chamba/core ^1.7.0 (shared schemas, `can()`, `isSyncable()`, `pathKey()`)
- better-sqlite3 v11 (synchronous, WAL mode)
- drizzle-orm (sync transactions)
- @fastify/rate-limit ^11 (per-route, join endpoint only)
- zod 3 (env validation)
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
| `PARCHE_DATA_DIR` | `./data` | Directory for blobs and database |
| `PARCHE_MAX_BLOB_BYTES` | `20971520` | Maximum blob size (20 MiB) |
| `PARCHE_LOG_LEVEL` | `info` | Pino log level: `fatal\|error\|warn\|info\|debug\|trace\|silent` |

Invalid values cause the process to exit with a non-zero code and a message naming the variable.

## Data model

The SQLite database (`<PARCHE_DATA_DIR>/parche.db`, WAL mode) has 8 tables:

| Table | Description |
|---|---|
| `users` | User accounts (id, name, email) |
| `groups` | Sync groups (id, slug, name, seq_counter) |
| `members` | Group membership (group_id, user_id, role, removed_at) |
| `devices` | Authenticated devices (id, user_id, group_id, token_hash, revoked_at) |
| `invites` | Invite codes (id, group_id, code_hash, role, expires_at, max_uses, uses) |
| `files` | Current file state (group_id, path, path_key, head_hash, head_seq) |
| `changes` | Append-only change log (group_id, seq, path, hash, user_id, device_id) |
| `blob_refs` | Scopes blob access per group (group_id, hash) |

**Revocation is always UPDATE** — tokens use `revoked_at`, members use `removed_at`, deleted files use a tombstone hash (`null` head_hash). Nothing is ever physically deleted from the database.

## Authentication

All API routes except `/health` and `POST /api/join` require a Bearer token:

```
Authorization: Bearer pch_<base62>
```

Tokens are issued by `POST /api/join`. The server stores only the SHA-256 hash of each token. The plain token is returned once at join time and never stored.

**Token validation**: the server looks up the token hash, checks `revoked_at IS NULL` on the device, and checks `removed_at IS NULL` on the member. For group-scoped routes (`/api/g/:slug/*`), the token's group slug must match the URL slug.

## Admin CLI

```bash
node dist/admin-cli.js create-group --name "My Group" --slug my-group \
  --owner-name "Alice" --owner-email alice@example.com

node dist/admin-cli.js create-invite --group my-group --role editor

node dist/admin-cli.js list-members --group my-group

node dist/admin-cli.js revoke-device --device-id <id>

node dist/admin-cli.js revoke-invite --group my-group --code XXXX-XXXX

node dist/admin-cli.js create-device --group my-group --email alice@example.com
```

All commands read `PARCHE_DATA_DIR` (or `--data-dir`) to find the database.

## API

### `GET /health`

No auth required.

```json
{ "status": "ok", "version": "1.7.0" }
```

### `POST /api/join`

Rate-limited (default 10 req/minute per IP). No auth required.

```json
{ "code": "XXXX-XXXX", "name": "Alice", "email": "alice@example.com" }
```

Response `200`:
```json
{
  "group": { "id": "...", "slug": "my-group", "name": "My Group" },
  "role": "editor",
  "user": { "id": "...", "name": "Alice" },
  "deviceToken": "pch_..."
}
```

- `404` — invalid, revoked, expired, or exhausted invite code
- `409` — already an active member of this group
- `429` — rate limited

### `GET /api/g/:slug/changes`

Auth required (`can('read')`).

Query params: `since` (seq, default 0), `limit` (1–1000, default 500).

```json
{
  "protocol": 1,
  "changes": [
    { "seq": 1, "path": "note.md", "hash": "<sha256|null>", "author": "Alice", "device": "laptop" }
  ],
  "hasMore": false,
  "cursor": 1
}
```

### `POST /api/g/:slug/push`

Auth required (`can('write')`).

```json
{
  "changes": [
    { "path": "note.md", "expectedHash": "<sha256|null>", "newHash": "<sha256|null>" }
  ]
}
```

Response `200`:
```json
{
  "results": [
    { "path": "note.md", "outcome": "ok", "seq": 5 }
  ]
}
```

Outcomes: `ok` | `conflict` | `error`.

- `400` — invalid body or unsyncable path (`.obsidian/`, `.git/`)
- `409` — case collision (two paths with same case-folded key in one push)
- `422` — blob not uploaded (push references a hash not in storage)

### `PUT /api/blob/:hash`

Auth required.

Store a blob. The `hash` must be the lowercase hex SHA-256 of the body. The blob is scoped to the token's group via `blob_refs`.

- `201` — stored
- `200` — already existed (idempotent)
- `400` — invalid hash or SHA-256 mismatch
- `413` — body exceeds `PARCHE_MAX_BLOB_BYTES`

### `GET /api/blob/:hash`

Auth required. Returns blob only if the token's group has a `blob_refs` entry for it.

- `200 application/octet-stream`
- `404` — not found or not accessible by this group
- `400` — invalid hash

### `HEAD /api/blob/:hash`

Same as GET, no body.

## Blob storage layout

Blobs are stored content-addressed under `<PARCHE_DATA_DIR>/blobs/`:

```
<PARCHE_DATA_DIR>/blobs/ab/cd/<full-sha256-hash>
<PARCHE_DATA_DIR>/parche.db   (WAL mode)
<PARCHE_DATA_DIR>/parche.db-wal
<PARCHE_DATA_DIR>/parche.db-shm
```

**parche never removes blobs.** The vault's history is append-only. Deleted files are represented as tombstones (`head_hash = null`) in the `files` table.

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
