import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth/plugin.js';
import type { Config } from '../config.js';
import { blobRefs } from '../db/schema.js';
import { parseAllowHeader } from '../secrets/allow-header.js';
import { kindsOf, SCAN_MAX_BYTES, scanBuffer } from '../secrets/scan-blob.js';
import { isValidHash } from '../storage/blob-path.js';
import {
  BlobTooLargeError,
  HashMismatchError,
  InvalidHashError,
  type StoragePort,
} from '../storage/storage-port.js';

interface BlobPluginOptions {
  storage: StoragePort;
  /** PARCHE-012 — report|block. Defaults to 'report' (CHAMBA-023 aún no publicado). */
  secretGate?: Config['secretGate'];
}

/**
 * Consume `body` reading at most `SCAN_MAX_BYTES + 1` bytes into memory via a
 * single async iterator (B1): the prefix is read with `it.next()` — never a
 * `for await` `break`, which would leave the rest of the stream unconsumed and
 * unusable. If the stream ends within the threshold, the whole body is
 * returned as a Buffer (scannable). Otherwise a re-emitting Readable is
 * returned that yields the buffered prefix and then drains the same iterator
 * for the rest — no bytes are dropped or duplicated, and the hash computed by
 * `storage.put` over it is identical to the hash of the bytes the client sent.
 */
async function readBoundedPrefix(
  body: Readable,
): Promise<{ buffer: Buffer } | { stream: Readable }> {
  const it = body[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  const chunks: Buffer[] = [];
  let total = 0;
  let streamDone = false;

  for (;;) {
    const r = await it.next();
    if (r.done) {
      streamDone = true;
      break;
    }
    const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
    chunks.push(chunk);
    total += chunk.length;
    if (total > SCAN_MAX_BYTES) break;
  }

  if (streamDone) {
    return { buffer: Buffer.concat(chunks) };
  }

  async function* rest(): AsyncGenerator<Buffer> {
    yield* chunks;
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      yield Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
    }
  }

  return { stream: Readable.from(rest()) };
}

export async function blobRoutes(app: FastifyInstance, opts: BlobPluginOptions): Promise<void> {
  const { storage } = opts;
  const secretGate = opts.secretGate ?? 'report';

  // Blobs are opaque bytes: drop the built-in JSON/text parsers in this encapsulated
  // context so every PUT body arrives as the raw stream, whatever its Content-Type.
  // Routes outside this plugin keep Fastify's default parsers.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => {
    done(null, payload);
  });

  // PUT /api/blob/:hash — store a blob (auth required; upserts blob_refs)
  app.put<{ Params: { hash: string } }>(
    '/api/blob/:hash',
    { preHandler: [authenticate] },
    async (request, reply) => {
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

      // A1/A2 (PARCHE-012) — PUT has no path, so isScannable doesn't apply here;
      // the gate is content-based: ≤ SCAN_MAX_BYTES and strict UTF-8. Reads at
      // most SCAN_MAX_BYTES + 1 bytes into memory via a single iterator (B1),
      // so a 20 MiB body never costs more than ~2 MiB of memory for this check.
      const prefix = await readBoundedPrefix(body);
      const { groupId, userId, deviceId } = request.auth;

      if ('buffer' in prefix) {
        const findings = await scanBuffer(prefix.buffer, 'blob');
        if (findings !== null && findings.length > 0) {
          const allowed = parseAllowHeader(request.headers['x-parche-secret-allow']);
          const kinds = kindsOf(findings);
          const allAllowed = findings.every((f) => allowed.has(f.fingerprint));

          if (allAllowed) {
            request.log.info(
              { groupId, userId, deviceId, kinds, allowed: true },
              'blob: secret allowlisted',
            );
          } else if (secretGate === 'block') {
            request.log.warn(
              { groupId, userId, deviceId, kinds, allowed: false },
              'blob rejected: secret_detected',
            );
            return reply.status(422).send({ error: 'secret_detected', kinds });
          } else {
            request.log.warn(
              { groupId, userId, deviceId, kinds, allowed: false, mode: 'report' },
              'blob: secret detected (report mode)',
            );
          }
        }
      }
      // else: body > SCAN_MAX_BYTES — not scanned (documented limitation, A2).

      const storeInput = 'buffer' in prefix ? prefix.buffer : prefix.stream;

      try {
        const result = await storage.put(hash, storeInput);
        // Upsert blob_refs to track which group owns this blob
        request.server.db
          .insert(blobRefs)
          .values({ groupId: request.auth.groupId, hash })
          .onConflictDoNothing()
          .run();
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
    },
  );

  // GET /api/blob/:hash — retrieve a blob (auth required; scoped to token's group)
  app.get<{ Params: { hash: string } }>(
    '/api/blob/:hash',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { hash } = request.params;

      if (!isValidHash(hash)) {
        return reply.status(400).send({ error: 'invalid hash' });
      }

      // Check blob_refs for this group — prevents cross-group access
      const ref = request.server.db
        .select()
        .from(blobRefs)
        .where(and(eq(blobRefs.groupId, request.auth.groupId), eq(blobRefs.hash, hash)))
        .get();
      if (!ref) {
        return reply.status(404).send({ error: 'not found' });
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
    },
  );

  // HEAD /api/blob/:hash — check existence and size (auth required; scoped to token's group)
  app.head<{ Params: { hash: string } }>(
    '/api/blob/:hash',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { hash } = request.params;

      if (!isValidHash(hash)) {
        return reply.status(400).send();
      }

      // Check blob_refs for this group — prevents cross-group access
      const ref = request.server.db
        .select()
        .from(blobRefs)
        .where(and(eq(blobRefs.groupId, request.auth.groupId), eq(blobRefs.hash, hash)))
        .get();
      if (!ref) {
        return reply.status(404).send();
      }

      const blobSize = await storage.size(hash);
      if (blobSize === null) {
        return reply.status(404).send();
      }

      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(blobSize));
      return reply.status(200).send();
    },
  );
}
