/**
 * scripts/seed-cya.ts — S25 QA fixture seed
 *
 * Seeds the "cya" demo group with ~86 Markdown notes across multiple folders,
 * multiple users/devices, wikilinks, backlinks, conflict copies, XSS payloads,
 * rename pairs, image embeds, and multiple versions of key files.
 *
 * Features demonstrated:
 * - Folders: auth/, db/, decisiones/, infra/, onboarding/, api/, security/
 * - Wikilinks/backlinks: multiple notes link to [[flujo-login]]
 * - Conflict copy: auth/flujo-login (conflicto vale).md with conflict_of/conflict_base
 * - Tags: tema/... on several notes
 * - Frontmatter: project/work_item in several notes
 * - Multiple versions of auth/flujo-login.md (different users/devices + time gap)
 * - XSS payloads: security/xss-test.md with <script>, <img onerror>, javascript: links, <svg onload>
 * - Image embed: api/arquitectura.md with ![[diagrama.png]]
 * - Rename pair: tombstone auth/draft-old.md + create auth/draft.md, same hash, same user+device+at
 *
 * Idempotent: safe to run multiple times — uses onConflictDoUpdate/onConflictDoNothing.
 * Never deletes any data.
 *
 * Usage:
 *   PARCHE_DATA_DIR=./data pnpm tsx scripts/seed-cya.ts
 *   # or via npm script:
 *   pnpm seed:qa
 *
 * The file_meta table is populated by the backfill that runs on server startup.
 * No manual call to updateFileMetaFromBlob is needed.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { generateDeviceToken, hashToken } from '../src/auth/tokens.js';
import { openDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  blobRefs,
  changes,
  devices,
  files,
  groups,
  members,
  secretFindings,
  users,
} from '../src/db/schema.js';
import { newId } from '../src/ids.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DATA_DIR = process.env['PARCHE_DATA_DIR'] ?? './data';
const GROUP_SLUG = 'cya';

function sha256hex(content: Buffer | string): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Seed users — qa@parche.test is the primary owner; Ana, Beto, Carmen are editors
// ---------------------------------------------------------------------------

const SEED_USERS = [
  { name: 'QA Parche', email: 'qa@parche.test', role: 'owner' as const },
  { name: 'Ana García', email: 'ana@cya.example', role: 'editor' as const },
  { name: 'Beto Ramírez', email: 'beto@cya.example', role: 'editor' as const },
  { name: 'Carmen López', email: 'carmen@cya.example', role: 'reader' as const },
];

// ---------------------------------------------------------------------------
// Note fixtures
// ---------------------------------------------------------------------------

interface NoteFixture {
  path: string;
  content: string;
}

const ROOT_NOTES: NoteFixture[] = [
  {
    path: 'README.md',
    content: `# CYA — Vault colectivo

Bienvenido al vault de **CYA**. Aquí documentamos decisiones, flujos, y onboarding.

## Navegación rápida

- [[auth/flujo-login]] — flujo de autenticación principal
- [[onboarding/setup]] — cómo empezar
- [[decisiones/adr-001]] — primera decisión de arquitectura

## Convenciones

- Kebab-case para nombres de archivo.
- Encabezados en español.
- Tags: \`tema/auth\`, \`tema/db\`, \`tema/infra\`, etc.
`,
  },
  {
    path: 'CHANGELOG.md',
    content: `---
title: Changelog
tags: [changelog]
---

# Changelog

## 2026-11

- Añadido flujo de login con magic link. Ver [[auth/flujo-login]].
- Documentadas decisiones de arquitectura en [[decisiones/adr-001]].

## 2026-10

- Inicio del vault colectivo.
`,
  },
  {
    path: 'glossary.md',
    content: `---
title: Glosario
tags: [tema/onboarding]
---

# Glosario

| Término | Definición |
|---|---|
| Magic link | Enlace de un solo uso para autenticación sin contraseña |
| Vault | Directorio de notas sincronizado con parche |
| Blob | Contenido binario identificado por su hash SHA-256 |
| Tombstone | Entrada de borrado lógico (hash null) |
`,
  },
];

const AUTH_NOTES: NoteFixture[] = [
  {
    // v1 — seeded via flujo-login multi-version logic below
    path: 'auth/flujo-login.md',
    content: `---
title: Flujo de login
tags: [tema/auth, tema/seguridad]
project: auth-refactor
work_item: AUTH-42
---

# Flujo de login

El flujo de autenticación usa **magic links** enviados al correo del usuario.

## Pasos

1. El usuario introduce su correo en \`/entrar\`.
2. El servidor genera un token de un solo uso y lo envía por email.
3. El usuario hace clic en el enlace \`/auth#<token>\`.
4. El cliente POST \`/api/web/auth/verify\` con el token.
5. El servidor crea una sesión y devuelve una cookie \`parche_session\`.

## Seguridad

- Token expira en 15 minutos.
- Solo se puede usar una vez (\`used_at\` se establece al verificar).
- El hash del token se guarda, nunca el token plano.

Ver también [[auth/sesiones]] y [[auth/tokens]].
`,
  },
  {
    path: 'auth/flujo-logout.md',
    content: `---
title: Flujo de logout
tags: [tema/auth]
project: auth-refactor
work_item: AUTH-43
---

# Flujo de logout

El logout invalida la sesión activa del usuario.

## Pasos

1. El cliente POST \`/api/web/auth/logout\`.
2. El servidor establece \`revoked_at\` en la sesión.
3. Se elimina la cookie \`parche_session\`.

Ver [[auth/flujo-login]] para el flujo de entrada.
`,
  },
  {
    path: 'auth/register.md',
    content: `---
title: Registro de usuarios
tags: [tema/auth, tema/onboarding]
---

# Registro de usuarios

Los usuarios se crean al aceptar una invitación o cuando el admin los añade.

## Flujo de invitación

1. El dueño genera un código con \`/api/web/g/:slug/invites\`.
2. El invitado visita \`/unirse/:code\`.
3. El servidor valida el código y crea al usuario + membresía.

Ver [[auth/flujo-login]] para autenticarse después del registro.
`,
  },
  {
    path: 'auth/sesiones.md',
    content: `---
title: Sesiones web
tags: [tema/auth, tema/seguridad]
project: auth-refactor
---

# Sesiones web

Las sesiones se guardan en la tabla \`sessions\` de la DB.

## Propiedades

- \`token_hash\`: SHA-256 del secreto de sesión (nunca el valor plano).
- \`expires_at\`: TTL de 30 días desde la creación.
- \`revoked_at\`: fecha de revocación explícita (logout).

Ver [[auth/flujo-login]] para ver cómo se crea la sesión.
`,
  },
  {
    path: 'auth/tokens.md',
    content: `---
title: Tokens de autenticación
tags: [tema/auth, tema/seguridad]
---

# Tokens de autenticación

El sistema usa dos tipos de tokens:

1. **Magic link tokens**: UUID de un solo uso para email verification.
2. **Device tokens**: tokens de larga duración para dispositivos de sync.

Ambos se almacenan como SHA-256. Ver [[auth/flujo-login]] para magic links.
`,
  },
  {
    path: 'auth/magic-link.md',
    content: `---
title: Magic Links
tags: [tema/auth]
work_item: AUTH-40
---

# Magic Links

Un magic link es un URL con un token de un solo uso para autenticación sin contraseña.

## Generación

\`\`\`
token = crypto.randomUUID()
tokenHash = sha256(token)
link = publicUrl + "/auth#" + token
\`\`\`

## Validación

El servidor valida que:
- El token exista en \`magic_links\`.
- No haya expirado (\`expires_at > now\`).
- No se haya usado ya (\`used_at IS NULL\`).

Ver [[auth/flujo-login]] para el flujo completo.
`,
  },
  {
    path: 'auth/permisos.md',
    content: `---
title: Permisos y roles
tags: [tema/auth, tema/seguridad]
---

# Permisos y roles

| Rol | Puede leer | Puede escribir | Puede invitar |
|---|---|---|---|
| owner | ✓ | ✓ | ✓ |
| editor | ✓ | ✓ | ✗ |
| reader | ✓ | ✗ | ✗ |

La función \`can(role, action)\` de \`@chamba/core\` aplica estas reglas.
Ver [[auth/sesiones]] para contexto de autenticación.
`,
  },
];

const DB_NOTES: NoteFixture[] = [
  {
    path: 'db/schema.md',
    content: `---
title: Esquema de base de datos
tags: [tema/db]
project: infra-db
---

# Esquema de base de datos

Parche usa SQLite con drizzle-orm. Las tablas principales son:

- \`groups\` — grupos de sync
- \`users\` — cuentas de usuario
- \`members\` — membresías (rol + removed_at)
- \`devices\` — dispositivos autenticados
- \`files\` — estado actual por ruta (head_hash, head_seq)
- \`changes\` — log append-only de cambios
- \`blob_refs\` — scope de blobs por grupo

Ver [[db/migraciones]] para el historial de cambios.
`,
  },
  {
    path: 'db/migraciones.md',
    content: `---
title: Migraciones de base de datos
tags: [tema/db]
project: infra-db
work_item: DB-10
---

# Migraciones

Las migraciones se gestionan con drizzle-kit.

## Historial

| Migración | Descripción |
|---|---|
| 0000 | Esquema inicial |
| 0001 | Sesiones y magic links |
| 0002 | file_meta para metadatos extraídos |

Ver [[db/schema]] para el esquema actual.
`,
  },
  {
    path: 'db/backups.md',
    content: `---
title: Backups de base de datos
tags: [tema/db, tema/infra]
project: infra-db
---

# Backups

Usamos SQLite Online Backup API para backups en caliente.

## Comando

\`\`\`bash
pnpm admin backup-db /ruta/al/backup.db
\`\`\`

Los backups incluyen WAL mergeado (snapshot consistente).
`,
  },
  {
    path: 'db/indices.md',
    content: `---
title: Índices de base de datos
tags: [tema/db]
---

# Índices

Los índices más importantes:

- \`files_group_path_key_idx\` — búsqueda por ruta normalizada
- \`file_meta_group_idx\` — consultas de metadatos por grupo
- \`file_meta_conflict_idx\` — detección de conflictos

Ver [[db/schema]] para contexto.
`,
  },
  {
    path: 'db/queries.md',
    content: `---
title: Patrones de consulta comunes
tags: [tema/db]
---

# Consultas frecuentes

## Archivos vivos de un grupo

\`\`\`sql
SELECT path, head_hash FROM files
WHERE group_id = ? AND head_hash IS NOT NULL;
\`\`\`

## Historial de un archivo

\`\`\`sql
SELECT seq, hash, at, user_id FROM changes
WHERE group_id = ? AND path = ?
ORDER BY seq DESC LIMIT 50;
\`\`\`
`,
  },
  {
    path: 'db/conexiones.md',
    content: `---
title: Conexiones a la base de datos
tags: [tema/db, tema/infra]
---

# Conexiones

Parche usa mejor-sqlite3 (síncrono) en modo WAL.

- Una sola conexión por proceso (no pool necesario).
- \`busy_timeout = 5000\` para concurrencia de lectores.
- \`foreign_keys = ON\` para integridad referencial.
`,
  },
  {
    path: 'db/seeds.md',
    content: `---
title: Seeds de datos
tags: [tema/db, tema/onboarding]
---

# Seeds

## Seed QA

El script \`scripts/seed-cya.ts\` popula el grupo \`cya\` con datos de prueba.

\`\`\`bash
PARCHE_DATA_DIR=./data-qa pnpm seed:qa
\`\`\`

El seed es idempotente: seguro de ejecutar múltiples veces.
Ver también [[onboarding/setup]].
`,
  },
];

const DECISIONES_NOTES: NoteFixture[] = [
  {
    path: 'decisiones/adr-001.md',
    content: `---
title: ADR-001 — SQLite sobre PostgreSQL
tags: [tema/decisiones, tema/db]
project: arquitectura
work_item: ARCH-1
---

# ADR-001: SQLite sobre PostgreSQL

## Estado: Aceptado

## Contexto

Parche es un servidor de sync para grupos pequeños. Las operaciones son mayoritariamente escrituras secuenciales (push) y lecturas simples.

## Decisión

Usar SQLite en modo WAL. Razones:
- Simplicidad de deployment (sin servicio externo)
- Suficiente para < 100 usuarios concurrentes
- Backups triviales (cp del archivo)

## Consecuencias

Escalar a > 1000 usuarios requeriría migrar. Aceptado.
`,
  },
  {
    path: 'decisiones/adr-002.md',
    content: `---
title: ADR-002 — Magic links sobre OAuth
tags: [tema/decisiones, tema/auth]
project: arquitectura
work_item: ARCH-2
---

# ADR-002: Magic links sobre OAuth

## Estado: Aceptado

## Contexto

Necesitamos autenticación sin fricción para usuarios técnicos.
Ver [[auth/flujo-login]] para el flujo resultante.

## Decisión

Magic links por email (token de un solo uso, 15 min TTL).

## Consecuencias

Sin contraseñas que gestionar. Dependencia de SMTP.
`,
  },
  {
    path: 'decisiones/adr-003.md',
    content: `---
title: ADR-003 — Hash SHA-256 para blobs
tags: [tema/decisiones, tema/seguridad]
project: arquitectura
---

# ADR-003: SHA-256 para blobs

## Estado: Aceptado

## Decisión

Cada blob se identifica por su SHA-256 hex. Los blobs son inmutables.
El cliente verifica el hash antes de hacer push.

## Consecuencias

Deduplicación automática. Integridad verificable.
`,
  },
  {
    path: 'decisiones/adr-004.md',
    content: `---
title: ADR-004 — Sin borrado físico
tags: [tema/decisiones, tema/seguridad]
project: arquitectura
---

# ADR-004: Sin borrado físico

## Estado: Aceptado

## Decisión

Ningún dato se borra físicamente de la DB. Los archivos borrados usan tombstone (head_hash = null). Las membresías se revocan con removed_at. Los tokens se revocan con revoked_at.

## Consecuencias

Historial auditado. Sin riesgo de pérdida accidental de datos.
`,
  },
  {
    path: 'decisiones/adr-005.md',
    content: `---
title: ADR-005 — Aislamiento de blobs por grupo
tags: [tema/decisiones, tema/seguridad]
project: arquitectura
work_item: ARCH-5
---

# ADR-005: Aislamiento de blobs por grupo

## Estado: Aceptado

## Decisión

Un grupo solo puede acceder a blobs que él mismo subió (blob_refs). Aunque el hash sea conocido, sin blob_refs del grupo el acceso es denegado (404).

## Consecuencias

Fuga entre grupos imposible incluso si los hashes son idénticos.
`,
  },
  {
    path: 'decisiones/adr-006.md',
    content: `---
title: ADR-006 — Rate limiting por sesión
tags: [tema/decisiones, tema/seguridad]
project: arquitectura
---

# ADR-006: Rate limiting

## Estado: Aceptado

## Decisión

300 req/min en endpoints de lectura. 600 req/min para raw. Clave = cookie de sesión.

## Consecuencias

Protección contra scraping. Límites ajustables en QA.
`,
  },
];

const INFRA_NOTES: NoteFixture[] = [
  {
    path: 'infra/docker.md',
    content: `---
title: Docker y contenedores
tags: [tema/infra]
project: infra-deploy
---

# Docker

Parche incluye un Dockerfile multi-stage con usuario no-root.

\`\`\`bash
docker compose up -d
\`\`\`

El servicio expone el puerto 8787 en loopback únicamente. Nginx hace el proxy en producción.
Ver [[infra/nginx]] para la configuración del proxy.
`,
  },
  {
    path: 'infra/nginx.md',
    content: `---
title: Configuración Nginx
tags: [tema/infra]
project: infra-deploy
---

# Nginx

La configuración de ejemplo está en \`deploy/nginx/parche.chamba.tools.conf\`.

Puntos clave:
- Proxy inverso a \`127.0.0.1:8787\`.
- TLS con Let's Encrypt.
- Headers de seguridad (X-Frame-Options, etc.).
`,
  },
  {
    path: 'infra/env.md',
    content: `---
title: Variables de entorno
tags: [tema/infra, tema/onboarding]
---

# Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| PORT | 8787 | Puerto de escucha |
| PARCHE_DATA_DIR | ./data | Directorio de datos |
| PARCHE_SMTP_URL | — | URL SMTP (requerida en producción) |
| PARCHE_CREATORS | — | Emails autorizados a crear grupos |
| PARCHE_PUBLIC_URL | — | URL pública (para magic links) |
`,
  },
  {
    path: 'infra/deployment.md',
    content: `---
title: Guía de deployment
tags: [tema/infra]
project: infra-deploy
work_item: INFRA-20
---

# Deployment

## Pasos

1. \`git pull\` en el servidor.
2. \`pnpm install --frozen-lockfile\`.
3. \`pnpm build\`.
4. \`systemctl restart parche\`.

## Rollback

1. \`git checkout <tag-anterior>\`.
2. Repetir pasos 2-4.
`,
  },
  {
    path: 'infra/monitoring.md',
    content: `---
title: Monitoreo
tags: [tema/infra]
---

# Monitoreo

El endpoint \`GET /health\` devuelve estado del servidor:

\`\`\`json
{
  "status": "ok",
  "version": "0.1.0",
  "metaBackfill": "done"
}
\`\`\`

Ver [[infra/deployment]] para reiniciar el servicio si falla.
`,
  },
  {
    path: 'infra/backups.md',
    content: `---
title: Backups de infraestructura
tags: [tema/infra]
project: infra-deploy
---

# Backups de infraestructura

\`\`\`bash
./deploy/backup.sh /ruta/al/destino/
\`\`\`

Incluye:
- Snapshot de SQLite (Online Backup API).
- Directorio \`blobs/\` comprimido con tar.

Ver [[db/backups]] para más detalles.
`,
  },
];

const ONBOARDING_NOTES: NoteFixture[] = [
  {
    path: 'onboarding/README.md',
    content: `---
title: Onboarding
tags: [tema/onboarding]
---

# Onboarding

Bienvenido al equipo CYA. Esta guía te ayudará a empezar.

1. Lee [[onboarding/setup]] para configurar tu entorno.
2. Revisa [[auth/flujo-login]] para entender la autenticación.
3. Mira [[onboarding/workflow]] para el flujo de trabajo del vault.
`,
  },
  {
    path: 'onboarding/setup.md',
    content: `---
title: Configuración inicial
tags: [tema/onboarding]
work_item: OB-1
---

# Configuración inicial

## Prerequisitos

- Node 22 LTS
- pnpm 10+
- Un cliente de Obsidian o equivalente

## Pasos

1. Clona el repo: \`git clone ...\`
2. \`pnpm install\`
3. Copia \`.env.example\` a \`.env\` y completa las variables. Ver [[infra/env]].
4. \`pnpm dev\`

El vault se sincroniza con \`npx @chamba/mcp vault sync\`.
`,
  },
  {
    path: 'onboarding/workflow.md',
    content: `---
title: Flujo de trabajo del vault
tags: [tema/onboarding]
---

# Flujo de trabajo

1. Edita notas en tu editor local (Obsidian, VS Code, etc.).
2. El MCP detecta cambios y hace push automáticamente.
3. Los cambios aparecen en el feed de actividad del dashboard.
4. Para pull: \`npx @chamba/mcp vault sync\`.

Ver [[auth/flujo-login]] si tienes problemas de autenticación.
`,
  },
  {
    path: 'onboarding/conventions.md',
    content: `---
title: Convenciones del vault
tags: [tema/onboarding]
---

# Convenciones

## Nombres de archivo

- Kebab-case: \`flujo-login.md\`, \`adr-001.md\`.
- Evita caracteres especiales en rutas (excepción: copias de conflicto).

## Frontmatter

\`\`\`yaml
---
title: Título de la nota
tags: [tema/área]
project: nombre-proyecto     # opcional
work_item: TICKET-123        # opcional
---
\`\`\`

## Wikilinks

Usa \`[[ruta/sin/extension]]\` para enlazar notas. El alias es opcional: \`[[ruta|Texto visible]]\`.
`,
  },
  {
    path: 'onboarding/tools.md',
    content: `---
title: Herramientas del equipo
tags: [tema/onboarding]
---

# Herramientas

| Herramienta | Uso |
|---|---|
| Obsidian | Editor principal del vault |
| @chamba/mcp | Sincronización con parche |
| Mailpit | SMTP local para dev |
| Biome | Linter y formatter |
| Vitest | Tests |
`,
  },
  {
    path: 'onboarding/faq.md',
    content: `---
title: Preguntas frecuentes
tags: [tema/onboarding]
---

# FAQ

**¿Por qué usamos SQLite?**
Ver [[decisiones/adr-001]].

**¿Puedo usar OAuth en lugar de magic links?**
Ver [[decisiones/adr-002]]. La respuesta corta: por ahora no.

**¿Cómo hago login?**
Ver [[auth/flujo-login]].

**¿Cómo hago backup?**
Ver [[db/backups]] e [[infra/backups]].
`,
  },
];

const API_NOTES: NoteFixture[] = [
  {
    path: 'api/endpoints.md',
    content: `---
title: Referencia de endpoints
tags: [tema/api]
project: api-docs
---

# Endpoints

## Autenticación

- \`POST /api/web/auth/send-link\` — envía magic link
- \`POST /api/web/auth/verify\` — verifica token y crea sesión
- \`POST /api/web/auth/logout\` — revoca sesión

## Grupos (autenticado)

- \`GET /api/web/g/:slug/summary\` — resumen del grupo
- \`GET /api/web/g/:slug/tree\` — árbol de archivos
- \`GET /api/web/g/:slug/activity\` — feed de actividad
- \`GET /api/web/g/:slug/note\` — contenido de una nota

Ver [[api/autenticacion]] para cabeceras requeridas.
`,
  },
  {
    path: 'api/autenticacion.md',
    content: `---
title: Autenticación en la API
tags: [tema/api, tema/auth]
---

# Autenticación en la API

Los endpoints \`/api/web/*\` requieren la cookie \`parche_session\`.

Los endpoints de sync (\`/api/g/*\`) requieren Bearer token de dispositivo:

\`\`\`
Authorization: Bearer pch_<base62>
\`\`\`

Ver [[auth/tokens]] para la generación de tokens.
`,
  },
  {
    path: 'api/rate-limit.md',
    content: `---
title: Rate limiting de la API
tags: [tema/api, tema/seguridad]
---

# Rate Limiting

| Endpoint | Límite | Ventana |
|---|---|---|
| \`/api/web/g/:slug/*\` lectura | 300 req | 1 minuto |
| \`/api/web/g/:slug/raw\` | 600 req | 1 minuto |
| \`/api/join\` | 5 req | 1 hora |

Ver [[decisiones/adr-006]].
`,
  },
  {
    path: 'api/errores.md',
    content: `---
title: Manejo de errores
tags: [tema/api]
---

# Errores

| Código | Descripción |
|---|---|
| 400 | Parámetros inválidos (path unsafe, etc.) |
| 401 | Sin sesión válida |
| 403 | Sin permiso para la acción |
| 404 | Recurso no encontrado (o grupo sin acceso) |
| 415 | Content-Type no soportado (raw) |
| 422 | Blobs faltantes en push |
| 429 | Rate limit excedido |

Notas de seguridad: los errores 404 también cubren acceso denegado a grupos (ver [[auth/permisos]]).
`,
  },
  {
    path: 'api/versioning.md',
    content: `---
title: Versionado de la API
tags: [tema/api]
---

# Versionado

La API no tiene versionado explícito por URL. La compatibilidad se gestiona con \`PROTOCOL_VERSION\` de \`@chamba/core\`.

Los cambios incompatibles se documentan en [[CHANGELOG]].
`,
  },
  {
    path: 'api/arquitectura.md',
    content: `---
title: Arquitectura de la API
tags: [tema/api, tema/decisiones]
---

# Arquitectura de la API

![[diagrama.png]]

La API tiene dos capas:

1. **Sync API** (\`/api/g/*\`): para dispositivos Obsidian. Autenticación por token.
2. **Web API** (\`/api/web/*\`): para la SPA. Autenticación por cookie de sesión.

Ver [[api/endpoints]] para la lista completa.
`,
  },
];

const SECURITY_NOTES: NoteFixture[] = [
  {
    path: 'security/xss-test.md',
    content: `---
title: Test de payloads XSS
tags: [tema/seguridad]
project: security-audit
work_item: SEC-99
---

# Payloads XSS — SOLO PARA PRUEBAS

Esta nota contiene payloads de XSS para verificar que el render sanitiza correctamente.
**Ninguno de estos debe ejecutarse en el navegador.**

## Script injection

<script>alert('XSS via script tag')</script>

## Img onerror

<img src="x" onerror="alert('XSS via img onerror')">

## Link con javascript:

[Click aquí](javascript:alert('XSS via link'))

## SVG onload

<svg onload="alert('XSS via svg onload')"></svg>

## HTML crudo

<b onclick="alert('click')">texto en negrita</b>

## Wikilink normal (debe renderizar)

Ver [[auth/flujo-login]] para el flujo correcto.
`,
  },
  {
    path: 'security/checklist.md',
    content: `---
title: Security checklist
tags: [tema/seguridad]
project: security-audit
---

# Security Checklist

- [x] XSS: sanitize-html con allowlist explícita
- [x] CSRF: token en header \`x-parche-csrf\`
- [x] Aislamiento de grupos (blob_refs)
- [x] Rate limiting por sesión
- [x] CSP en cabeceras HTTP
- [x] Tokens almacenados como SHA-256
- [x] Sin borrado físico (audit trail)
- [ ] Pen test formal (pendiente)

Ver [[decisiones/adr-004]] y [[decisiones/adr-005]].
`,
  },
  {
    path: 'security/csp.md',
    content: `---
title: Content Security Policy
tags: [tema/seguridad]
---

# CSP

La política CSP del servidor:

\`\`\`
default-src 'self';
img-src 'self' data:;
script-src 'self';
style-src 'self' 'unsafe-inline';
frame-ancestors 'none';
base-uri 'none';
form-action 'self'
\`\`\`

\`unsafe-inline\` en style-src es necesario para los estilos del SPA (pendiente de refactor).
`,
  },
  // PARCHE-012 — valores de juguete (forma real, nunca secretos vivos) para que
  // el escaneo de servidor tenga algo que reportar en el dashboard (GWT-1/GWT-7).
  {
    path: 'security/credenciales-viejas.md',
    content: `---
title: Credenciales viejas (de juguete, para QA)
tags: [tema/seguridad]
project: security-audit
---

# Credenciales viejas — SOLO valores de juguete para QA

Esta nota existe a propósito para que el escaneo de secretos del servidor
(PARCHE-012) tenga algo que reportar en el dashboard. Los valores de abajo
son de juguete (forma real, nunca una credencial viva):

- AWS access key de ejemplo: AKIAIOSFODNN7EXAMPLE
- Token de parche de ejemplo: pch_qaDemoToken1234567890

Quitar el valor de esta nota no lo borra del historial: la acción correcta
es rotar la credencial (en este caso, nada que rotar — son valores de juguete).
`,
  },
];

// Conflict copy content (divergente del original)
const FLUJO_LOGIN_CONFLICT_CONTENT = `---
title: Flujo de login (versión conflicto)
conflict_of: auth/flujo-login.md
conflict_base: CONFLICT_BASE_PLACEHOLDER
tags: [tema/auth]
---

# Flujo de login — versión alternativa (conflicto)

Esta versión propone un flujo diferente con sesiones más cortas.

## Propuesta alternativa

1. El usuario introduce su correo.
2. El servidor envía un código OTP de 6 dígitos (en lugar de magic link).
3. El usuario introduce el código en \`/auth\`.
4. Sesión de 8 horas (en lugar de 30 días).

## Diferencias con la versión principal

- OTP en lugar de magic link.
- TTL de sesión más corto.

Ver [[auth/flujo-login]] para la versión principal aceptada.
`;

// v2 and v3 of flujo-login.md (to create multiple versions)
const FLUJO_LOGIN_V2 = `---
title: Flujo de login (v2)
tags: [tema/auth, tema/seguridad]
project: auth-refactor
work_item: AUTH-42
---

# Flujo de login — v2

Actualización: se añadió límite de intentos fallidos.

## Pasos

1. El usuario introduce su correo en \`/entrar\`.
2. El servidor genera un token de un solo uso (max 3 por hora).
3. El usuario hace clic en el enlace \`/auth#<token>\`.
4. El cliente POST \`/api/web/auth/verify\`.
5. El servidor crea una sesión con TTL de 30 días.

## Seguridad adicional

- Máximo 3 magic links por hora por email.
- Alerta si se detectan más de 5 intentos desde la misma IP.

Ver [[auth/sesiones]] y [[auth/tokens]].
`;

const FLUJO_LOGIN_V3 = `---
title: Flujo de login (v3 — actual)
tags: [tema/auth, tema/seguridad]
project: auth-refactor
work_item: AUTH-42
---

# Flujo de login — versión actual

Versión final con CSP y cookie \`SameSite=Strict\`.

## Pasos

1. El usuario introduce su correo en \`/entrar\`.
2. El servidor genera un token SHA-256 (expira en 15 min).
3. El usuario hace clic en el enlace enviado por email.
4. El cliente verifica el token vía \`POST /api/web/auth/verify\`.
5. El servidor crea sesión (cookie \`parche_session\`, \`HttpOnly\`, \`SameSite=Strict\`).

## Mejoras en v3

- Cookie \`SameSite=Strict\` para mitigar CSRF.
- CSP reforzada.
- Logs de auditoría en pino.

Ver [[auth/sesiones]], [[auth/tokens]], [[security/csp]].
`;

// ---------------------------------------------------------------------------
// Main seed function
// ---------------------------------------------------------------------------

async function seedNote(
  db: ReturnType<typeof import('../src/db/client.js').openDb> extends Promise<infer T>
    ? T['db']
    : never,
  blobsDir: string,
  groupId: string,
  userId: string,
  deviceId: string,
  path: string,
  content: string,
  seq: number,
  at: string,
): Promise<void> {
  const contentBuf = Buffer.from(content, 'utf8');
  const hash = sha256hex(contentBuf);

  // Write blob to disk
  const prefix = hash.slice(0, 2);
  const subdir = hash.slice(2, 4);
  await mkdir(join(blobsDir, prefix, subdir), { recursive: true });
  await writeFile(join(blobsDir, prefix, subdir, hash), contentBuf);

  // Insert blob_ref, file, change
  db.insert(blobRefs).values({ groupId, hash }).onConflictDoNothing().run();
  db.insert(files)
    .values({
      groupId,
      path,
      pathKey: path.toLowerCase(),
      headHash: hash,
      headSeq: seq,
    })
    .onConflictDoUpdate({
      target: [files.groupId, files.path],
      set: { headHash: hash, headSeq: seq },
    })
    .run();
  db.insert(changes)
    .values({ groupId, seq, path, hash, userId, deviceId, at })
    .onConflictDoNothing()
    .run();
  db.update(groups).set({ seqCounter: seq }).where(eq(groups.id, groupId)).run();
}

async function main() {
  const { db, raw } = await openDb(DATA_DIR);
  runMigrations(raw);

  const blobsDir = join(DATA_DIR, 'blobs');
  await mkdir(blobsDir, { recursive: true });

  // -----------------------------------------------------------------------
  // 1. Upsert group
  // -----------------------------------------------------------------------
  let groupId: string;
  const existingGroup = db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.slug, GROUP_SLUG))
    .get();

  if (existingGroup) {
    groupId = existingGroup.id;
    process.stdout.write(`[seed-cya] grupo '${GROUP_SLUG}' ya existe (${groupId})\n`);
  } else {
    groupId = newId();
    db.insert(groups)
      .values({ id: groupId, slug: GROUP_SLUG, name: 'CYA', createdAt: new Date().toISOString() })
      .run();
    process.stdout.write(`[seed-cya] grupo '${GROUP_SLUG}' creado (${groupId})\n`);
  }

  // -----------------------------------------------------------------------
  // 2. Upsert users + members + devices
  // -----------------------------------------------------------------------
  const userDevices: Record<string, { userId: string; deviceId: string }> = {};

  for (const u of SEED_USERS) {
    const now = new Date().toISOString();

    // Upsert user
    const existingUser = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, u.email))
      .get();

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      userId = newId();
      db.insert(users).values({ id: userId, name: u.name, email: u.email, createdAt: now }).run();
      process.stdout.write(`[seed-cya] usuario '${u.email}' creado\n`);
    }

    // Add member if not already active
    const existingMember = db
      .select({ role: members.role })
      .from(members)
      .where(
        and(eq(members.groupId, groupId), eq(members.userId, userId), isNull(members.removedAt)),
      )
      .get();

    if (!existingMember) {
      db.insert(members)
        .values({ groupId, userId, role: u.role, createdAt: now })
        .onConflictDoNothing()
        .run();
      process.stdout.write(`[seed-cya] miembro '${u.email}' (${u.role}) añadido\n`);
    }

    // Upsert device (one per user)
    const existingDevice = db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(eq(devices.groupId, groupId), eq(devices.userId, userId), isNull(devices.revokedAt)),
      )
      .get();

    let deviceId: string;
    if (existingDevice) {
      deviceId = existingDevice.id;
    } else {
      deviceId = newId();
      const deviceToken = generateDeviceToken();
      const tokenHash = hashToken(deviceToken);
      db.insert(devices)
        .values({
          id: deviceId,
          userId,
          groupId,
          label: `seed-${u.name.split(' ')[0]?.toLowerCase() ?? 'device'}`,
          tokenHash,
          createdAt: now,
        })
        .run();
      process.stdout.write(
        `[seed-cya] device creado para '${u.email}' — token (guárdalo una sola vez): ${deviceToken}\n`,
      );
    }

    userDevices[u.email] = { userId, deviceId };
  }

  const qaDevice = userDevices['qa@parche.test']!;
  const anaDevice = userDevices['ana@cya.example']!;
  const betoDevice = userDevices['beto@cya.example']!;

  // -----------------------------------------------------------------------
  // 3. Get current seq
  // -----------------------------------------------------------------------
  let seq =
    db.select({ seqCounter: groups.seqCounter }).from(groups).where(eq(groups.id, groupId)).get()
      ?.seqCounter ?? 0;

  function nextSeq(): number {
    seq += 1;
    return seq;
  }

  // -----------------------------------------------------------------------
  // 4. Helper to check if a note exists (skip if already seeded)
  // -----------------------------------------------------------------------
  function noteExists(path: string): boolean {
    return !!db
      .select({ path: files.path })
      .from(files)
      .where(and(eq(files.groupId, groupId), eq(files.path, path)))
      .get();
  }

  // -----------------------------------------------------------------------
  // 5. Seed all notes
  // -----------------------------------------------------------------------
  const allNotes = [
    ...ROOT_NOTES,
    ...AUTH_NOTES,
    ...DB_NOTES,
    ...DECISIONES_NOTES,
    ...INFRA_NOTES,
    ...ONBOARDING_NOTES,
    ...API_NOTES,
    ...SECURITY_NOTES,
  ];

  const baseAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago

  for (const note of allNotes) {
    // Skip flujo-login.md — handled separately below with multi-version
    if (note.path === 'auth/flujo-login.md') continue;

    if (noteExists(note.path)) {
      process.stdout.write(`[seed-cya] '${note.path}' ya existe, saltando\n`);
      continue;
    }

    await seedNote(
      db,
      blobsDir,
      groupId,
      qaDevice.userId,
      qaDevice.deviceId,
      note.path,
      note.content,
      nextSeq(),
      baseAt,
    );
    process.stdout.write(`[seed-cya] nota '${note.path}' sembrada (seq=${seq})\n`);
  }

  // -----------------------------------------------------------------------
  // 6. Image PNG placeholder (for ![[diagrama.png]] embed in api/arquitectura.md)
  //    Seeded HERE (before multi-version flujo-login) so its seq is lower than
  //    v2 (Oct-19) and the conflict copy (Oct-29), keeping at values monotonic.
  // -----------------------------------------------------------------------
  const diagramaPath = 'api/diagrama.png';
  if (!noteExists(diagramaPath)) {
    // Minimal valid 1x1 PNG (red pixel)
    const pngData = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108020000009001' +
        '2e00000000c4944415478016360f8cfc00000000200018e21bc3300000000' +
        '49454e44ae426082',
      'hex',
    );

    const hash = sha256hex(pngData);
    const prefix = hash.slice(0, 2);
    const subdir = hash.slice(2, 4);
    await mkdir(join(blobsDir, prefix, subdir), { recursive: true });
    await writeFile(join(blobsDir, prefix, subdir, hash), pngData);

    db.insert(blobRefs).values({ groupId, hash }).onConflictDoNothing().run();
    db.insert(files)
      .values({
        groupId,
        path: diagramaPath,
        pathKey: diagramaPath.toLowerCase(),
        headHash: hash,
        headSeq: nextSeq(),
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hash, headSeq: seq },
      })
      .run();
    db.insert(changes)
      .values({
        groupId,
        seq,
        path: diagramaPath,
        hash,
        userId: qaDevice.userId,
        deviceId: qaDevice.deviceId,
        at: baseAt, // Oct-4 — same batch as allNotes
      })
      .onConflictDoNothing()
      .run();
    db.update(groups).set({ seqCounter: seq }).where(eq(groups.id, groupId)).run();
    process.stdout.write(`[seed-cya] imagen '${diagramaPath}' sembrada\n`);
  } else {
    process.stdout.write(`[seed-cya] '${diagramaPath}' ya existe, saltando\n`);
  }

  // -----------------------------------------------------------------------
  // 7. Multi-version auth/flujo-login.md — v1 (Oct-4) and v2 (Oct-19) only.
  //    v3 (today) is seeded last in step 10 so the seq order mirrors the
  //    at-timestamp order and the activity feed shows a clean timeline.
  // -----------------------------------------------------------------------
  const flujoLoginPath = 'auth/flujo-login.md';
  const v1Note = AUTH_NOTES.find((n) => n.path === flujoLoginPath)!;

  if (!noteExists(flujoLoginPath)) {
    // v1 — Ana, 30 days ago (Oct-4)
    const at_v1 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await seedNote(
      db,
      blobsDir,
      groupId,
      anaDevice.userId,
      anaDevice.deviceId,
      flujoLoginPath,
      v1Note.content,
      nextSeq(),
      at_v1,
    );
    process.stdout.write(`[seed-cya] '${flujoLoginPath}' v1 sembrada por Ana\n`);

    // v2 — Beto, 15 days ago (Oct-19)
    const at_v2 = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    await seedNote(
      db,
      blobsDir,
      groupId,
      betoDevice.userId,
      betoDevice.deviceId,
      flujoLoginPath,
      FLUJO_LOGIN_V2,
      nextSeq(),
      at_v2,
    );
    process.stdout.write(`[seed-cya] '${flujoLoginPath}' v2 sembrada por Beto\n`);
  } else {
    process.stdout.write(`[seed-cya] '${flujoLoginPath}' ya existe, saltando v1/v2\n`);
  }

  // -----------------------------------------------------------------------
  // 8. Conflict copy: auth/flujo-login (conflicto vale).md  (Oct-29)
  //    Beto created this conflict copy 5 days after v2 — before QA's final edit.
  // -----------------------------------------------------------------------
  const conflictPath = 'auth/flujo-login (conflicto vale).md';
  if (!noteExists(conflictPath)) {
    // Get the current hash of flujo-login.md to use as conflict_base
    const flujoHead = db
      .select({ headHash: files.headHash })
      .from(files)
      .where(and(eq(files.groupId, groupId), eq(files.path, flujoLoginPath)))
      .get();
    const conflictBase = flujoHead?.headHash ?? sha256hex(v1Note.content);

    const conflictContent = FLUJO_LOGIN_CONFLICT_CONTENT.replace(
      'CONFLICT_BASE_PLACEHOLDER',
      conflictBase,
    );

    const at_conflict = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await seedNote(
      db,
      blobsDir,
      groupId,
      betoDevice.userId,
      betoDevice.deviceId,
      conflictPath,
      conflictContent,
      nextSeq(),
      at_conflict,
    );
    process.stdout.write(`[seed-cya] copia de conflicto '${conflictPath}' sembrada\n`);
  } else {
    process.stdout.write(`[seed-cya] '${conflictPath}' ya existe, saltando\n`);
  }

  // -----------------------------------------------------------------------
  // 9. Rename pair: tombstone auth/draft-old.md + create auth/draft.md (same hash, same at)
  //    Ana created draft-old.md (Oct-31) then renamed it (Nov-1).
  // -----------------------------------------------------------------------
  const draftOldPath = 'auth/draft-old.md';
  const draftNewPath = 'auth/draft.md';

  const draftOldExists = noteExists(draftOldPath);
  const draftNewExists = noteExists(draftNewPath);

  if (!draftOldExists && !draftNewExists) {
    const draftContent = `---
title: Borrador de autenticación (renombrado)
tags: [tema/auth]
---

# Borrador

Este archivo fue renombrado de \`draft-old.md\` a \`draft.md\` como prueba del detector de renombres.
Ver [[auth/flujo-login]].
`;
    const draftBuf = Buffer.from(draftContent, 'utf8');
    const draftHash = sha256hex(draftBuf);
    const renameAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // First: seed draft-old.md with the hash (prior state, Oct-31)
    await seedNote(
      db,
      blobsDir,
      groupId,
      anaDevice.userId,
      anaDevice.deviceId,
      draftOldPath,
      draftContent,
      nextSeq(),
      new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    );

    // Then: tombstone draft-old.md (same renameAt as create below, Nov-1)
    const tombstoneSeq = nextSeq();
    db.insert(files)
      .values({
        groupId,
        path: draftOldPath,
        pathKey: draftOldPath.toLowerCase(),
        headHash: null,
        headSeq: tombstoneSeq,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: null, headSeq: tombstoneSeq },
      })
      .run();
    db.insert(changes)
      .values({
        groupId,
        seq: tombstoneSeq,
        path: draftOldPath,
        hash: null,
        userId: anaDevice.userId,
        deviceId: anaDevice.deviceId,
        at: renameAt,
      })
      .onConflictDoNothing()
      .run();
    db.update(groups).set({ seqCounter: tombstoneSeq }).where(eq(groups.id, groupId)).run();

    // Create draft.md with same hash at same renameAt
    const createSeq = nextSeq();
    db.insert(blobRefs).values({ groupId, hash: draftHash }).onConflictDoNothing().run();
    db.insert(files)
      .values({
        groupId,
        path: draftNewPath,
        pathKey: draftNewPath.toLowerCase(),
        headHash: draftHash,
        headSeq: createSeq,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: draftHash, headSeq: createSeq },
      })
      .run();
    db.insert(changes)
      .values({
        groupId,
        seq: createSeq,
        path: draftNewPath,
        hash: draftHash,
        userId: anaDevice.userId,
        deviceId: anaDevice.deviceId,
        at: renameAt, // SAME at as tombstone → rename pair
      })
      .onConflictDoNothing()
      .run();
    db.update(groups).set({ seqCounter: createSeq }).where(eq(groups.id, groupId)).run();

    process.stdout.write(
      `[seed-cya] rename pair: '${draftOldPath}' → '${draftNewPath}' sembrado (seqs ${tombstoneSeq},${createSeq})\n`,
    );
  } else {
    process.stdout.write(`[seed-cya] rename pair ya sembrado, saltando\n`);
  }

  // -----------------------------------------------------------------------
  // 10. flujo-login.md v3 — QA, today (highest seq → top of feed)
  //     Seeded LAST so seq > all earlier at values, making the timeline
  //     monotonically increasing: Oct-4 ≤ Oct-19 ≤ Oct-29 ≤ Oct-31 ≤ Nov-1 ≤ today
  // -----------------------------------------------------------------------
  const v3Hash = sha256hex(Buffer.from(FLUJO_LOGIN_V3, 'utf8'));
  const flujoCurrentHead = db
    .select({ headHash: files.headHash })
    .from(files)
    .where(and(eq(files.groupId, groupId), eq(files.path, flujoLoginPath)))
    .get();

  if (flujoCurrentHead?.headHash !== v3Hash) {
    const at_v3 = new Date().toISOString();
    await seedNote(
      db,
      blobsDir,
      groupId,
      qaDevice.userId,
      qaDevice.deviceId,
      flujoLoginPath,
      FLUJO_LOGIN_V3,
      nextSeq(),
      at_v3,
    );
    process.stdout.write(`[seed-cya] '${flujoLoginPath}' v3 sembrada por QA\n`);
  } else {
    process.stdout.write(`[seed-cya] '${flujoLoginPath}' v3 ya existe, saltando\n`);
  }

  // -----------------------------------------------------------------------
  // 11. PARCHE-012 — nota con una credencial ya rotada (head limpio) + un
  //     hallazgo resuelto-sin-acuse sembrado directo (simula historial: la
  //     nota tuvo un secreto en una versión anterior que ya no está en el
  //     head vivo). Solo INSERT, idempotente por el índice único
  //     (group_id,path,kind,fingerprint) — nunca UPDATE/DELETE de datos reales.
  //     Da contenido a AMBAS listas del dashboard (open + pendingRotation)
  //     para las capturas de QA (GWT-1).
  // -----------------------------------------------------------------------
  const ROTATED_PATH = 'security/credencial-rotada.md';
  const rotatedContent = `---
title: Credencial rotada (ejemplo de QA)
tags: [tema/seguridad]
---

# Credencial rotada

Esta nota documentaba una credencial de prueba que ya fue rotada: el valor
ya no está en la versión actual, pero el hallazgo queda en el historial
hasta que alguien lo acuse con "Ya roté la credencial".
`;

  if (!noteExists(ROTATED_PATH)) {
    await seedNote(
      db,
      blobsDir,
      groupId,
      qaDevice.userId,
      qaDevice.deviceId,
      ROTATED_PATH,
      rotatedContent,
      nextSeq(),
      new Date().toISOString(),
    );
    process.stdout.write(`[seed-cya] '${ROTATED_PATH}' sembrada\n`);
  } else {
    process.stdout.write(`[seed-cya] '${ROTATED_PATH}' ya existe, saltando\n`);
  }

  const rotatedKind = 'aws-access-key';
  const rotatedToyValue = 'AKIAEXAMPLEOLDKEY123'; // valor de juguete — nunca una credencial viva
  const rotatedFingerprint = sha256hex(`${rotatedKind}\n${rotatedToyValue}`).slice(0, 12);
  const foundAtPast = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const resolvedAtPast = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  db.insert(secretFindings)
    .values({
      groupId,
      path: ROTATED_PATH,
      hash: sha256hex(Buffer.from(rotatedContent, 'utf8')),
      kind: rotatedKind,
      fingerprint: rotatedFingerprint,
      foundAt: foundAtPast,
      resolvedAt: resolvedAtPast,
      acknowledgedAt: null,
      acknowledgedBy: null,
    })
    .onConflictDoNothing()
    .run();
  process.stdout.write(
    `[seed-cya] hallazgo resuelto-sin-acuse sembrado para '${ROTATED_PATH}' (pendingRotation)\n`,
  );

  raw.close();
  process.stdout.write(`[seed-cya] listo. Total seqs usados: ${seq}\n`);
  process.stdout.write(
    `[seed-cya] file_meta se populará con el backfill al arrancar el servidor.\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[seed-cya] error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
