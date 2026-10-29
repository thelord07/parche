import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, createInvite } from '../admin/commands.js';
import { cleanupDir, makeApp, makeTempDataDir, seedGroupWithDevice } from '../test-helpers.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('GET /api/g/:slug/changes', () => {
  let dataDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    app = await makeApp(dataDir);
  });

  afterEach(async () => {
    await app.close();
    await cleanupDir(dataDir);
  });

  // --------------------------------------------------------------------------
  // AC6: reader can GET /changes
  // --------------------------------------------------------------------------
  it('AC6: reader gets 200 on /changes', async () => {
    createGroup(app.db, {
      name: 'Changes Group',
      slug: 'changes-group',
      ownerName: 'Owner',
      ownerEmail: 'owner@changes.com',
    });
    const { inviteCode } = createInvite(app.db, { group: 'changes-group', role: 'reader' });
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/join',
      payload: { code: inviteCode, name: 'Reader', email: 'reader@changes.com' },
    });
    const { deviceToken } = joinRes.json() as { deviceToken: string };

    const res = await app.inject({
      method: 'GET',
      url: '/api/g/changes-group/changes',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      protocol: number;
      changes: unknown[];
      hasMore: boolean;
      cursor: number;
    };
    expect(body.protocol).toBe(1);
    expect(body.changes).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.cursor).toBe(0);
  });

  // --------------------------------------------------------------------------
  // AC16: pagination — 150 changes, limit=100
  // --------------------------------------------------------------------------
  it('AC16: 150 changes → first page 100 with hasMore:true, second page 50 with hasMore:false', async () => {
    const { authHeader, groupSlug, groupId, userId, deviceId } = await seedGroupWithDevice(app);
    const now = new Date().toISOString();

    // Seed 150 changes directly in the DB
    const { changes, groups, files } = await import('../db/schema.js');
    const { pathKey } = await import('@chamba/core');
    const { sql, eq } = await import('drizzle-orm');

    for (let i = 1; i <= 150; i++) {
      const path = `note-${i}.md`;
      const hash = sha256(Buffer.from(`content-${i}`));
      const key = pathKey(path);

      // Increment seq_counter
      app.db
        .update(groups)
        .set({ seqCounter: sql`${groups.seqCounter} + 1` })
        .where(eq(groups.id, groupId))
        .run();
      const g = app.db
        .select({ seqCounter: groups.seqCounter })
        .from(groups)
        .where(eq(groups.id, groupId))
        .get();
      if (!g) throw new Error(`group ${groupId} not found at iteration ${i}`);

      app.db
        .insert(files)
        .values({ groupId, path, pathKey: key, headHash: hash, headSeq: g.seqCounter })
        .onConflictDoUpdate({
          target: [files.groupId, files.path],
          set: { headHash: hash, headSeq: g.seqCounter },
        })
        .run();

      app.db
        .insert(changes)
        .values({
          groupId,
          seq: g.seqCounter,
          path,
          hash,
          userId,
          deviceId,
          at: now,
        })
        .run();
    }

    // First page: since=0, limit=100
    const res1 = await app.inject({
      method: 'GET',
      url: `/api/g/${groupSlug}/changes?since=0&limit=100`,
      headers: { authorization: authHeader },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json() as {
      changes: Array<{ seq: number }>;
      hasMore: boolean;
      cursor: number;
    };
    expect(page1.changes).toHaveLength(100);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBe(100);

    // Second page: since=100, limit=100
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/g/${groupSlug}/changes?since=100&limit=100`,
      headers: { authorization: authHeader },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json() as {
      changes: Array<{ seq: number }>;
      hasMore: boolean;
      cursor: number;
    };
    expect(page2.changes).toHaveLength(50);
    expect(page2.hasMore).toBe(false);
    expect(page2.cursor).toBe(150);
  });
});
