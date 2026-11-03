import { and, asc, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requireWebGroup } from '../../auth/require-web-group.js';
import { changes, devices, fileMeta, files, groups, members, users } from '../../db/schema.js';

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

function isSafePath(path: string): boolean {
  if (!path) return true; // empty = root, ok
  if (path.includes('\0')) return false;
  if (path.includes('..')) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  return true;
}

export async function groupReadRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/summary
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string } }>(
    '/api/web/g/:slug/summary',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId, slug, role } = request.webGroup!;

      const grp = app.db
        .select({ name: groups.name })
        .from(groups)
        .where(eq(groups.id, groupId))
        .get();

      // Live files
      const liveFiles = app.db
        .select({ path: files.path })
        .from(files)
        .where(and(eq(files.groupId, groupId), isNotNull(files.headHash)))
        .all();

      const notes = liveFiles.filter((f) => f.path.endsWith('.md')).length;

      // Count distinct folder prefixes
      const folderSet = new Set<string>();
      for (const f of liveFiles) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          folderSet.add(parts.slice(0, i).join('/'));
        }
      }
      const folders = folderSet.size;

      // Conflicts from file_meta
      const livePathSet = new Set(liveFiles.map((f) => f.path));
      const conflictMetas = app.db
        .select({ path: fileMeta.path })
        .from(fileMeta)
        .where(and(eq(fileMeta.groupId, groupId), isNotNull(fileMeta.conflictOf)))
        .all();
      const conflicts = conflictMetas.filter((m) => livePathSet.has(m.path)).length;

      // Last change
      const lastChange = app.db
        .select({ at: changes.at })
        .from(changes)
        .where(eq(changes.groupId, groupId))
        .orderBy(desc(changes.seq))
        .limit(1)
        .get();

      // Active members
      const memberRows = app.db
        .select({ name: users.name, email: users.email, role: members.role })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(members.groupId, groupId), isNull(members.removedAt)))
        .all();

      return reply.status(200).send({
        group: { slug, name: grp?.name ?? slug, role },
        notes,
        folders,
        conflicts,
        lastChangeAt: lastChange?.at ?? null,
        members: memberRows.map((m) => ({ name: m.name, email: m.email, role: m.role })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/tree?path=
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { path?: string } }>(
    '/api/web/g/:slug/tree',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;
      const reqPath = (request.query.path ?? '').replace(/^\/+|\/+$/g, '');

      if (!isSafePath(reqPath)) {
        return reply.status(400).send({ error: 'invalid_path' });
      }

      const liveFiles = app.db
        .select({ path: files.path, headHash: files.headHash })
        .from(files)
        .where(and(eq(files.groupId, groupId), isNotNull(files.headHash)))
        .all();

      const prefix = reqPath ? reqPath + '/' : '';
      const dirCounts = new Map<string, number>();
      const fileItems: Array<{ name: string; title?: string; hash: string }> = [];

      for (const f of liveFiles) {
        if (!f.path.startsWith(prefix)) continue;
        const rest = f.path.slice(prefix.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx === -1) {
          // Direct file child
          const meta = app.db
            .select({ title: fileMeta.title })
            .from(fileMeta)
            .where(and(eq(fileMeta.groupId, groupId), eq(fileMeta.path, f.path)))
            .get();
          fileItems.push({ name: rest, title: meta?.title ?? undefined, hash: f.headHash! });
        } else {
          const dirName = rest.slice(0, slashIdx);
          dirCounts.set(dirName, (dirCounts.get(dirName) ?? 0) + 1);
        }
      }

      const sortedDirs = Array.from(dirCounts.entries()).sort((a, b) =>
        a[0].toLowerCase().localeCompare(b[0].toLowerCase()),
      );
      const sortedFiles = fileItems.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );

      type TreeItem =
        | { name: string; type: 'dir'; count: number }
        | { name: string; type: 'file'; title?: string; hash: string };

      const result: TreeItem[] = [];
      for (const [name, count] of sortedDirs) {
        result.push({ name, type: 'dir', count });
      }
      for (const f of sortedFiles.slice(0, 200)) {
        result.push({ name: f.name, type: 'file', title: f.title, hash: f.hash });
      }

      return reply.status(200).send({ path: reqPath, items: result });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/web/g/:slug/activity?before=<seq>&limit=50
  // -------------------------------------------------------------------------
  app.get<{ Params: { slug: string }; Querystring: { before?: string; limit?: string } }>(
    '/api/web/g/:slug/activity',
    { preHandler: [requireWebGroup('read')], ...RL_READ },
    async (request, reply) => {
      const { groupId } = request.webGroup!;

      const limitRaw = parseInt(request.query.limit ?? '50', 10);
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(100, Math.max(1, limitRaw));

      const beforeRaw =
        request.query.before !== undefined ? parseInt(request.query.before, 10) : undefined;
      const before = beforeRaw !== undefined && !Number.isNaN(beforeRaw) ? beforeRaw : undefined;

      const rows = app.db
        .select({
          seq: changes.seq,
          path: changes.path,
          hash: changes.hash,
          at: changes.at,
          userId: changes.userId,
          deviceId: changes.deviceId,
          userName: users.name,
          userEmail: users.email,
          deviceLabel: devices.label,
        })
        .from(changes)
        .innerJoin(users, eq(changes.userId, users.id))
        .innerJoin(devices, eq(changes.deviceId, devices.id))
        .where(
          before !== undefined
            ? and(eq(changes.groupId, groupId), lt(changes.seq, before))
            : eq(changes.groupId, groupId),
        )
        .orderBy(desc(changes.seq))
        .limit(limit + 1)
        .all();

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // Gather file_meta for project/work_item
      const pathSet = new Set(page.map((r) => r.path));
      const metaMap = new Map<string, { project?: string; workItem?: string }>();
      if (pathSet.size > 0) {
        const metaRows = app.db
          .select({
            path: fileMeta.path,
            project: fileMeta.project,
            workItem: fileMeta.workItem,
          })
          .from(fileMeta)
          .where(eq(fileMeta.groupId, groupId))
          .all();
        for (const m of metaRows) {
          if (pathSet.has(m.path)) {
            metaMap.set(m.path, {
              project: m.project ?? undefined,
              workItem: m.workItem ?? undefined,
            });
          }
        }
      }

      // D5: detect renames — tombstone A + create B with same user+device+at
      // Group by user+device+at
      type RowType = (typeof page)[number];
      const byKey = new Map<string, RowType[]>();
      for (const row of page) {
        const key = `${row.userId}|${row.deviceId}|${row.at}`;
        const g = byKey.get(key) ?? [];
        g.push(row);
        byKey.set(key, g);
      }

      interface ActivityEvent {
        seq: number;
        path: string;
        verb: string;
        hash: string | null;
        hashCorto?: string;
        user: { name: string; email: string };
        deviceLabel: string;
        at: string;
        project?: string;
        workItem?: string;
        renamedTo?: string;
        /** Number of saves collapsed into this event by the 10-min grouping window. */
        count?: number;
      }

      // D5: Pre-pass rename detection.
      // A rename is: tombstone for path A + create for path B with same userId+deviceId+at,
      // where the hash of B equals the last known non-null hash of A (from `changes`).
      // This pre-pass runs before we emit events so order (desc seq) doesn't affect detection.
      //
      // Pagination note: if a rename pair straddles a page boundary (tombstone on one page,
      // create on the other), it will not be detected as a rename; each half will appear as
      // its own event. This is acceptable since rename pairs are always consecutive seqs
      // (same push) and page sizes are large enough (default 50) to keep them together.
      interface RenamePair {
        tombstoneSeq: number;
        createSeq: number;
        tombstonePath: string;
        createPath: string;
        createHash: string;
        tombstoneRow: (typeof page)[number];
      }

      const renamePairs = new Map<number, RenamePair>(); // keyed by tombstoneSeq
      const consumedSeqs = new Set<number>();

      for (const [, grpRows] of byKey) {
        if (grpRows.length < 2) continue;

        const tombstones = grpRows.filter((r) => r.hash === null);
        const creates = grpRows.filter((r) => r.hash !== null);

        if (tombstones.length === 0 || creates.length === 0) continue;

        for (const tombstone of tombstones) {
          // Look up the last non-null hash for the tombstoned path before the tombstone seq
          const lastChange = app.db
            .select({ hash: changes.hash })
            .from(changes)
            .where(
              and(
                eq(changes.groupId, groupId),
                eq(changes.path, tombstone.path),
                lt(changes.seq, tombstone.seq),
                isNotNull(changes.hash),
              ),
            )
            .orderBy(desc(changes.seq))
            .limit(1)
            .get();

          const lastHash = lastChange?.hash ?? null;
          if (!lastHash) continue; // No prior hash → can't confirm content equality

          // Find a create on this page whose hash matches the tombstone path's last hash
          const matchingCreate = creates.find((r) => r.hash === lastHash);
          if (!matchingCreate) continue;

          // Valid rename pair
          renamePairs.set(tombstone.seq, {
            tombstoneSeq: tombstone.seq,
            createSeq: matchingCreate.seq,
            tombstonePath: tombstone.path,
            createPath: matchingCreate.path,
            createHash: matchingCreate.hash!,
            tombstoneRow: tombstone,
          });
          consumedSeqs.add(tombstone.seq);
          consumedSeqs.add(matchingCreate.seq);
        }
      }

      // D6: Cache the first-ever create seq per path — one DB query per unique path on the page.
      // isFirst is an absolute property (not relative to the page); the cache key is path only
      // because a path's "first create ever" does not change within a single response.
      const firstCreateSeqCache = new Map<string, number | null>();
      const getFirstCreateSeq = (path: string): number | null => {
        if (firstCreateSeqCache.has(path)) return firstCreateSeqCache.get(path)!;
        const first = app.db
          .select({ seq: changes.seq })
          .from(changes)
          .where(and(eq(changes.groupId, groupId), eq(changes.path, path), isNotNull(changes.hash)))
          .orderBy(asc(changes.seq))
          .limit(1)
          .get();
        const result = first?.seq ?? null;
        firstCreateSeqCache.set(path, result);
        return result;
      };

      const rawEvents: ActivityEvent[] = [];

      for (const row of page) {
        if (consumedSeqs.has(row.seq)) {
          // Emit rename event only when we hit the tombstone row (the lower seq)
          const pair = renamePairs.get(row.seq);
          if (pair) {
            const meta = metaMap.get(pair.createPath) ?? {};
            rawEvents.push({
              seq: Math.max(pair.tombstoneSeq, pair.createSeq),
              path: pair.tombstonePath,
              verb: 'renombró',
              hash: pair.createHash,
              hashCorto: pair.createHash.slice(0, 7),
              user: {
                name: pair.tombstoneRow.userName,
                email: pair.tombstoneRow.userEmail,
              },
              deviceLabel: pair.tombstoneRow.deviceLabel,
              at: pair.tombstoneRow.at,
              project: meta.project ?? undefined,
              workItem: meta.workItem ?? undefined,
              renamedTo: pair.createPath,
            });
          }
          // Skip consumed create rows (already handled above)
          continue;
        }

        const meta = metaMap.get(row.path) ?? {};
        let verb: string;
        if (row.hash === null) {
          verb = 'borró';
        } else {
          // isFirst: true only if this row's seq is the very first non-null change for this
          // path in the group (absolute, not relative to the current page).
          const firstSeq = getFirstCreateSeq(row.path);
          const isFirst = firstSeq === row.seq;
          verb = isFirst ? 'creó' : 'guardó';
        }

        rawEvents.push({
          seq: row.seq,
          path: row.path,
          verb,
          hash: row.hash,
          hashCorto: row.hash?.slice(0, 7),
          user: { name: row.userName, email: row.userEmail },
          deviceLabel: row.deviceLabel,
          at: row.at,
          project: meta.project ?? undefined,
          workItem: meta.workItem ?? undefined,
        });
      }

      // D7: 10-min grouping.
      // Consecutive saves by the same user on the same path within a 10-minute sliding window
      // (consecutive = no other save for that user+path between them in the activity log)
      // are collapsed into a single event with `count`. Uses email as user key.
      // Renames and deletions are never merged.
      const TEN_MIN_MS = 10 * 60 * 1000;
      const events: ActivityEvent[] = [];
      // Maps userId|path → index in `events` for the last event of that combo
      const lastEventIdx = new Map<string, number>();

      for (const event of rawEvents) {
        const isGroupable =
          event.verb !== 'renombró' && event.verb !== 'borró' && event.hash !== null;

        if (isGroupable) {
          const key = `${event.user.email}|${event.path}`;
          const lastIdx = lastEventIdx.get(key);
          if (lastIdx !== undefined) {
            const last = events[lastIdx]!;
            const timeDiff = Math.abs(new Date(last.at).getTime() - new Date(event.at).getTime());
            if (timeDiff <= TEN_MIN_MS) {
              // Merge into the existing representative (the more recent one in events[])
              last.count = (last.count ?? 1) + 1;
              continue;
            }
          }
        }

        events.push({ ...event, count: isGroupable ? 1 : undefined });
        if (isGroupable) {
          lastEventIdx.set(`${event.user.email}|${event.path}`, events.length - 1);
        }
      }

      // Stable pagination cursor: min seq consumed on this page (= last row in desc-sorted page)
      const nextBefore = hasMore && page.length > 0 ? page[page.length - 1]?.seq : undefined;

      return reply.status(200).send({
        events,
        hasMore,
        nextBefore: nextBefore ?? null,
      });
    },
  );
}
