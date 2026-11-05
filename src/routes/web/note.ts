import { diffLines } from '@chamba/core';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { redactEmail } from '../../auth/member-visibility.js';
import { requireWebGroup } from '../../auth/require-web-group.js';
import type { WebUser } from '../../auth/web-session.js';
import { blobRefs, changes, devices, fileMeta, files, users } from '../../db/schema.js';
import { pairLineDiff } from '../../meta/diff.js';
import { updateFileMetaFromBlob } from '../../meta/file-meta.js';
import { renderNote } from '../../meta/render.js';
import type { StoragePort } from '../../storage/storage-port.js';

// Allowed extensions for /raw — never text/html
const RAW_CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
};

// These are always served as attachment (forced download)
const ATTACHMENT_EXTS = new Set(['.pdf', '.svg']);

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

const RL_RAW = {
  config: {
    rateLimit: {
      max: 600,
      timeWindow: '1 minute',
      keyGenerator: (req: { cookies: Record<string, string | undefined> }) =>
        req.cookies?.['parche_session'] ?? 'anon',
    },
  },
};

function getExt(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot).toLowerCase();
}

function isSafePath(path: string): boolean {
  if (!path) return false;
  if (path.includes('\0')) return false;
  if (path.includes('..')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  return true;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

export interface NoteRouteOpts {
  storage: StoragePort;
}

export async function noteRoutes(app: FastifyInstance, opts: NoteRouteOpts): Promise<void> {
  const { storage } = opts;

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/note?path=
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    '/api/web/g/:slug/note',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId, slug } = request.webGroup!;
      const viewerRole = request.webGroup!.role;
      const viewerUserId = (request.webUser as WebUser).id;
      const path = request.query.path ?? '';

      if (!isSafePath(path)) {
        return reply.status(400).send({ error: 'invalid_path' });
      }

      const fileRow = app.db
        .select({ headHash: files.headHash, headSeq: files.headSeq })
        .from(files)
        .where(and(eq(files.groupId, groupId), eq(files.path, path), isNotNull(files.headHash)))
        .get();

      if (!fileRow?.headHash) {
        return reply.status(404).send({ error: 'not_found' });
      }

      // Head change info
      const headChange = app.db
        .select({
          seq: changes.seq,
          at: changes.at,
          userId: changes.userId,
          userName: users.name,
          userEmail: users.email,
          deviceLabel: devices.label,
        })
        .from(changes)
        .innerJoin(users, eq(changes.userId, users.id))
        .innerJoin(devices, eq(changes.deviceId, devices.id))
        .where(and(eq(changes.groupId, groupId), eq(changes.seq, fileRow.headSeq)))
        .get();

      // Versions (≤50)
      const versions = app.db
        .select({
          seq: changes.seq,
          hash: changes.hash,
          at: changes.at,
          userName: users.name,
          deviceLabel: devices.label,
        })
        .from(changes)
        .innerJoin(users, eq(changes.userId, users.id))
        .innerJoin(devices, eq(changes.deviceId, devices.id))
        .where(and(eq(changes.groupId, groupId), eq(changes.path, path), isNotNull(changes.hash)))
        .orderBy(desc(changes.seq))
        .limit(50)
        .all();

      // Get or on-demand extract meta
      let meta = app.db
        .select()
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), eq(fileMeta.path, path)))
        .get();

      let metaPending = false;
      if (!meta || meta.hash !== fileRow.headHash) {
        await updateFileMetaFromBlob(
          { db: app.db, storage, log: app.log as { warn: (m: string, o?: unknown) => void } },
          groupId,
          path,
          fileRow.headHash,
        );
        meta = app.db
          .select()
          .from(fileMeta)
          .where(and(eq(fileMeta.groupId, groupId), eq(fileMeta.path, path)))
          .get();
        if (!meta) metaPending = true;
      }

      // Backlinks: other *live* files in this group that link to this path.
      // We inner-join with `files` on (groupId, path) and require head_hash IS NOT NULL
      // so that tombstoned files are excluded — the same criterion used by /conflicts.
      const allMeta = app.db
        .select({ path: fileMeta.path, title: fileMeta.title, linksJson: fileMeta.linksJson })
        .from(fileMeta)
        .innerJoin(
          files,
          and(
            eq(files.groupId, fileMeta.groupId),
            eq(files.path, fileMeta.path),
            isNotNull(files.headHash),
          ),
        )
        .where(and(eq(fileMeta.groupId, groupId), isNotNull(fileMeta.linksJson)))
        .all();

      const backlinks: Array<{ path: string; title?: string; snippet?: string }> = [];
      for (const m of allMeta) {
        if (!m.linksJson || m.path === path) continue;
        try {
          const links = JSON.parse(m.linksJson) as Array<{
            target: string;
            snippet?: string;
          }>;
          for (const link of links) {
            const t = link.target;
            // NOTE: suffix matching is intentionally lax — [[README]] matches any
            // */README.md path in the vault. This is a deliberate trade-off: it
            // avoids requiring callers to use full paths in wikilinks.
            if (
              t === path ||
              t + '.md' === path ||
              path.endsWith('/' + t) ||
              path.endsWith('/' + t + '.md')
            ) {
              backlinks.push({ path: m.path, title: m.title ?? undefined, snippet: link.snippet });
              break;
            }
          }
        } catch {
          // malformed JSON — skip
        }
      }

      // Known paths for wikilink resolution in render
      const knownPaths = new Set(
        app.db
          .select({ path: files.path })
          .from(files)
          .where(and(eq(files.groupId, groupId), isNotNull(files.headHash)))
          .all()
          .map((f) => f.path),
      );

      // Render HTML
      let html = '';
      const blobStream = await storage.get(fileRow.headHash);
      if (blobStream) {
        const content = (await readStream(blobStream)).toString('utf8');
        html = renderNote(content, slug, knownPaths);
      }

      const tags = meta?.tagsJson ? (JSON.parse(meta.tagsJson) as string[]) : [];

      return reply.status(200).send({
        path,
        title: meta?.title ?? null,
        metaPending,
        meta: meta
          ? {
              title: meta.title,
              summary: meta.summary,
              type: meta.type,
              tags,
              workItem: meta.workItem,
              project: meta.project,
              conflictOf: meta.conflictOf,
              conflictBase: meta.conflictBase,
            }
          : null,
        head: headChange
          ? {
              hash: fileRow.headHash,
              hashShort: fileRow.headHash.slice(0, 7),
              seq: headChange.seq,
              at: headChange.at,
              user: {
                name: headChange.userName,
                ...(redactEmail(
                  headChange.userEmail,
                  headChange.userId,
                  viewerUserId,
                  viewerRole,
                ) !== undefined
                  ? { email: headChange.userEmail }
                  : {}),
              },
              deviceLabel: headChange.deviceLabel,
            }
          : null,
        versions: versions.map((v) => ({
          seq: v.seq,
          hash: v.hash,
          hashShort: v.hash?.slice(0, 7),
          at: v.at,
          user: v.userName,
          deviceLabel: v.deviceLabel,
        })),
        backlinks,
        html,
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/note/version?path=&seq=
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { path?: string; seq?: string } }>(
    '/api/web/g/:slug/note/version',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const path = request.query.path ?? '';
      const seqRaw = parseInt(request.query.seq ?? '', 10);

      if (!isSafePath(path)) {
        return reply.status(400).send({ error: 'invalid_path' });
      }
      if (Number.isNaN(seqRaw) || seqRaw < 1) {
        return reply.status(400).send({ error: 'invalid_seq' });
      }

      const changeRow = app.db
        .select({ hash: changes.hash })
        .from(changes)
        .where(
          and(
            eq(changes.groupId, groupId),
            eq(changes.seq, seqRaw),
            eq(changes.path, path),
            isNotNull(changes.hash),
          ),
        )
        .get();

      if (!changeRow?.hash) {
        return reply.status(404).send({ error: 'not_found' });
      }

      // Verify blob belongs to group
      const blobRef = app.db
        .select()
        .from(blobRefs)
        .where(and(eq(blobRefs.groupId, groupId), eq(blobRefs.hash, changeRow.hash)))
        .get();

      if (!blobRef) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const stream = await storage.get(changeRow.hash);
      if (!stream) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const content = (await readStream(stream)).toString('utf8');
      return reply.status(200).send({ path, seq: seqRaw, hash: changeRow.hash, content });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/diff?path=&from=<seq>&to=<seq>
  // -------------------------------------------------------------------------
  app.get<{
    Params: { slug: string };
    Querystring: { path?: string; from?: string; to?: string };
  }>(
    '/api/web/g/:slug/diff',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const path = request.query.path ?? '';
      const fromSeq = parseInt(request.query.from ?? '', 10);
      const toSeq = parseInt(request.query.to ?? '', 10);

      if (!isSafePath(path)) {
        return reply.status(400).send({ error: 'invalid_path' });
      }
      if (Number.isNaN(fromSeq) || Number.isNaN(toSeq)) {
        return reply.status(400).send({ error: 'invalid_seq' });
      }

      const MAX_DIFF_BYTES = 256 * 1024;

      async function getVersionContent(seq: number): Promise<string | null> {
        const row = app.db
          .select({ hash: changes.hash })
          .from(changes)
          .where(
            and(
              eq(changes.groupId, groupId),
              eq(changes.seq, seq),
              eq(changes.path, path),
              isNotNull(changes.hash),
            ),
          )
          .get();
        if (!row?.hash) return null;
        const ref = app.db
          .select()
          .from(blobRefs)
          .where(and(eq(blobRefs.groupId, groupId), eq(blobRefs.hash, row.hash)))
          .get();
        if (!ref) return null;
        const stream = await storage.get(row.hash);
        if (!stream) return null;
        const buf = await readStream(stream);
        if (buf.length > MAX_DIFF_BYTES) return null;
        return buf.toString('utf8');
      }

      const [fromContent, toContent] = await Promise.all([
        getVersionContent(fromSeq),
        getVersionContent(toSeq),
      ]);

      if (fromContent === null || toContent === null) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const rawDiff = diffLines(fromContent, toContent);
      const entries = pairLineDiff(rawDiff);

      return reply.status(200).send({ path, from: fromSeq, to: toSeq, diff: entries });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/raw?path=[&seq=]  (D3)
  // Never text/html. Always X-Content-Type-Options: nosniff.
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { path?: string; seq?: string } }>(
    '/api/web/g/:slug/raw',
    { preHandler: [requireWebGroup('read')], ...RL_RAW },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const path = request.query.path ?? '';

      if (!isSafePath(path)) {
        return reply.status(400).send({ error: 'invalid_path' });
      }

      const ext = getExt(path);
      const contentType = RAW_CONTENT_TYPES[ext];
      if (!contentType) {
        return reply.status(415).send({ error: 'unsupported_type' });
      }

      let hash: string;

      if (request.query.seq !== undefined) {
        const seqRaw = parseInt(request.query.seq, 10);
        if (Number.isNaN(seqRaw) || seqRaw < 1) {
          return reply.status(400).send({ error: 'invalid_seq' });
        }
        const changeRow = app.db
          .select({ hash: changes.hash })
          .from(changes)
          .where(
            and(
              eq(changes.groupId, groupId),
              eq(changes.seq, seqRaw),
              eq(changes.path, path),
              isNotNull(changes.hash),
            ),
          )
          .get();
        if (!changeRow?.hash) return reply.status(404).send({ error: 'not_found' });
        const ref = app.db
          .select()
          .from(blobRefs)
          .where(and(eq(blobRefs.groupId, groupId), eq(blobRefs.hash, changeRow.hash)))
          .get();
        if (!ref) return reply.status(404).send({ error: 'not_found' });
        hash = changeRow.hash;
      } else {
        const fileRow = app.db
          .select({ headHash: files.headHash })
          .from(files)
          .where(and(eq(files.groupId, groupId), eq(files.path, path), isNotNull(files.headHash)))
          .get();
        if (!fileRow?.headHash) return reply.status(404).send({ error: 'not_found' });
        hash = fileRow.headHash;
      }

      const stream = await storage.get(hash);
      if (!stream) return reply.status(404).send({ error: 'not_found' });

      const buf = await readStream(stream);

      reply.header('Content-Type', contentType);
      reply.header('X-Content-Type-Options', 'nosniff');

      if (ATTACHMENT_EXTS.has(ext)) {
        const filename = encodeURIComponent(path.split('/').pop() ?? 'file');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      }

      return reply.status(200).send(buf);
    },
  );
}
