/**
 * Tests for /activity endpoint: 10-minute grouping, verb (creó/guardó) resolved by DB,
 * cross-page isolation, and pagination cursor correctness.
 *
 * These tests would fail without the grouping fix (D7 in group-read.ts ~400-430)
 * and without getFirstCreateSeq querying the DB absolutely.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changes, files } from '../../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeTempDataDir,
  seedGroupWithDevice,
  seedMember,
  seedWebSession,
  seedWebUser,
  withWebFixture,
} from '../../test-helpers.js';

function sha256hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Helper: insert a change (and update the files head) for a given group/user/device.
function seedChange(
  app: Awaited<ReturnType<typeof makeApp>>,
  groupId: string,
  userId: string,
  deviceId: string,
  path: string,
  seq: number,
  hash: string | null,
  at: string,
) {
  app.db
    .insert(files)
    .values({ groupId, path, pathKey: path.toLowerCase(), headHash: hash, headSeq: seq })
    .onConflictDoUpdate({
      target: [files.groupId, files.path],
      set: { headHash: hash, headSeq: seq },
    })
    .run();
  app.db
    .insert(changes)
    .values({ groupId, seq, path, hash, userId, deviceId, at })
    .onConflictDoNothing()
    .run();
}

async function setup() {
  const dataDir = await makeTempDataDir();
  const { webDir, cleanup: webCleanup } = await withWebFixture();
  const app = await makeApp(dataDir, {}, { webDir });
  await app.ready();

  // Primary user+device in group 'grp-grouping'
  const device = await seedGroupWithDevice(app, { slug: 'grp-grouping' });

  // Secondary user+device (in a separate group, but its deviceId can be used in changes
  // for grp-grouping — the schema only requires deviceId to exist in devices table)
  const device2 = await seedGroupWithDevice(app, { slug: 'grp-grouping-b' });

  const webUser = seedWebUser(app, { email: 'grouping@example.com' });
  const session = seedWebSession(app, webUser.userId);
  seedMember(app, { groupSlug: 'grp-grouping', userId: webUser.userId, role: 'editor' });

  return {
    dataDir,
    webDir,
    webCleanup,
    app,
    device,
    device2,
    webUser,
    session,
    cleanup: async () => {
      await app.close();
      await cleanupDir(dataDir);
      await webCleanup();
    },
  };
}

type ActivityEvent = {
  seq: number;
  path: string;
  verb: string;
  user: { email: string };
  count?: number;
  renamedTo?: string;
};
type ActivityResponse = { events: ActivityEvent[]; hasMore: boolean; nextBefore: number | null };

// ---------------------------------------------------------------------------
// 10-minute grouping window
// ---------------------------------------------------------------------------
describe('Activity: 10-minute grouping window', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('4 saves within 10 min → 1 event with count=4', async () => {
    const { app, device, session } = ctx;
    const t0 = Date.now() - 9 * 60 * 1000;
    const path = 'note-group.md';

    // Inserts at t+0, t+30s, t+5min, t+9min
    const offsets = [0, 30_000, 5 * 60_000, 9 * 60_000];
    for (let i = 0; i < offsets.length; i++) {
      const at = new Date(t0 + offsets[i]!).toISOString();
      const hash = sha256hex(`content-${i}`);
      seedChange(app, device.groupId, device.userId, device.deviceId, path, i + 1, hash, at);
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ActivityResponse>();
    const ev = body.events.filter((e) => e.path === path);

    expect(ev.length).toBe(1);
    expect(ev[0]!.count).toBe(4);
  });

  it('save at +25 min → separate event from saves within 10 min', async () => {
    const { app, device, session } = ctx;
    const t0 = Date.now() - 25 * 60 * 1000;
    const path = 'note-split.md';

    // 4 saves within 10 min (seqs 1-4)
    const nearOffsets = [0, 30_000, 5 * 60_000, 9 * 60_000];
    for (let i = 0; i < nearOffsets.length; i++) {
      const at = new Date(t0 + nearOffsets[i]!).toISOString();
      seedChange(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        path,
        i + 1,
        sha256hex(`n${i}`),
        at,
      );
    }

    // 1 save at +25 min (seq 5)
    const atLate = new Date(t0 + 25 * 60_000).toISOString();
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      5,
      sha256hex('late'),
      atLate,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();
    const evs = events.filter((e) => e.path === path);

    // The +25min save and the 0-9min saves should be two separate events
    expect(evs.length).toBe(2);
    const totalCount = evs.reduce((acc, e) => acc + (e.count ?? 1), 0);
    expect(totalCount).toBe(5);
  });

  it('another user intercalated on same path → saves do NOT merge across users', async () => {
    const { app, device, device2, session } = ctx;
    const t0 = Date.now() - 6 * 60 * 1000;
    const path = 'shared-note.md';

    // user1 saves at t+0 (seq 1)
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      1,
      sha256hex('u1-v1'),
      new Date(t0).toISOString(),
    );
    // user2 saves at t+2min (seq 2) — intercalated
    seedChange(
      app,
      device.groupId,
      device2.userId,
      device2.deviceId,
      path,
      2,
      sha256hex('u2-v1'),
      new Date(t0 + 2 * 60_000).toISOString(),
    );
    // user1 saves at t+4min (seq 3) — within 10min of user1's first save
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      3,
      sha256hex('u1-v2'),
      new Date(t0 + 4 * 60_000).toISOString(),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    // The important assertions:
    // - user2's save appears separately (not merged into user1's events)
    // - total count across all events for this path is 3 (user1 x2 + user2 x1)
    const pathEvents = events.filter((e) => e.path === path);
    const totalCount = pathEvents.reduce((acc, e) => acc + (e.count ?? 1), 0);
    expect(totalCount).toBe(3);

    // At least 2 events for this path: one for user1 (possibly count=2) and one for user2
    expect(pathEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('saves on different paths → do NOT merge across paths', async () => {
    const { app, device, session } = ctx;
    const t0 = Date.now() - 5 * 60 * 1000;

    // 2 saves on path-A and 2 saves on path-B, all within 10 min, same user
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'path-a.md',
      1,
      sha256hex('a1'),
      new Date(t0).toISOString(),
    );
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'path-b.md',
      2,
      sha256hex('b1'),
      new Date(t0 + 60_000).toISOString(),
    );
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'path-a.md',
      3,
      sha256hex('a2'),
      new Date(t0 + 2 * 60_000).toISOString(),
    );
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'path-b.md',
      4,
      sha256hex('b2'),
      new Date(t0 + 3 * 60_000).toISOString(),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    const evA = events.filter((e) => e.path === 'path-a.md');
    const evB = events.filter((e) => e.path === 'path-b.md');

    // Each path should have its own event (they don't merge with each other)
    expect(evA.length).toBe(1);
    expect(evB.length).toBe(1);
    expect(evA[0]!.count).toBe(2);
    expect(evB[0]!.count).toBe(2);
  });

  it('D5 rename (tombstone + create same hash) → single renombró event, not grouped with saves', async () => {
    const { app, device, session } = ctx;
    const atOld = new Date(Date.now() - 20_000).toISOString();
    const atRename = new Date().toISOString();
    const hash = sha256hex('renamed content');

    // seq 1: original file creation
    seedChange(app, device.groupId, device.userId, device.deviceId, 'old.md', 1, hash, atOld);

    // seq 2: tombstone old.md (same atRename as seq 3)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'old.md',
        pathKey: 'old.md',
        headHash: null,
        headSeq: 2,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: null, headSeq: 2 },
      })
      .run();
    app.db
      .insert(changes)
      .values({
        groupId: device.groupId,
        seq: 2,
        path: 'old.md',
        hash: null,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atRename,
      })
      .onConflictDoNothing()
      .run();

    // seq 3: create new.md with same hash (rename pair)
    seedChange(app, device.groupId, device.userId, device.deviceId, 'new.md', 3, hash, atRename);

    // Fetch ONLY the rename pair (seqs 2 and 3): before=4&limit=2
    // seq 1 (original creó) is excluded because limit=2 gives seqs 3,2 only.
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity?before=4&limit=2',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    // Must be a single "renombró" event — not merged into a "guardó" count group
    const renames = events.filter((e) => e.verb === 'renombró');
    expect(renames.length).toBe(1);
    expect(renames[0]!.renamedTo).toBe('new.md');
    // count must be undefined for a rename (not groupable)
    expect(renames[0]!.count).toBeUndefined();
    // Total events on this page: 1 (rename pair collapsed into one)
    expect(events.length).toBe(1);
  });

  it('pagination: nextBefore cursor — sum of count equals total saves (no dup/loss)', async () => {
    const { app, device, session } = ctx;
    // 10 saves on same path within 10 min — they'll group within each page but total count = 10
    const t0 = Date.now() - 9 * 60 * 1000;
    const path = 'pag-group.md';

    for (let i = 0; i < 10; i++) {
      const at = new Date(t0 + i * 50_000).toISOString(); // 50s apart, all within 9min
      seedChange(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        path,
        i + 1,
        sha256hex(`pv${i}`),
        at,
      );
    }

    let before: number | undefined;
    let hasMore = true;
    let totalCount = 0;
    let pagesFetched = 0;
    const LIMIT = 3;
    const seenSeqs = new Set<number>();

    while (hasMore) {
      pagesFetched++;
      const url =
        before !== undefined
          ? `/api/web/g/grp-grouping/activity?limit=${LIMIT}&before=${before}`
          : `/api/web/g/grp-grouping/activity?limit=${LIMIT}`;

      const res = await app.inject({
        method: 'GET',
        url,
        cookies: { parche_session: session },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<ActivityResponse>();

      for (const ev of body.events) {
        if (ev.path === path) {
          totalCount += ev.count ?? 1;
          // Verify no duplicate seqs across pages
          expect(seenSeqs.has(ev.seq)).toBe(false);
          seenSeqs.add(ev.seq);
        }
      }

      hasMore = body.hasMore;
      before = body.nextBefore ?? undefined;
      if (pagesFetched > 20) break; // safety guard
    }

    expect(totalCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Verb "creó" vs "guardó" resolved by DB (pagination boundary)
// ---------------------------------------------------------------------------
describe('Activity: creó vs guardó resolved by DB even across page boundaries', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('save on current page shows "guardó" even when creation is on a different page', async () => {
    const { app, device, session } = ctx;
    const path = 'cross-page.md';
    const now = Date.now();

    // seq 1 (oldest): creation — will be on a later (deeper) page
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      1,
      sha256hex('v1'),
      new Date(now - 10_000).toISOString(),
    );
    // seqs 2-6: saves
    for (let i = 2; i <= 6; i++) {
      seedChange(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        path,
        i,
        sha256hex(`v${i}`),
        new Date(now - (7 - i) * 1000).toISOString(),
      );
    }

    // Fetch with limit=3 — page 1 gets seqs 6, 5, 4 (creation seq=1 is not on this page)
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity?limit=3',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    // All events on page 1 are saves for 'cross-page.md' → all must say 'guardó'
    const evs = events.filter((e) => e.path === path);
    expect(evs.length).toBeGreaterThan(0);
    for (const ev of evs) {
      expect(ev.verb).toBe('guardó');
    }
  });

  it('creation says "creó" on its own page (deepest page)', async () => {
    const { app, device, session } = ctx;
    const path = 'deep-create.md';
    const now = Date.now();

    // seq 1 = creation; seq 2-4 = saves
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      1,
      sha256hex('c0'),
      new Date(now - 4_000).toISOString(),
    );
    for (let i = 2; i <= 4; i++) {
      seedChange(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        path,
        i,
        sha256hex(`c${i}`),
        new Date(now - (5 - i) * 1000).toISOString(),
      );
    }

    // Fetch seqs 1 (creation) directly via before=2&limit=1
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity?before=2&limit=1',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    const createEv = events.find((e) => e.path === path && e.seq === 1);
    expect(createEv).toBeDefined();
    expect(createEv!.verb).toBe('creó');
  });

  it('after tombstone + recreate: recreation shows "guardó" (expected: getFirstCreateSeq returns original seq)', async () => {
    /**
     * Design decision: after a tombstone and re-creation, the re-creation verb is "guardó"
     * because getFirstCreateSeq queries the FIRST EVER non-null change for the path.
     * Since seq 1 was the original creation, the re-creation at seq 3 has isFirst=false.
     *
     * This is intentional — the file has history, so it's a "save" not a "create".
     * If this design changes, update this test and the comment.
     */
    const { app, device, session } = ctx;
    const path = 'tombstone-recreate.md';
    const now = Date.now();

    // seq 1: create
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      1,
      sha256hex('orig'),
      new Date(now - 3_000).toISOString(),
    );
    // seq 2: tombstone (delete)
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      2,
      null,
      new Date(now - 2_000).toISOString(),
    );
    // seq 3: recreate
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      3,
      sha256hex('recreated'),
      new Date(now - 1_000).toISOString(),
    );

    // Fetch page containing seq 3 (the recreation)
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity?before=4&limit=1',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    const recreateEv = events.find((e) => e.path === path && e.seq === 3);
    expect(recreateEv).toBeDefined();
    // Expected: "guardó" because getFirstCreateSeq returns seq 1 (the original creation),
    // not seq 3. The code's isFirst check fails (1 !== 3).
    expect(recreateEv!.verb).toBe('guardó');
  });

  it('tombstone verb is "borró" and is NOT merged into any grouping', async () => {
    const { app, device, session } = ctx;
    const path = 'to-delete.md';
    const now = Date.now();

    // seq 1: create; seq 2: save; seq 3: tombstone
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      1,
      sha256hex('v1'),
      new Date(now - 3_000).toISOString(),
    );
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      2,
      sha256hex('v2'),
      new Date(now - 2_000).toISOString(),
    );
    seedChange(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      path,
      3,
      null,
      new Date(now - 1_000).toISOString(),
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/grp-grouping/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<ActivityResponse>();

    const deleteEv = events.find((e) => e.path === path && e.verb === 'borró');
    expect(deleteEv).toBeDefined();
    // Tombstone events must not have a count (they are not groupable)
    expect(deleteEv!.count).toBeUndefined();
    // The save (seq 2) is a separate event — tombstones break grouping for that user+path
    const saveEv = events.find((e) => e.path === path && e.verb === 'guardó');
    expect(saveEv).toBeDefined();
  });
});
