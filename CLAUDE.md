# parche — Contexto de proyecto

## Qué es

**parche** es el server HTTP de sync para el vault colectivo de chamba. Grupos que comparten un vault Obsidian-compatible lo usan para hacer push/pull de blobs desde `@chamba/mcp`.

Es la parte **premium/privada** del ecosistema chamba. `package.json` tiene `"private": true` y `"license": "UNLICENSED"`.

## Stack

- Node 22 LTS, TypeScript 5.6, ESM
- Fastify 5 (HTTP server, `inject()` para tests)
- @chamba/core ^1.7.0 (schemas compartidos, `can()`, `isSyncable()`, `pathKey()`, `PROTOCOL_VERSION`)
- better-sqlite3 v11 (síncrono, WAL mode — usa prebuild-install, no requiere node-gyp)
- drizzle-orm (transacciones síncronas)
- @fastify/rate-limit ^11 (compatible con Fastify 5 vía fastify-plugin v6; `global:false` = opt-in por ruta)
- zod 3 (validación de env vars)
- pnpm (gestor de paquetes, standalone — no es parte del workspace de chamba)
- vitest 2 (tests co-ubicados)
- biome 2 (linter + formatter)
- tsup 8 (build)
- tsx 4 (dev con watch)

## Comandos

```bash
pnpm install          # instalar dependencias
pnpm dev              # tsx watch src/main.ts
pnpm build            # tsc --noEmit + tsup
pnpm start            # node dist/main.js
pnpm test             # vitest run
pnpm lint             # biome check .
pnpm lint:write       # biome check --write .
pnpm typecheck        # tsc --noEmit
```

## Convenciones de código

Igual que `chamba/CLAUDE.md`:

- Exports nombrados, nunca default.
- Archivos kebab-case: `filesystem-storage.ts`.
- Tipos e interfaces PascalCase.
- Funciones y variables camelCase.
- Constantes globales SCREAMING_SNAKE_CASE.
- Errores son clases extendiendo `Error` con `name` explícito.
- Cero `any` excepto justificado con comentario.
- Imports con extensión `.js` en rutas relativas.

## Tests

- Co-ubicados: `foo.test.ts` junto a `foo.ts`.
- Usar `app.inject()` (sin levantar puerto).
- Cada test crea un `PARCHE_DATA_DIR` temporal fresco (`src/test-helpers.ts`).
- Config de test: `logLevel: 'silent'`.

## Estructura de directorios

```
src/
  main.ts             # entrypoint — loadConfig → buildServer → listen
  server.ts           # buildServer(config, logStream?) → FastifyInstance
  config.ts           # zod env schema + loadConfig + ConfigError
  version.ts          # VERSION leído de package.json
  test-helpers.ts     # makeTempDataDir, makeApp, makeConfig, cleanupDir, seedGroupWithDevice
  no-destructive.test.ts  # verifica que no hay DELETE/db.delete/Map.delete en código de dominio
  no-schema-dup.test.ts   # verifica que no se redefinen schemas de @chamba/core
  auth/
    plugin.ts         # registerAuth, authenticate preHandler, requireCan(action), RequestAuth
    plugin.test.ts    # tests AC5 de autenticación
    logging.test.ts   # verifica redacción de tokens en logs pino
    tokens.ts         # generateDeviceToken, hashToken, generateInviteCode, etc.
  admin/
    commands.ts       # createGroup, createInvite, listMembers, revokeDevice, revokeInvite, createDevice, backupDb
    cli.ts            # entrypoint del admin CLI (incluye backup-db <dest>)
    backup-db.test.ts # test del comando backup-db (integridad + datos)
  db/
    client.ts         # openDb → { db: AppDb, raw: RawDb }
    migrate.ts        # runMigrations(rawDb)
    schema.ts         # tablas drizzle: users, groups, members, devices, invites, files, changes, blobRefs
    migrations/       # SQL migrations numeradas
  storage/
    storage-port.ts         # StoragePort interface + error classes
    blob-path.ts            # HASH_RE, isValidHash, blobPath
    filesystem-storage.ts   # FilesystemStorage implements StoragePort
  routes/
    health.ts                   # GET /health
    health.test.ts
    blobs.ts                    # PUT/GET/HEAD /api/blob/:hash (auth requerida, scope por grupo)
    blobs.test.ts
    join.ts                     # POST /api/join (rate-limited, sin auth)
    join.test.ts
    join.trust-proxy.test.ts    # tests de trustProxy con X-Forwarded-For (AC5)
    changes.ts                  # GET /api/g/:slug/changes (auth + can('read'))
    changes.test.ts
    push.ts                     # POST /api/g/:slug/push (auth + can('write'))
    push.test.ts
Dockerfile          # multi-stage, node:22-bookworm-slim, USER node, HEALTHCHECK via fetch
.dockerignore
docker-compose.yml  # servicio parche, loopback-only port, red con subred fija
deploy/
  nginx/
    parche.chamba.tools.conf  # ejemplo para sites-available
  backup.sh         # backup en caliente (SQLite Online Backup API + tar de blobs)
  restore.md        # guía de restauración paso a paso
```

