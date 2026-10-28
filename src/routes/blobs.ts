import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { isValidHash } from '../storage/blob-path.js';
import {
  BlobTooLargeError,
  HashMismatchError,
  InvalidHashError,
  type StoragePort,
} from '../storage/storage-port.js';

interface BlobPluginOptions {
  storage: StoragePort;
}

export async function blobRoutes(app: FastifyInstance, opts: BlobPluginOptions): Promise<void> {
  const { storage } = opts;

  // Blobs are opaque bytes: drop the built-in JSON/text parsers in this encapsulated
  // context so every PUT body arrives as the raw stream, whatever its Content-Type.
  // Routes outside this plugin keep Fastify's default parsers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => {
    done(null, payload);
  });

  // PUT /api/blob/:hash — store a blob
  app.put<{ Params: { hash: string } }>('/api/blob/:hash', async (request, reply) => {
    const { hash } = request.params;

    if (!isValidHash(hash)) {
      return reply.status(400).send({ error: 'invalid hash' });
    }

    // The plugin-level catch-all parser passes the raw stream as request.body.
    // An empty body arrives as undefined; wrap it in an empty readable.
    let body: Readable;
    if (request.body instanceof Readable) {
      body = request.body;
    } else if (request.body == null) {
      body = Readable.from([]);
    } else {
      // Unexpected body type — reject rather than silently coerce.
      return reply.status(400).send({ error: 'unexpected body type' });
    }

    const passthru = new PassThrough();
    body.pipe(passthru);

    try {
      const result = await storage.put(hash, passthru);
      const status = result.created ? 201 : 200;
      return reply.status(status).send({ hash, size: result.size });
    } catch (err) {
      if (err instanceof InvalidHashError) {
        return reply.status(400).send({ error: 'invalid hash' });
      }
      if (err instanceof HashMismatchError) {
        return reply.status(400).send({ error: 'hash mismatch' });
      }
      if (err instanceof BlobTooLargeError) {
        // Signal the client to stop sending. After the 413 response is flushed,
        // destroy the request socket so we do not drain an unbounded body.
        // In inject() mode request.raw.destroy() is a no-op, which is fine because
        // light-my-request has already buffered the full payload.
        reply.header('connection', 'close');
        reply.raw.once('finish', () => {
          if (!request.raw.destroyed) {
            request.raw.destroy();
          }
        });
        return reply.status(413).send({ error: 'blob too large' });
      }
      throw err;
    }
  });

  // GET /api/blob/:hash — retrieve a blob
  app.get<{ Params: { hash: string } }>('/api/blob/:hash', async (request, reply) => {
    const { hash } = request.params;

    if (!isValidHash(hash)) {
      return reply.status(400).send({ error: 'invalid hash' });
    }

    const blobSize = await storage.size(hash);
    if (blobSize === null) {
      return reply.status(404).send({ error: 'not found' });
    }

    const stream = await storage.get(hash);
    if (stream === null) {
      return reply.status(404).send({ error: 'not found' });
    }

    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(blobSize));
    return reply.status(200).send(stream);
  });

  // HEAD /api/blob/:hash — check existence and size
  app.head<{ Params: { hash: string } }>('/api/blob/:hash', async (request, reply) => {
    const { hash } = request.params;

    if (!isValidHash(hash)) {
      return reply.status(400).send();
    }

    const blobSize = await storage.size(hash);
    if (blobSize === null) {
      return reply.status(404).send();
    }

    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(blobSize));
    return reply.status(200).send();
  });
}
