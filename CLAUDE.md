# parche — Contexto de proyecto

## Qué es

**parche** es el server HTTP de sync para el vault colectivo de chamba. Grupos que comparten un vault Obsidian-compatible lo usan para hacer push/pull de blobs desde `@chamba/mcp`.

Es la parte **premium/privada** del ecosistema chamba. `package.json` tiene `"private": true` y `"license": "UNLICENSED"`.

## Stack

- Node 22 LTS, TypeScript 5.6, ESM
- Fastify 5 (HTTP server, `inject()` para tests)
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
  server.ts           # buildServer(config) → FastifyInstance
  config.ts           # zod env schema + loadConfig + ConfigError
  version.ts          # VERSION leído de package.json
  test-helpers.ts     # makeTempDataDir, makeApp, makeConfig, cleanupDir
  storage/
    storage-port.ts         # StoragePort interface + error classes
    blob-path.ts            # HASH_RE, isValidHash, blobPath
    filesystem-storage.ts   # FilesystemStorage implements StoragePort
  routes/
    health.ts          # GET /health
    health.test.ts     # smoke test para /health
    blobs.ts           # PUT/GET/HEAD /api/blob/:hash
```

## Regla fundamental: parche nunca borra blobs ni historial

**parche no tiene operación de borrado de blobs.** `StoragePort` no tiene método `delete`/`remove`/`erase`. `FilesystemStorage` solo limpia sus propios archivos temporales (bajo `<dataDir>/tmp/`) cuando ocurre un error durante un PUT; nunca toca los blobs almacenados.

Esta regla no es negociable. Si necesitás agregar algo que parezca borrar, primero consultá.

## Advertencia de seguridad

Los endpoints `/api/blob/*` **no tienen autenticación todavía**. No exponer el server públicamente hasta que se agregue auth (ticket futuro).
