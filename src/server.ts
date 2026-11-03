import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { Transporter } from 'nodemailer';
import { registerAuth } from './auth/plugin.js';
import type { Config } from './config.js';
import type { AppDb, RawDb } from './db/client.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createMailer } from './mail/mailer.js';
import { startBackfillBackground } from './meta/backfill.js';
import type { MetaStatus } from './meta/status.js';
import { blobRoutes } from './routes/blobs.js';
import { changesRoutes } from './routes/changes.js';
import { healthRoutes } from './routes/health.js';
import { joinRoutes } from './routes/join.js';
import { pushRoutes } from './routes/push.js';
import { webAuthRoutes } from './routes/web/auth.js';
import { conflictRoutes } from './routes/web/conflicts.js';
import { groupReadRoutes } from './routes/web/group-read.js';
import { webGroupsRoutes } from './routes/web/groups.js';
import { webInviteCheckRoutes } from './routes/web/invite-check.js';
import { webInvitesRoutes } from './routes/web/invites.js';
import { noteRoutes } from './routes/web/note.js';
import { topicsRoutes } from './routes/web/topics.js';

export type { MetaStatus };

// ---------------------------------------------------------------------------
// Fastify instance decoration typings
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDb;
    rawDb: RawDb;
    metaStatus: MetaStatus;
  }
}

// CSP header value for serving the SPA
const CSP_VALUE =
  "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface BuildServerOptions {
  /** Nodemailer transporter — injected so tests can use in-memory transport */
  transport?: Transporter;
  /** Optional log stream for capturing pino output in tests */
  logStream?: NodeJS.WritableStream;
  /**
   * In tests, callers can hook into background work from the auth route.
   * Fire-and-forget in production.
   */
  onBackgroundWork?: (p: Promise<void>) => void;
  /**
   * Override the web static files directory (for tests using a fixture).
   * If not set, defaults to `<bundle>/web` (dist/web in prod, omitted if missing).
   */
  webDir?: string;
}

export async function buildServer(
  config: Config,
  opts: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const { transport, logStream, onBackgroundWork, webDir } = opts;

  const loggerOpts =
    config.logLevel === 'silent'
      ? false
      : {
          level: config.logLevel,
          ...(logStream ? { stream: logStream } : {}),
          redact: {
            paths: ['req.headers.authorization', 'res.body.deviceToken'],
            censor: '[REDACTED]',
          },
        };

  const app = Fastify({
    logger: loggerOpts as FastifyBaseLogger | false,
    exposeHeadRoutes: false,
    bodyLimit: config.maxBlobBytes,
    ...(config.trustProxy ? { trustProxy: config.trustProxy } : {}),
  });

  // Open SQLite, run migrations before registering routes so the schema is
  // always up-to-date when handlers execute.
  const { db, raw: rawDb } = await openDb(config.dataDir);
  runMigrations(rawDb);

  app.decorate('db', db);
  app.decorate('rawDb', rawDb);

  // Decorate with metaStatus — tracks file_meta backfill state
  const metaStatus: MetaStatus = { backfill: 'idle' };
  app.decorate('metaStatus', metaStatus);

  // Close the database when the Fastify server closes so tests can clean
  // up their temp directories without leaving open WAL/SHM handles.
  app.addHook('onClose', async (_instance) => {
    rawDb.close();
  });

  // Decorate request with webUser (null by default; set by requireWebSession)
  app.decorateRequest('webUser', null);

  // Decorate request with webGroup (null by default; set by requireWebGroup)
  app.decorateRequest('webGroup', null);

  // Register cookie plugin (needed for web session)
  await app.register(fastifyCookie);

  // Register auth decorator — must come before any route that uses authenticate
  registerAuth(app);

  // Rate limiting — global:false means per-route opt-in only
  await app.register(rateLimit, { global: false });

  const storage = await import('./storage/filesystem-storage.js').then(
    (m) => new m.FilesystemStorage(config.dataDir, config.maxBlobBytes),
  );

  // CSP + nosniff hook: applies to all HTML responses (SPA pages)
  app.addHook('onSend', (_request, reply, _payload, done) => {
    const ct = reply.getHeader('content-type');
    if (typeof ct === 'string' && ct.includes('text/html')) {
      reply.header('Content-Security-Policy', CSP_VALUE);
      reply.header('X-Content-Type-Options', 'nosniff');
    }
    done();
  });

  await app.register(healthRoutes);
  await app.register(blobRoutes, { storage });
  await app.register(joinRoutes);
  await app.register(changesRoutes);
  await app.register(pushRoutes, { storage });

  // -------------------------------------------------------------------------
  // Web (SPA) routes — mailer required
  // -------------------------------------------------------------------------
  if (transport) {
    const publicUrl = config.publicUrl ?? 'http://localhost:8787';
    const mailer = createMailer(transport, {
      from: config.mailFrom,
      publicUrl,
    });

    await app.register(webAuthRoutes, { mailer, config, onBackgroundWork });
    await app.register(webGroupsRoutes, { config });
    await app.register(webInvitesRoutes);
    await app.register(webInviteCheckRoutes);

    // New read-only group routes (S8–S12)
    await app.register(groupReadRoutes);
    await app.register(noteRoutes, { storage });
    await app.register(conflictRoutes, { storage });
    await app.register(topicsRoutes);
  }

  // -------------------------------------------------------------------------
  // Static file serving (SPA)
  // Determine the web directory: explicit (tests), dist/web (prod), or absent (dev).
  // -------------------------------------------------------------------------
  const resolvedWebDir =
    webDir ??
    (() => {
      // In prod: dist/web (next to dist/main.js)
      const prodDir = fileURLToPath(new URL('./web', import.meta.url));
      return prodDir;
    })();

  const webDirExists = existsSync(resolvedWebDir);

  if (webDirExists) {
    await app.register(staticPlugin, {
      root: resolvedWebDir,
      wildcard: false,
      index: 'index.html',
    });
  }

  // -------------------------------------------------------------------------
  // Not-found handler — must come after all routes + static
  // -------------------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;

    // Safety net: traversal attempts on /api/blob/* → 400
    if (request.url.startsWith('/api/blob/') || rawUrl.startsWith('/api/blob/')) {
      return reply.status(400).send({ error: 'invalid hash' });
    }

    // Any /api/* path that wasn't matched → 404 JSON
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not found' });
    }

    // SPA fallback: GET requests that accept HTML
    if (request.method === 'GET' && webDirExists) {
      const accept = request.headers.accept ?? '';
      if (accept.includes('text/html') || accept.includes('*/*')) {
        // Add Referrer-Policy for sensitive routes
        const url = request.url;
        if (url === '/auth' || url.startsWith('/auth/') || url.startsWith('/j/')) {
          void reply.header('Referrer-Policy', 'no-referrer');
        }
        return reply.sendFile('index.html');
      }
    }

    return reply.status(404).send({ error: 'not found' });
  });

  // Start backfill in background — does not block listen()
  startBackfillBackground({
    db,
    storage,
    metaStatus,
    log: app.log as { warn(m: string, o?: unknown): void; info(m: string, o?: unknown): void },
  });

  return app;
}
