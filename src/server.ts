import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { blobRoutes } from './routes/blobs.js';
import { healthRoutes } from './routes/health.js';
import { FilesystemStorage } from './storage/filesystem-storage.js';

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    exposeHeadRoutes: false,
    bodyLimit: config.maxBlobBytes,
  });

  const storage = new FilesystemStorage(config.dataDir, config.maxBlobBytes);

  await app.register(healthRoutes);
  await app.register(blobRoutes, { storage });

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
