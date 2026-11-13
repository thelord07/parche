import type { PushResult } from '@chamba/core';
import {
  isScannable,
  isSyncable,
  pathKey,
  pushRequestSchema,
  pushResponseSchema,
} from '@chamba/core';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authenticate, requireCan } from '../auth/plugin.js';
import { blobRefs, changes, files, groups } from '../db/schema.js';
import { updateFileMetaFromBlob } from '../meta/file-meta.js';
import { RULES_VERSION } from '../secrets/rules-version.js';
import { resolveAllForPath, scanHeadForPath } from '../secrets/scan-path.js';
import type { StoragePort } from '../storage/storage-port.js';

export interface PushRouteOpts {
  storage?: StoragePort;
}

// ---------------------------------------------------------------------------
// Sentinel error for case collisions — thrown inside the transaction
// ---------------------------------------------------------------------------

class CaseCollisionError extends Error {
  override name = 'CaseCollisionError';
  constructor(
    public readonly collidingPath: string,
    public readonly existingPath: string,
  ) {
    super(`case collision: ${collidingPath} conflicts with ${existingPath}`);
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export async function pushRoutes(app: FastifyInstance, opts: PushRouteOpts = {}): Promise<void> {
  const { storage } = opts;
  app.post<{ Params: { slug: string } }>(
    '/api/g/:slug/push',
    { preHandler: [authenticate, requireCan('write')] },
    async (request, reply) => {
      // 1. Validate body
      const parseResult = pushRequestSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({ error: 'bad_request', details: parseResult.error.issues });
      }
      const { changes: pushChanges } = parseResult.data;

      // 2. Syncability check on every path
      for (const { path } of pushChanges) {
        if (!isSyncable(path)) {
          return reply.status(400).send({ error: 'unsyncable_path', path });
        }
      }

      const groupId = request.auth.groupId;

      // 3. Blob presence check, scoped to the token's group. A hash counts as
      // present only if this group uploaded it via PUT (which verifies the
      // content = proof of possession). A global storage check would let a
      // group that merely knows a hash claim another group's blob.
      const wantedHashes = [
        ...new Set(pushChanges.flatMap(({ newHash }) => (newHash === null ? [] : [newHash]))),
      ];
      if (wantedHashes.length > 0) {
        const owned = new Set(
          app.db
            .select({ hash: blobRefs.hash })
            .from(blobRefs)
            .where(and(eq(blobRefs.groupId, groupId), inArray(blobRefs.hash, wantedHashes)))
            .all()
            .map((r) => r.hash),
        );
        const missingHashes = wantedHashes.filter((h) => !owned.has(h));
        if (missingHashes.length > 0) {
          return reply.status(422).send({ error: 'missing_blobs', hashes: missingHashes });
        }
      }

      // 4. Sync transaction
      const userId = request.auth.userId;
      const deviceId = request.auth.deviceId;
      const now = new Date().toISOString();

      let results: PushResult[];
      try {
        results = app.db.transaction((tx) => {
          // Seed liveByKey from live (non-tombstone) files in this group
          const liveFiles = tx
            .select({ path: files.path, pathKey: files.pathKey })
            .from(files)
            .where(and(eq(files.groupId, groupId), isNotNull(files.headHash)))
            .all();
          // Never call Map.delete — set to null to mark as no longer live
          const liveByKey = new Map<string, string | null>(
            liveFiles.map((f) => [f.pathKey, f.path]),
          );

          const txResults: PushResult[] = [];

          for (const { path, baseHash, newHash } of pushChanges) {
            const key = pathKey(path);

            // Case collision: newHash is live AND key maps to a different live path
            if (newHash !== null) {
              const existingPath = liveByKey.get(key);
              if (existingPath !== undefined && existingPath !== null && existingPath !== path) {
                throw new CaseCollisionError(path, existingPath);
              }
            }

            // Current DB state for this path
            const fileRow = tx
              .select()
              .from(files)
              .where(and(eq(files.groupId, groupId), eq(files.path, path)))
              .get();

            const head = fileRow?.headHash ?? null; // null if no row OR tombstone
            const headSeq = fileRow?.headSeq ?? null;

            // Gate decision: null→null on a never-existing file → conflict (no row created)
            if (fileRow === undefined && baseHash === null && newHash === null) {
              txResults.push({ status: 'conflict', path, currentHash: null });
              continue;
            }

            // Idempotent: row exists and newHash already matches head
            if (fileRow !== undefined && newHash === head) {
              if (headSeq === null) {
                throw new Error(
                  `invariant violation: fileRow exists for path "${path}" but headSeq is null`,
                );
              }
              txResults.push({ status: 'ok', path, seq: headSeq });
              continue;
            }

            // Advance: baseHash matches head (null for missing row or tombstone)
            if (baseHash === head) {
              // Increment the group's seq_counter and read back the new value
              tx.update(groups)
                .set({ seqCounter: sql`${groups.seqCounter} + 1` })
                .where(eq(groups.id, groupId))
                .run();
              const g = tx
                .select({ seqCounter: groups.seqCounter })
                .from(groups)
                .where(eq(groups.id, groupId))
                .get();
              const seq = g?.seqCounter ?? 0;

              // Upsert the file record
              tx.insert(files)
                .values({ groupId, path, pathKey: key, headHash: newHash, headSeq: seq })
                .onConflictDoUpdate({
                  target: [files.groupId, files.path],
                  set: { headHash: newHash, headSeq: seq, pathKey: key },
                })
                .run();

              // Append to the immutable change log
              tx.insert(changes)
                .values({ groupId, seq, path, hash: newHash, userId, deviceId, at: now })
                .run();

              // Update liveByKey (never delete — set to null for tombstones)
              liveByKey.set(key, newHash !== null ? path : null);

              txResults.push({ status: 'ok', path, seq });
            } else {
              // Conflict: baseHash doesn't match head
              txResults.push({ status: 'conflict', path, currentHash: head });
            }
          }

          return txResults;
        });
      } catch (err) {
        if (err instanceof CaseCollisionError) {
          return reply.status(409).send({
            error: 'case_collision',
            path: err.collidingPath,
            existing: err.existingPath,
          });
        }
        throw err;
      }

      const body = pushResponseSchema.parse({ results });

      // Post-push: update file_meta for ok results with .md files, and reconcile
      // secret_findings (PARCHE-012). Both fire-and-forget OUTSIDE the
      // transaction — errors never fail the push.
      if (storage) {
        // newHash is already known from the validated request: for an 'ok' result
        // the path's head is exactly this value (either just advanced to it, or
        // already matched it — the idempotent case). null = tombstone.
        const newHashByPath = new Map(pushChanges.map((c) => [c.path, c.newHash]));
        const scanLog = app.log as {
          warn: (m: string, o?: unknown) => void;
          info: (m: string, o?: unknown) => void;
        };

        for (const r of results) {
          if (r.status !== 'ok') continue;
          const newHash = newHashByPath.get(r.path) ?? null;

          if (r.path.endsWith('.md')) {
            // Get the hash that was just committed
            const fileRow = app.db
              .select({ headHash: files.headHash })
              .from(files)
              .where(
                and(eq(files.groupId, groupId), eq(files.path, r.path), isNotNull(files.headHash)),
              )
              .get();
            if (fileRow?.headHash) {
              updateFileMetaFromBlob(
                { db: app.db, storage, log: app.log as { warn: (m: string, o?: unknown) => void } },
                groupId,
                r.path,
                fileRow.headHash,
              ).catch(() => {
                // never fails the push
              });
            }
          }

          // N4 — tombstone derived from the request itself, not re-read from DB.
          if (newHash === null) {
            resolveAllForPath({ db: app.db, log: scanLog }, groupId, r.path);
          } else if (isScannable(r.path)) {
            scanHeadForPath(
              { db: app.db, storage, log: scanLog },
              groupId,
              r.path,
              newHash,
              RULES_VERSION,
            ).catch(() => {
              // never fails the push
            });
          }
        }
      }

      return reply.status(200).send(body);
    },
  );
}
