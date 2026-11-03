/**
 * Behavioral tests for /summary, /tree, /activity
 * - Summary: shape, notes/folders/conflicts counts, lastChangeAt, members list
 * - Tree: direct children only, folders first, case-insensitive sort, file title,
 *   pagination at 200 files
 * - Activity: verbs (creó/guardó/borró), D5 renaming (tombstone+create same user+device+at),
 *   pagination (before/limit), deviceLabel, hashCorto, project/work_item from file_meta
 *   "marcó obsoleta" must NEVER appear
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changes, fileMeta, files } from '../../db/schema.js';
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

async function setup() {
  const dataDir = await makeTempDataDir();
  const { webDir, cleanup: webCleanup } = await withWebFixture();
  const app = await makeApp(dataDir, {}, { webDir });
  await app.ready();

  const device = await seedGroupWithDevice(app, { slug: 'behavior-grp' });
  const webUser = seedWebUser(app, { email: 'behavior@example.com' });
  const session = seedWebSession(app, webUser.userId);
  seedMember(app, { groupSlug: 'behavior-grp', userId: webUser.userId, role: 'editor' });

  return {
    dataDir,
    webDir,
    webCleanup,
    app,
    device,
    webUser,
    session,
    cleanup: async () => {
      await app.close();
      await cleanupDir(dataDir);
      await webCleanup();
    },
  };
}

// Helper: insert a file + change into the db
function seedFile(
  app: Awaited<ReturnType<typeof setup>>['app'],
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
    .values({
      groupId,
      path,
      pathKey: path.toLowerCase(),
      headHash: hash,
      headSeq: seq,
    })
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/summary — shape and counts', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('summary has correct shape and note/folder counts', async () => {
    const { app, device, webUser, session } = ctx;
    const at = new Date().toISOString();

    // 3 notes: root/a.md, docs/b.md, docs/sub/c.md
    seedFile(app, device.groupId, device.userId, device.deviceId, 'a.md', 1, sha256hex('a'), at);
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/b.md',
      2,
      sha256hex('b'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/sub/c.md',
      3,
      sha256hex('c'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/summary',
      cookies: { parche_session: session },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      group: { slug: string; role: string };
      notes: number;
      folders: number;
      conflicts: number;
      lastChangeAt: string;
      members: Array<{ name: string; email: string; role: string }>;
    }>();
    expect(body.group.slug).toBe('behavior-grp');
    expect(body.notes).toBe(3);
    // Folders: docs, docs/sub
    expect(body.folders).toBe(2);
    expect(body.conflicts).toBe(0);
    expect(body.lastChangeAt).toBeTruthy();
    expect(body.members.length).toBeGreaterThanOrEqual(1);
    // The web user added via seedMember should appear
    expect(body.members.some((m) => m.email === webUser.email)).toBe(true);
  });

  it('summary counts conflicts from file_meta (only live files)', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    const hash = sha256hex('conflict content');

    // A live conflict copy
    seedFile(app, device.groupId, device.userId, device.deviceId, 'note_conflict.md', 1, hash, at);
    app.db
      .insert(fileMeta)
      .values({
        groupId: device.groupId,
        path: 'note_conflict.md',
        hash,
        conflictOf: 'note.md',
        conflictBase: null,
      })
      .onConflictDoNothing()
      .run();

    // A tombstoned file with conflict_of — should NOT count
    const tombHash = sha256hex('tombstone');
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'tombstone_conflict.md',
        pathKey: 'tombstone_conflict.md',
        headHash: null, // tombstone
        headSeq: 2,
      })
      .onConflictDoNothing()
      .run();
    app.db
      .insert(fileMeta)
      .values({
        groupId: device.groupId,
        path: 'tombstone_conflict.md',
        hash: tombHash,
        conflictOf: 'original.md',
        conflictBase: null,
      })
      .onConflictDoNothing()
      .run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/summary',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ conflicts: number }>();
    expect(body.conflicts).toBe(1); // only the live conflict
  });
});

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/tree — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns direct children only — no deep nesting', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(app, device.groupId, device.userId, device.deviceId, 'root.md', 1, sha256hex('r'), at);
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/a.md',
      2,
      sha256hex('a'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/sub/b.md',
      3,
      sha256hex('b'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ name: string; type: string }> }>();

    // root.md (file) + docs (dir)
    expect(items.length).toBe(2);
    const dir = items.find((i) => i.type === 'dir');
    const file = items.find((i) => i.type === 'file');
    expect(dir?.name).toBe('docs');
    expect(file?.name).toBe('root.md');
  });

  it('folders come before files (regardless of name sort)', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'alpha.md',
      1,
      sha256hex('a'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'zzz/note.md',
      2,
      sha256hex('z'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ type: string }> }>();
    expect(items[0]?.type).toBe('dir');
    expect(items[1]?.type).toBe('file');
  });

  it('case-insensitive sort within each category', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(app, device.groupId, device.userId, device.deviceId, 'Zeta.md', 1, sha256hex('z'), at);
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'alpha.md',
      2,
      sha256hex('a'),
      at,
    );
    seedFile(app, device.groupId, device.userId, device.deviceId, 'Beta.md', 3, sha256hex('b'), at);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ name: string }> }>();
    const names = items.map((i) => i.name);
    expect(names).toEqual(['alpha.md', 'Beta.md', 'Zeta.md']);
  });

  it('includes child count for directories', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'dir/a.md',
      1,
      sha256hex('a'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'dir/b.md',
      2,
      sha256hex('b'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ type: string; count?: number }> }>();
    const dir = items.find((i) => i.type === 'dir');
    expect(dir?.count).toBe(2);
  });

  it('includes title from file_meta for .md files', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    const hash = sha256hex('titled');

    seedFile(app, device.groupId, device.userId, device.deviceId, 'titled.md', 1, hash, at);
    app.db
      .insert(fileMeta)
      .values({
        groupId: device.groupId,
        path: 'titled.md',
        hash,
        title: 'My Note Title',
      })
      .onConflictDoNothing()
      .run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ name: string; title?: string }> }>();
    const file = items.find((i) => i.name === 'titled.md');
    expect(file?.title).toBe('My Note Title');
  });

  it('paginates at 200 files (files beyond 200 omitted)', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    for (let i = 0; i < 210; i++) {
      const content = `file ${i}`;
      seedFile(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        `file${String(i).padStart(4, '0')}.md`,
        i + 1,
        sha256hex(content),
        at,
      );
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ type: string }> }>();
    const fileItems = items.filter((i) => i.type === 'file');
    expect(fileItems.length).toBe(200);
  });

  it('tree with path parameter returns subtree direct children', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/a.md',
      1,
      sha256hex('a'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/b.md',
      2,
      sha256hex('b'),
      at,
    );
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'docs/sub/c.md',
      3,
      sha256hex('c'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree?path=docs',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; items: Array<{ name: string; type: string }> }>();
    expect(body.path).toBe('docs');
    // Should have a.md, b.md (files) and sub (dir)
    const names = body.items.map((i) => i.name);
    expect(names).toContain('a.md');
    expect(names).toContain('b.md');
    expect(names).toContain('sub');
    // Deep nesting (c.md) should NOT appear
    expect(names).not.toContain('c.md');
  });

  it('tombstoned files do not appear in tree', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'live.md',
      1,
      sha256hex('live'),
      at,
    );
    // tombstone
    seedFile(app, device.groupId, device.userId, device.deviceId, 'deleted.md', 2, null, at);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/tree',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json<{ items: Array<{ name: string }> }>();
    const names = items.map((i) => i.name);
    expect(names).toContain('live.md');
    expect(names).not.toContain('deleted.md');
  });
});

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/activity — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('verb "creó" for first create of a path', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    const hash = sha256hex('created content');

    seedFile(app, device.groupId, device.userId, device.deviceId, 'new.md', 1, hash, at);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ path: string; verb: string }> }>();
    const ev = events.find((e) => e.path === 'new.md');
    expect(ev?.verb).toBe('creó');
  });

  it('verb "guardó" for update (earlier seq exists for same path)', async () => {
    const { app, device, session } = ctx;
    const at1 = new Date(Date.now() - 1000).toISOString();
    const at2 = new Date().toISOString();
    const hash1 = sha256hex('v1');
    const hash2 = sha256hex('v2');

    seedFile(app, device.groupId, device.userId, device.deviceId, 'updated.md', 1, hash1, at1);
    seedFile(app, device.groupId, device.userId, device.deviceId, 'updated.md', 2, hash2, at2);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ path: string; verb: string; seq: number }> }>();
    // The most recent event (seq 2) should be "guardó"
    const ev = events.find((e) => e.seq === 2);
    expect(ev?.verb).toBe('guardó');
  });

  it('verb "borró" for tombstone (hash null)', async () => {
    const { app, device, session } = ctx;
    const at1 = new Date(Date.now() - 1000).toISOString();
    const at2 = new Date().toISOString();
    const hash1 = sha256hex('content');

    seedFile(app, device.groupId, device.userId, device.deviceId, 'deleted.md', 1, hash1, at1);
    seedFile(app, device.groupId, device.userId, device.deviceId, 'deleted.md', 2, null, at2);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ path: string; verb: string; seq: number }> }>();
    const ev = events.find((e) => e.seq === 2);
    expect(ev?.verb).toBe('borró');
  });

  it('D5: tombstone A + create B same user+device+at → single "renombró" event', async () => {
    const { app, device, session } = ctx;
    const atOld = new Date(Date.now() - 10000).toISOString();
    const atRename = new Date().toISOString();
    const hash = sha256hex('renamed content');

    // seq 1: original creation of old-name.md (establishes its known hash)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'old-name.md',
        pathKey: 'old-name.md',
        headHash: hash,
        headSeq: 1,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hash, headSeq: 1 },
      })
      .run();
    app.db
      .insert(changes)
      .values({
        groupId: device.groupId,
        seq: 1,
        path: 'old-name.md',
        hash,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atOld,
      })
      .onConflictDoNothing()
      .run();

    // seq 2: tombstone old-name.md (same atRename as seq 3)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'old-name.md',
        pathKey: 'old-name.md',
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
        path: 'old-name.md',
        hash: null,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atRename,
      })
      .onConflictDoNothing()
      .run();

    // seq 3: create new-name.md with same hash (same atRename as seq 2)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'new-name.md',
        pathKey: 'new-name.md',
        headHash: hash,
        headSeq: 3,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hash, headSeq: 3 },
      })
      .run();
    app.db
      .insert(changes)
      .values({
        groupId: device.groupId,
        seq: 3,
        path: 'new-name.md',
        hash,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atRename,
      })
      .onConflictDoNothing()
      .run();

    // Fetch only the rename pair (seqs 2 and 3) via before=4&limit=2
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity?before=4&limit=2',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{
      events: Array<{ verb: string; path: string; renamedTo?: string }>;
    }>();
    const renamedEvent = events.find((e) => e.verb === 'renombró');
    expect(renamedEvent).toBeDefined();
    expect(renamedEvent?.renamedTo).toBe('new-name.md');
    // Only one event for the rename (not two separate events)
    expect(events.length).toBe(1);
  });

  it('D5: tombstone + create with DIFFERENT hash → two separate events, not a rename', async () => {
    const { app, device, session } = ctx;
    const atOld = new Date(Date.now() - 10000).toISOString();
    const atPair = new Date().toISOString();
    // hash1 is the original content of file-a.md (established before the tombstone)
    const hash1 = sha256hex('content A');
    // hash2 is the content of file-b.md — DIFFERENT from hash1, so not a rename
    const hash2 = sha256hex('content B');

    // seq 1: create file-a.md with hash1 (establishes its known hash)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'file-a.md',
        pathKey: 'file-a.md',
        headHash: hash1,
        headSeq: 1,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hash1, headSeq: 1 },
      })
      .run();
    app.db
      .insert(changes)
      .values({
        groupId: device.groupId,
        seq: 1,
        path: 'file-a.md',
        hash: hash1,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atOld,
      })
      .onConflictDoNothing()
      .run();

    // seq 2: tombstone file-a.md (same atPair as seq 3)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'file-a.md',
        pathKey: 'file-a.md',
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
        path: 'file-a.md',
        hash: null,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atPair,
      })
      .onConflictDoNothing()
      .run();

    // seq 3: create file-b.md with hash2 (DIFFERENT from hash1 → not a rename)
    app.db
      .insert(files)
      .values({
        groupId: device.groupId,
        path: 'file-b.md',
        pathKey: 'file-b.md',
        headHash: hash2,
        headSeq: 3,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hash2, headSeq: 3 },
      })
      .run();
    app.db
      .insert(changes)
      .values({
        groupId: device.groupId,
        seq: 3,
        path: 'file-b.md',
        hash: hash2,
        userId: device.userId,
        deviceId: device.deviceId,
        at: atPair,
      })
      .onConflictDoNothing()
      .run();

    // Fetch only the pair (seqs 2 and 3) via before=4&limit=2
    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity?before=4&limit=2',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ verb: string }> }>();
    // Should have two separate events (borró + creó), NOT a "renombró"
    const renamed = events.find((e) => e.verb === 'renombró');
    expect(renamed).toBeUndefined();
    expect(events.length).toBe(2);
  });

  it('pagination: before/limit work correctly', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    // Insert 10 changes
    for (let i = 1; i <= 10; i++) {
      seedFile(
        app,
        device.groupId,
        device.userId,
        device.deviceId,
        `file${i}.md`,
        i,
        sha256hex(`content${i}`),
        at,
      );
    }

    // First page (limit 5)
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity?limit=5',
      cookies: { parche_session: session },
    });
    expect(res1.statusCode).toBe(200);
    const page1 = res1.json<{
      events: Array<{ seq: number }>;
      hasMore: boolean;
      nextBefore: number | null;
    }>();
    expect(page1.events.length).toBe(5);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextBefore).toBeTypeOf('number');

    // Second page using nextBefore
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/web/g/behavior-grp/activity?limit=5&before=${page1.nextBefore}`,
      cookies: { parche_session: session },
    });
    expect(res2.statusCode).toBe(200);
    const page2 = res2.json<{ events: Array<{ seq: number }>; hasMore: boolean }>();
    expect(page2.events.length).toBe(5);
    expect(page2.hasMore).toBe(false);

    // No overlap between pages
    const seqs1 = new Set(page1.events.map((e) => e.seq));
    const seqs2 = new Set(page2.events.map((e) => e.seq));
    for (const s of seqs2) {
      expect(seqs1.has(s)).toBe(false);
    }
  });

  it('includes deviceLabel in events', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    seedFile(app, device.groupId, device.userId, device.deviceId, 'dev.md', 1, sha256hex('d'), at);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ deviceLabel: string; hashCorto?: string }> }>();
    expect(events[0]?.deviceLabel).toBeTypeOf('string');
    expect(events[0]?.hashCorto?.length).toBe(7);
  });

  it('activity event uses hashCorto field name (ticket spec)', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    seedFile(
      app,
      device.groupId,
      device.userId,
      device.deviceId,
      'hash-name.md',
      1,
      sha256hex('h'),
      at,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ hashCorto?: string }> }>();
    expect(events[0]?.hashCorto?.length).toBe(7);
  });

  it('includes project and workItem from file_meta', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();
    const hash = sha256hex('proj content');

    seedFile(app, device.groupId, device.userId, device.deviceId, 'proj.md', 1, hash, at);
    app.db
      .insert(fileMeta)
      .values({
        groupId: device.groupId,
        path: 'proj.md',
        hash,
        project: 'my-project',
        workItem: 'ISSUE-42',
      })
      .onConflictDoNothing()
      .run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{
      events: Array<{ path: string; project?: string; workItem?: string }>;
    }>();
    const ev = events.find((e) => e.path === 'proj.md');
    expect(ev?.project).toBe('my-project');
    expect(ev?.workItem).toBe('ISSUE-42');
  });

  it('never emits "marcó obsoleta" verb', async () => {
    const { app, device, session } = ctx;
    const at = new Date().toISOString();

    // Any combination of operations
    seedFile(app, device.groupId, device.userId, device.deviceId, 'm.md', 1, sha256hex('m'), at);
    seedFile(app, device.groupId, device.userId, device.deviceId, 'm.md', 2, null, at);

    const res = await app.inject({
      method: 'GET',
      url: '/api/web/g/behavior-grp/activity',
      cookies: { parche_session: session },
    });
    expect(res.statusCode).toBe(200);
    const { events } = res.json<{ events: Array<{ verb: string }> }>();
    for (const ev of events) {
      expect(ev.verb).not.toBe('marcó obsoleta');
      expect(ev.verb).not.toContain('obsolet');
    }
  });
});
