import { diffLines } from '@chamba/core';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireWebGroup } from '../../auth/require-web-group.js';
import { changes, devices, fileMeta, files, users } from '../../db/schema.js';
import { pairLineDiff } from '../../meta/diff.js';
import type { StoragePort } from '../../storage/storage-port.js';

const RL_READ = {
  config: {
    rateLimit: {
      max: 300,
      timeWindow: '1 minute',
      keyGenerator: (req: { cookies: Record<string, string | undefined> }) =>
        req.cookies?.['parche_session'] ?? 'anon',
    },
  },
};

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ConflictRouteOpts {
  storage: StoragePort;
}

export async function conflictRoutes(app: FastifyInstance, opts: ConflictRouteOpts): Promise<void> {
  const { storage } = opts;

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/conflicts
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/g/:slug/conflicts',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;

      const conflictMetas = app.db
        .select({
          path: fileMeta.path,
          conflictOf: fileMeta.conflictOf,
          conflictBase: fileMeta.conflictBase,
        })
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), isNotNull(fileMeta.conflictOf)))
        .all();

      const result = [];
      for (const m of conflictMetas) {
        const fileRow = app.db
          .select({ headHash: files.headHash, headSeq: files.headSeq })
          .from(files)
          .where(and(eq(files.groupId, groupId), eq(files.path, m.path), isNotNull(files.headHash)))
          .get();
        if (!fileRow) continue;

        const headChange = app.db
          .select({ at: changes.at, userName: users.name })
          .from(changes)
          .innerJoin(users, eq(changes.userId, users.id))
          .where(and(eq(changes.groupId, groupId), eq(changes.seq, fileRow.headSeq)))
          .get();

        result.push({
          copyPath: m.path,
          originalPath: m.conflictOf,
          base: m.conflictBase,
          autorCopia: headChange?.userName ?? null,
          at: headChange?.at ?? null,
        });
      }

      return reply.status(200).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/conflicts/view?copyPath=
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { copyPath?: string } }>(
    '/api/web/g/:slug/conflicts/view',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const copyPath = request.query.copyPath ?? '';

      if (!copyPath || copyPath.includes('..') || copyPath.includes('\0')) {
        return reply.status(400).send({ error: 'invalid_path' });
      }

      const copyMeta = app.db
        .select()
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), eq(fileMeta.path, copyPath)))
        .get();

      if (!copyMeta?.conflictOf) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const originalPath = copyMeta.conflictOf;

      interface FileInfo {
        path: string;
        hash: string;
        hashShort: string;
        content: string;
        author: string | null;
        device: string | null;
        at: string | null;
      }

      async function getFileInfo(path: string): Promise<FileInfo | null> {
        const fileRow = app.db
          .select({ headHash: files.headHash, headSeq: files.headSeq })
          .from(files)
          .where(and(eq(files.groupId, groupId), eq(files.path, path), isNotNull(files.headHash)))
          .get();
        if (!fileRow?.headHash) return null;

        const headChange = app.db
          .select({
            at: changes.at,
            userName: users.name,
            deviceLabel: devices.label,
          })
          .from(changes)
          .innerJoin(users, eq(changes.userId, users.id))
          .innerJoin(devices, eq(changes.deviceId, devices.id))
          .where(and(eq(changes.groupId, groupId), eq(changes.seq, fileRow.headSeq)))
          .get();

        const stream = await storage.get(fileRow.headHash);
        const content = stream ? await readStream(stream) : '';

        return {
          path,
          hash: fileRow.headHash,
          hashShort: fileRow.headHash.slice(0, 7),
          content,
          author: headChange?.userName ?? null,
          device: headChange?.deviceLabel ?? null,
          at: headChange?.at ?? null,
        };
      }

      const [original, copy] = await Promise.all([
        getFileInfo(originalPath),
        getFileInfo(copyPath),
      ]);

      const rawDiff = diffLines(original?.content ?? '', copy?.content ?? '');
      const diff = pairLineDiff(rawDiff);

      return reply.status(200).send({
        copyPath,
        originalPath,
        base: copyMeta.conflictBase,
        original,
        copy,
        diff,
      });
    },
  );
}
