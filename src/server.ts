import rateLimit from '@fastify/rate-limit';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { registerAuth } from './auth/plugin.js';
import type { Config } from './config.js';
import type { AppDb, RawDb } from './db/client.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { blobRoutes } from './routes/blobs.js';
import { changesRoutes } from './routes/changes.js';
import { healthRoutes } from './routes/health.js';
import { joinRoutes } from './routes/join.js';
import { pushRoutes } from './routes/push.js';
import { FilesystemStorage } from './storage/filesystem-storage.js';

// ---------------------------------------------------------------------------
// Fastify instance decoration typings
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDb;
    rawDb: RawDb;
  }
}

export async function buildServer(
  config: Config,
  logStream?: NodeJS.WritableStream,
): Promise<FastifyInstance> {
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

  // Close the database when the Fastify server closes so tests can clean
  // up their temp directories without leaving open WAL/SHM handles.
  app.addHook('onClose', async (_instance) => {
    rawDb.close();
  });

  // Register auth decorator — must come before any route that uses authenticate
  registerAuth(app);

  // Rate limiting — global:false means per-route opt-in only (join uses it)
  await app.register(rateLimit, { global: false });

  const storage = new FilesystemStorage(config.dataDir, config.maxBlobBytes);

  await app.register(healthRoutes);
  await app.register(blobRoutes, { storage });
  await app.register(joinRoutes);
  await app.register(changesRoutes);
  await app.register(pushRoutes);

  // Safety net: any /api/blob/* path that reaches the not-found handler returns 400,
  // so path traversal attempts are never silently 404'd.
  //
  // Why both request.url and request.raw.url are checked:
  //   - request.url is the URL after Fastify/find-my-way normalises it for routing.
  //     For a real-HTTP request with path `/api/blob/../etc/passwd`, find-my-way
  //     resolves the traversal to `/api/etc/passwd`, so request.url loses the
  //     `/api/blob/` prefix and the first check alone would not catch it.
  //   - request.raw.url is Node.js's IncomingMessage.url — the raw bytes exactly as
  //     received over the TCP socket, NEVER normalised by Node.js itself.
  //     For the same traversal path it still starts with `/api/blob/`, so the second
  //     check catches it and correctly returns 400.
  //
  // In inject() mode (light-my-request), raw.url IS normalised before the fake
  // IncomingMessage is created, so both checks see `/api/etc/passwd` and the
  // handler returns 404 for the traversal path. The real-HTTP test in
  // src/routes/blobs.test.ts is the authoritative proof of 400 over the wire.
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url ?? request.url;
    if (request.url.startsWith('/api/blob/') || rawUrl.startsWith('/api/blob/')) {
      return reply.status(400).send({ error: 'invalid hash' });
    }
    return reply.status(404).send({ error: 'not found' });
  });

  return app;
}
