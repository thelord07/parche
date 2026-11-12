# parche

**parche** is the sync server for chamba's collective vault. Groups share an Obsidian-compatible vault; `@chamba/mcp` clients push and pull blobs through this server.

## Stack

- Node 22, TypeScript 5.6, ESM
- Fastify 5 with pino logger (redacts Bearer tokens and deviceToken)
- @chamba/core ^1.15.0 (shared schemas, `can()`, `isSyncable()`, `pathKey()`, `scanText()`/`isScannable()` secret scanner)
- better-sqlite3 v11 (synchronous, WAL mode)
- drizzle-orm (sync transactions)
- @fastify/rate-limit ^11 (per-route, join endpoint only)
- zod 3 (env validation)
- pnpm

## Running locally

```bash
cp .env.example .env
# Edit .env as needed (PARCHE_SMTP_URL is required to start the server)
pnpm install
docker compose -f docker-compose.dev.yml up -d   # Mailpit: SMTP 127.0.0.1:1025, inbox http://127.0.0.1:8025
pnpm dev           # tsx watch — auto-restarts on change
pnpm dev:web       # Vite dev server for the web app (proxies /api to :8787)
```

The server never prints magic links: in development every sign-in email lands in
the Mailpit inbox at http://127.0.0.1:8025 (`PARCHE_SMTP_URL=smtp://127.0.0.1:1025`).
The admin CLI (`pnpm admin …`, `node dist/admin-cli.js …`) does **not** need SMTP.

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
| `PARCHE_TRUST_PROXY` | `` (empty) | Comma-separated IPs/CIDRs to trust for `X-Forwarded-For` (see Deploy) |
| `PARCHE_SMTP_URL` | — (**required** to start the server) | `smtp://` or `smtps://` URL used to send sign-in links. Dev: `smtp://127.0.0.1:1025` (Mailpit) |
| `PARCHE_PUBLIC_URL` | — (**required in production**) | Public base URL (e.g. `https://parche.chamba.tools`); sign-in links are built from it, never from the `Host` header |
| `PARCHE_MAIL_FROM` | `parche@<host of PARCHE_PUBLIC_URL>` | Sender address of sign-in emails |
| `PARCHE_CREATORS` | `` (empty) | Comma-separated emails allowed to create parches from the web (case-insensitive) |
| `PARCHE_SECRET_GATE` | `report` | `report\|block` — secret-scan gate on `PUT /api/blob/:hash`. See [Secret scanning](#secret-scanning) |

Invalid values cause the process to exit with a non-zero code and a message naming the variable.

## Web app

The same server serves a small single-page app (Vite + React, source in `web/`,
built into `dist/web`) on the same domain:

| Route | What it does |
|---|---|
| `/entrar` | Ask for a sign-in link by email ("Revisa tu correo") |
| `/auth` | Shows an **Entrar** button; the link is only consumed when it is pressed (mail scanners that open the link do not burn it) |
| `/` | Your parches, or the empty state |
| `/nuevo` | Create a parche (only emails in `PARCHE_CREATORS`) |
| `/g/:slug/invitar` | Create invitations (the code is shown once), list them masked, revoke them |
| `/j/:code` | Join instructions: the `npx @chamba/mcp@latest vault join <code>` command |

### Web app — parte 2 (PARCHE-007)

Group members also get a read-only view of the vault via the web app.
All routes below require an authenticated session cookie (`parche_session`) and
active group membership — otherwise `401` (no session) or `404`
(not a member / group not found).

**Session API** (`/api/web/g/:slug/`):

| Endpoint | Description |
|---|---|
| `GET /summary` | Group metadata: name, slug, member count, file count, last-change date |
| `GET /tree` | Full tree of live `.md` files — path, title, updated-at |
| `GET /activity` | Paginated change log with author + device labels |
| `GET /note?path=…` | Rendered note: sanitized HTML (`SanitizedHtml` branded type), frontmatter metadata, change history, backlinks with context snippets |
| `GET /note/version?path=…&seq=…` | Specific historical version of a note |
| `GET /diff?path=…&from=…&to=…` | Line diff between two versions (`pairLineDiff`: `eq`/`add`/`del`/`mod`) |
| `GET /raw?path=…` | Raw blob (never `text/html`; `.svg`/`.pdf` served as `attachment`) |
| `GET /conflicts` | All live conflict copies for the group |
| `GET /conflicts/view?path=…` | Conflict detail: conflict copy + base + current |
| `GET /topics` | All unique frontmatter tags used in the group |
| `GET /topics/:tag` | Notes tagged with `:tag` |
| `GET /members` | Active members list with devices and last-sync timestamp |
| `POST /members/:userId/role` | Change a member's role (CSRF required) |
| `POST /members/:userId/remove` | Remove a member; revokes all their devices (CSRF required) |
| `POST /devices/:deviceId/revoke` | Revoke a device; cuts its sync access immediately (CSRF required) |

#### Members and devices — permission matrix

All mutation endpoints require `Content-Type: application/json` and `X-Parche-CSRF: 1`.

**Change role** (target ∈ `{admin, editor, reader}`; `owner` as target → 400 `invalid_role`):

| actor \ target | owner | admin | editor | reader | self (owner) |
|---|---|---|---|---|---|
| **owner** | 409 `last_owner` | ✓ | ✓ | ✓ | 409 `last_owner` |
| **admin** | 403 | ✓ | ✓ | ✓ | ✓ (can demote) |
| **editor** | 403 | 403 | 403 | 403 | 403 |
| **reader** | 403 | 403 | 403 | 403 | 403 |

**Remove member** (also revokes all their active devices in a single transaction):

| actor \ target | owner | admin | editor | reader | self (owner) |
|---|---|---|---|---|---|
| **owner** | 409 `last_owner` | ✓ | ✓ | ✓ | 409 `last_owner` |
| **admin** | 403 | ✓ | ✓ | ✓ | ✓ |
| **editor** | 403 | 403 | 403 | 403 | 403 |
| **reader** | 403 | 403 | 403 | 403 | 403 |

**Revoke device** (device owner's role determines permission; self-revoke always allowed):

| actor \ device owner | owner | admin | editor | reader | self (own device) |
|---|---|---|---|---|---|
| **owner** | ✓ | ✓ | ✓ | ✓ | ✓ |
| **admin** | 403 | ✓ | ✓ | ✓ | ✓ |
| **editor** | 403 | 403 | 403 | 403 | ✓ |
| **reader** | 403 | 403 | 403 | 403 | ✓ |

**Email visibility rule**: only `owner` and `admin` receive other members' email addresses. `editor` and `reader` only see their own email (omitted from other members' rows, never sent as empty string). Applies to `GET /members`, `GET /summary`, `GET /activity`, and `GET /note`. The viewer's own email is always visible.

**Invariant**: revoking and removing are always `UPDATE`; nothing is ever physically deleted.

**Backlink matching** in `/note` uses suffix resolution: `[[README]]` is considered a backlink from any `*/README.md` in the vault. This is intentionally lax — it avoids requiring full paths in wikilinks at the cost of occasional false positives in vaults with identically named files in different folders.

**Rate limits**: read endpoints 300 req/min; `/raw` 600 req/min (keyed by session cookie).

**Security headers** on every `text/html` response:
- `Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
- `X-Content-Type-Options: nosniff`

**XSS gate (O1)**: Markdown is rendered server-side with `markdown-it` (`html: false`)
and then sanitized with `sanitize-html` (explicit allowlist — no `style`, no `on*`
attributes, only `http`/`https`/`mailto` href schemes). The output is wrapped in a
`SanitizedHtml` branded type (produced only by `renderNote`). In the SPA,
`dangerouslySetInnerHTML` is used exclusively in `note-article.tsx` and only receives
that branded type from `api.getNote`. A static-scan test enforces this invariant.

**`file_meta` table**: background backfill processes all live `.md` files on startup,
extracting title, summary, tags, work_item, project, conflict metadata, and wikilinks.
Each blob is parsed at most once (idempotent: skips if `file_meta.hash == files.head_hash`).
A post-push hook also updates `file_meta` for newly pushed `.md` files in the background
(fire-and-forget, never blocks or fails the push response).

**Admin command**:

```bash
node dist/admin-cli.js reindex-meta --group <slug>
```

Re-indexes all `file_meta` rows from blobs (useful after import or recovery).

### QA seed — `scripts/seed-cya.ts`

A comprehensive fixture for QA and local development. Seeds the `cya` group with
~50 `.md` notes across folders (`auth/`, `db/`, `decisiones/`, `infra/`, `onboarding/`,
`api/`, `security/`), including:

- Wikilinks and backlinks (several notes link to `[[flujo-login]]`)
- Multiple versions of `auth/flujo-login.md` (3 versions from 3 different users/devices at different times — tests activity grouping by day)
- A conflict copy `auth/flujo-login (conflicto vale).md` with `conflict_of`/`conflict_base` frontmatter
- Tags `tema/auth`, `tema/db`, `tema/infra`, etc. on many notes
- `project` and `work_item` frontmatter on several notes
- A note with XSS payloads (`<script>`, `<img onerror>`, `javascript:` link, `<svg onload>`) for sanitizer validation
- An image PNG embed (`![[diagrama.png]]`) in `api/arquitectura.md`
- A rename pair (tombstone `auth/draft-old.md` + create `auth/draft.md` with same hash and same user+device+at)

The seed creates the user `qa@parche.test` as group owner (plus Ana, Beto, Carmen as members).
It is **idempotent** — safe to run multiple times; never deletes any data.

```bash
# First run:
PARCHE_DATA_DIR=./data-qa pnpm seed:qa
# or equivalently:
PARCHE_DATA_DIR=./data-qa pnpm tsx scripts/seed-cya.ts

# Subsequent runs are no-ops (all files already exist):
PARCHE_DATA_DIR=./data-qa pnpm seed:qa
```

After seeding, start the server to populate `file_meta` via the backfill:

```bash
PARCHE_DATA_DIR=./data-qa pnpm start
```

The backfill runs on startup and populates `file_meta` for all live `.md` files.
Monitor progress via `GET /health` (`metaBackfill: "running" | "done"`).

**Magic link security**: the token is placed in the URL **fragment** (`/auth#<token>`),
not in the path. Browsers never transmit fragments to the server, so the token never
appears in Fastify's request logs or in nginx's `access.log`. The server only sees
`GET /auth`; the SPA reads the fragment with `window.location.hash` and immediately
calls `history.replaceState` to clear it from the address bar. This prevents the token
from leaking via `Referer` headers, copy-paste, or browser history. The server also sets
`Referrer-Policy: no-referrer` on `/auth` and `/j/*` as a defence-in-depth measure.

The web API lives under `/api/web/*`: session cookie `parche_session` (HttpOnly,
SameSite=Lax, Secure in production) and every mutation requires
`Content-Type: application/json` plus the header `X-Parche-CSRF: 1`. Magic-link
tokens, session secrets and invitation codes are stored hashed only and are never
logged. Unknown `/api/*` paths keep answering `404` JSON; other GET paths fall back
to the SPA.

## Data model

The SQLite database (`<PARCHE_DATA_DIR>/parche.db`, WAL mode) has 9 tables:

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
| `file_meta` | Extracted metadata per live .md file: title, summary, tags, work_item, project, conflict info, wikilinks |

**Revocation is always UPDATE** — tokens use `revoked_at`, members use `removed_at`, deleted files use a tombstone hash (`null` head_hash). Nothing is ever physically deleted from the database.

### Migrations

Generate migrations **only** with `pnpm drizzle-kit generate` and never edit `when` in `src/db/migrations/meta/_journal.json` by hand. Drizzle applies a migration only if its `when` is greater than the newest one recorded in `__drizzle_migrations`; a migration with an older `when` is silently skipped on existing databases (PARCHE-007A-HOTFIX: `0002_add_file_meta` shipped with a `when` older than `0001`, so production never got `file_meta`). `src/db/migrate.test.ts` fails CI if the `when` values are not strictly increasing.

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

node dist/admin-cli.js reindex-meta --group my-group
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

Auth required (`can('write')`, otherwise `403`). Body is `pushRequestSchema` from `@chamba/core`:

```json
{
  "protocol": 1,
  "changes": [
    { "path": "note.md", "baseHash": "<sha256|null>", "newHash": "<sha256|null>" }
  ]
}
```

Entries are applied **in the order received**, in one transaction. Response `200` (`pushResponseSchema`):
```json
{
  "results": [
    { "status": "ok", "path": "note.md", "seq": 5 },
    { "status": "conflict", "path": "other.md", "currentHash": "<sha256|null>" }
  ]
}
```

Per entry: `newHash === head` → `ok` with the current `seq` (idempotent retry, no new change); `baseHash === head` → new `seq`; otherwise → `conflict` with the current head. `newHash: null` is a delete (tombstone).

Whole-request errors (nothing is applied):
- `400` — invalid body, or a path that is not syncable (`.obsidian/`, `x.exe`, …)
- `422 {error:'missing_blobs', hashes}` — a `newHash` this group has not uploaded. A hash counts as present only if the token's group stored it with `PUT /api/blob/:hash` (which verifies the content); a blob uploaded by another group does not count. Upload the blobs and retry.
- `409 {error:'case_collision', path, existing}` — a live `newHash` whose case-folded path belongs to another live path of the group. A delete of the old name earlier in the same push frees it, so a casing rename `[Nota.md→null, nota.md→H]` is valid.

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

Web UI tests (`web/**/*.test.tsx`) run in jsdom through `environmentMatchGlobs` in
`vitest.config.ts`. When upgrading to Vitest 3, move that to `projects`.

## Lint and build

```bash
pnpm lint          # biome check
pnpm lint:write    # biome check --write (auto-fix)
pnpm typecheck     # tsc --noEmit
pnpm build         # typecheck (server + web) + vite build + tsup
```

## Deploy

### Requirements

- Ubuntu 24.04+ VPS with Docker 29+ and Docker Compose v2 installed
- nginx already running and managing other sites
- `certbot` available for TLS

### First start

```bash
# 1. Clone / pull the repo
git clone git@github-parche:<owner>/parche.git /srv/parche
cd /srv/parche

# 2. Create the data directory owned by uid 1000 (the `node` user in the container)
install -d -o 1000 -g 1000 data

# 3. Configure environment
cp .env.example .env
# Edit .env:
#   - Set PARCHE_TRUST_PROXY=172.28.0.1 (gateway of the compose bridge)
#   - Adjust PARCHE_SUBNET / PARCHE_GATEWAY if 172.28.0.0/16 conflicts
#     (check with: ip -4 route && docker network ls)

# 4. Start the container
docker compose up -d --build

# 5. Verify the port is bound to loopback only
ss -tlnp | grep 8787   # must show 127.0.0.1:8787 — NOT 0.0.0.0:8787

# 6. Health check
curl http://127.0.0.1:8787/health
# → {"status":"ok","version":"..."}
```

### nginx + TLS

```bash
# Install the example virtual-host config
sudo cp deploy/nginx/parche.chamba.tools.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/parche.chamba.tools.conf \
           /etc/nginx/sites-enabled/

# ALWAYS test before reloading — protects the other sites on this server
sudo nginx -t && sudo systemctl reload nginx

# Obtain a TLS certificate (certbot rewrites the config to add a 443 block)
sudo certbot --nginx -d parche.chamba.tools

# Final check
curl https://parche.chamba.tools/health
```

### Updating

```bash
cd /srv/parche
git pull
docker compose up -d --build
```

### Logs

```bash
docker compose logs -f parche
```

### Admin commands (in production)

Run any admin command inside the running container:

```bash
docker compose exec parche node dist/admin-cli.js create-group \
  --name "My Group" --slug my-group \
  --owner-name "Alice" --owner-email alice@example.com

docker compose exec parche node dist/admin-cli.js create-invite \
  --group my-group --role editor

docker compose exec parche node dist/admin-cli.js list-members \
  --group my-group

docker compose exec parche node dist/admin-cli.js revoke-device \
  --device <device-id>

docker compose exec parche node dist/admin-cli.js revoke-invite \
  --group my-group --code XXXX-XXXX

docker compose exec parche node dist/admin-cli.js create-device \
  --group my-group --email alice@example.com

# Manual hot backup (also used by backup.sh)
docker compose exec parche node dist/admin-cli.js backup-db /data/backup.db
```

### Backups

`deploy/backup.sh` creates a daily hot backup of the SQLite database (via
the Online Backup API — consistent even with WAL active) plus a tar of the
blobs directory.

```bash
# Manual run
BACKUP_DIR=/srv/parche-backups ./deploy/backup.sh

# Set up a daily cron in root's crontab (edit with: sudo crontab -e)
0 3 * * * cd /srv/parche && BACKUP_DIR=/srv/parche-backups ./deploy/backup.sh >> /var/log/parche-backup.log 2>&1
```

The script runs as root (the VPS is operated as root) and never creates
anything under `./data`: the database snapshot is written inside the container
by `backup-db`, which owns `/data`. If `./data/blobs` does not exist yet, the
blob archive is skipped with a message; any `tar` error aborts the run with a
non-zero exit code.

The default retention is 14 days (`BACKUP_KEEP_DAYS`): dated directories older
than 14 full days (`find -mtime +14`) are removed. Only directories matching
`YYYY-MM-DD` inside `BACKUP_DIR` are ever removed.

To verify a backup independently:
```bash
sqlite3 /srv/parche-backups/<date>/parche.db "PRAGMA integrity_check"
# expected output: ok
```

For restore instructions see [`deploy/restore.md`](deploy/restore.md).

## Secret scanning

The server is the only point that sees everything that gets uploaded, so it
scans text blobs for secret-shaped values on the way in — independent of
whether the client (`@chamba/mcp`) also scans locally (CHAMBA-021). It never
logs or returns the matched value: only `kind` (e.g. `aws-access-key`) and a
value-free `fingerprint` ever leave `@chamba/core`'s scanner.

**Gate on `PUT /api/blob/:hash`** — reads at most 2 MiB into memory (bodies
above that, and anything that is not strict UTF-8, are **not scanned** —
documented limitation; images/PDF are out of scope by the scanner's own
design). With findings:

- `PARCHE_SECRET_GATE=block` — `422 {"error":"secret_detected","kinds":[...]}`.
  The blob is **not** stored and no `blob_ref` is created (nothing is deleted
  either way — parche never deletes). A `GET`/`HEAD` of that hash still `404`s.
- `PARCHE_SECRET_GATE=report` (**default**) — the blob is stored normally
  (`201`), and a `warn` log records `{groupId, userId, deviceId, kinds,
  allowed: false, mode: 'report'}` (never the value). This is the default
  because **no `@chamba/mcp` client sends the `X-Parche-Secret-Allow` header
  today** (verified: zero occurrences in `chamba/packages/`) — switching to
  `block` before that header exists would turn every already-exempted false
  positive into an unrecoverable `422` for the client. Switch to `block` once
  a chamba client that implements **CHAMBA-023** (sends the header and
  handles the per-file `422`) is published.
- Allowlist (`X-Parche-Secret-Allow: <fingerprint>,<fingerprint>,…`, ≤ 2 KiB,
  ≤ 64 entries, `/^[0-9a-f]{12}$/` each): if **all** findings in the body are
  in that list, the blob is accepted and a `info` log records `allowed: true`.
  The server only knows fingerprints (not paths), so an exemption is scoped
  per-request, not per-path like the client's own allowlist.

**Reporting what's already uploaded** — an idempotent task at startup (and
the `scan-secrets` admin command) scans the live head of every `.md`,
`.canvas`, `.base` and `.svg` file, storing findings in `secret_findings`
(`group_id, path, hash, kind, fingerprint, found_at, resolved_at,
acknowledged_at, acknowledged_by`). `resolved_at` is set (never a delete) when
a path's head moves to a blob without that finding, or to a tombstone
(deleted note). A secret that reappears later reopens the same row
(`found_at` is preserved). The same push hook also keeps findings in sync in
real time. `GET /health` exposes `secretScan: idle|running|done`, mirroring
the existing `metaBackfill` field. Findings are **per live head**, not per
blob: in `report` mode a blob that was `PUT` but never pushed as a file's
head (or pushed and later superseded/tombstoned) is stored on disk without
ever having a `secret_findings` row recorded for it.

**Dashboard warning** (owner/admin only, both gate modes) — the web app shows
"N notas con posibles secretos" (open findings) and "Pendiente rotar
credencial" (findings already resolved but not yet acknowledged), each row as
`ruta · tipo · desde …`. **Never** the fingerprint or the value. The rule:
*"Quitar el valor de la nota no lo borra del historial: rota la credencial."*
A "Ya roté la credencial" button on each row calls
`POST /api/web/g/:slug/secrets/:id/ack` (CSRF required, owner/admin only;
idempotent, UPDATE-only). Nothing about an existing note — its content, raw
blob, or history — is hidden because of a finding; `GET /api/web/g/:slug/note`
and `/raw` work exactly as before.