## Variables de entorno (resumen)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `8787` | Puerto de escucha |
| `HOST` | `127.0.0.1` | Host de bind (Docker lo pisa con `0.0.0.0`) |
| `PARCHE_DATA_DIR` | `./data` | Directorio de datos (Docker lo pisa con `/data`) |
| `PARCHE_MAX_BLOB_BYTES` | `20971520` | Tamaño máximo de blob (20 MiB) |
| `PARCHE_LOG_LEVEL` | `info` | Nivel de log de pino |
| `PARCHE_TRUST_PROXY` | `` (vacío) | IPs/CIDRs de proxy confiables para `X-Forwarded-For`. En producción Docker: `172.28.0.1` |

## Modelo de datos (8 tablas)

| Tabla | Descripción |
|---|---|
| `users` | Cuentas de usuario |
| `groups` | Grupos de sync (slug único, seq_counter) |
| `members` | Membresía (role, removed_at) |
| `devices` | Dispositivos autenticados (token_hash, revoked_at) |
| `invites` | Códigos de invitación (code_hash, role, expires_at, max_uses, uses) |
| `files` | Estado actual de archivos (head_hash, head_seq, path_key) |
| `changes` | Log de cambios append-only (seq, path, hash) |
| `blob_refs` | Scope de blobs por grupo (group_id, hash). Solo lo escribe el `PUT` de blobs (prueba de posesión); el push nunca lo inserta |

## Advertencia de seguridad

**Revocación es siempre UPDATE, nunca DELETE.**

- Tokens: `revoked_at` en `devices`
- Membresía: `removed_at` en `members`
- Archivos eliminados: tombstone `head_hash = null` en `files`

Nada se borra físicamente de la base de datos. Esta regla no es negociable.

## Regla fundamental: parche nunca borra blobs ni historial

**parche no tiene operación de borrado de blobs.** `StoragePort` no tiene método `delete`/`remove`/`erase`. `FilesystemStorage` solo limpia sus propios archivos temporales (bajo `<dataDir>/tmp/`) cuando ocurre un error durante un PUT; nunca toca los blobs almacenados.

El archivo `src/no-destructive.test.ts` verifica automáticamente que no se introduzcan operaciones destructivas.

## Autenticación

- Bearer token `pch_<base62>` en header `Authorization`
- El server guarda solo el SHA-256 del token (nunca el token plano)
- `authenticate` preHandler: valida hash, revocación, membresía, y slug de grupo
- `requireCan(action)` preHandler factory: usa `can()` de @chamba/core
- `request.auth: RequestAuth` contiene `deviceId`, `userId`, `groupId`, `groupSlug`, `role`
- Pino redacta `req.headers.authorization` y `res.body.deviceToken` en los logs

## Blobs entre grupos (no negociable)

Un grupo solo ve y usa los blobs que **él mismo subió** con `PUT /api/blob/:hash`, que verifica que el contenido coincide con el hash (prueba de posesión). Por eso:

- `GET`/`HEAD` devuelven `404` si no existe `blob_refs(grupo del token, hash)`, aunque el blob esté en disco.
- En `/push`, un `newHash` cuenta como presente solo si existe `blob_refs(grupo del token, newHash)`; si no, `422 missing_blobs`. **Nunca** se usa `storage.has` global, y el push **no** inserta `blob_refs`. Si lo hiciera, cualquiera que conozca un hash podría reclamar el blob de otro grupo y leerlo (review PARCHE-003, B1).
