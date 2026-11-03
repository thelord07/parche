/**
 * Behavioral tests for /conflicts, /conflicts/view, /topics, /topics/:tag
 *
 * Covers:
 * - /conflicts: only copies with conflict_of and HEAD not tombstone;
 *   fields: copyPath, originalPath, base, autorCopia, at
 * - /conflicts/view: same constraint; returns original+copy+diff
 * - /topics: tree with counts from tags starting with "tema/";
 *   empty { nodes: [] } when no tags
 * - /topics/:tag: files matching the exact "tema/:tag" string
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

  const device = await seedGroupWithDevice(app, { slug: 'ct-grp' });
  const webUser = seedWebUser(app, { email: 'ctuser@example.com' });
  const session = seedWebSession(app, webUser.userId);
  seedMember(app, { groupSlug: 'ct-grp', userId: webUser.userId, role: 'editor' });

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

// ---------------------------------------------------------------------------
// /conflicts
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/conflicts — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty array when no conflicts', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns conflict with required fields', async () => {
    const hash = sha256hex('conflict content');
    const at = new Date().toISOString();

    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'note_conflict.md',
        pathKey: 'note_conflict.md',
        headHash: hash,
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 1,
        path: 'note_conflict.md',
        hash,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'note_conflict.md',
        hash,
        conflictOf: 'note.md',
        conflictBase: 'base-hash',
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const conflicts =
      res.json<
        Array<{
          copyPath: string;
          originalPath: string;
          base: string | null;
          autorCopia: string | null;
          at: string | null;
        }>
      >();

    expect(conflicts.length).toBe(1);
    const c = conflicts[0]!;
    expect(c.copyPath).toBe('note_conflict.md');
    expect(c.originalPath).toBe('note.md');
    expect(c.base).toBe('base-hash');
    expect(c.autorCopia).toBeTypeOf('string');
    expect(c.at).toBeTypeOf('string');
  });

  it('excludes tombstoned conflict copies', async () => {
    const hash = sha256hex('tombstoned conflict');

    // File with headHash null (tombstone)
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'tombstoned_conflict.md',
        pathKey: 'tombstoned_conflict.md',
        headHash: null, // tombstone!
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'tombstoned_conflict.md',
        hash,
        conflictOf: 'original.md',
        conflictBase: null,
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const conflicts = res.json<Array<{ copyPath: string }>>();
    expect(conflicts.find((c) => c.copyPath === 'tombstoned_conflict.md')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// /conflicts/view
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/conflicts/view — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('400 for missing copyPath', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts/view',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 for path traversal in copyPath', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts/view?copyPath=../../etc/passwd',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 when copyPath has no conflict_of', async () => {
    const hash = sha256hex('regular file');
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'regular.md',
        pathKey: 'regular.md',
        headHash: hash,
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();
    // No fileMeta with conflictOf

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts/view?copyPath=regular.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns copyPath, originalPath, base fields', async () => {
    const copyHash = sha256hex('copy content');
    const at = new Date().toISOString();

    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'view_conflict.md',
        pathKey: 'view_conflict.md',
        headHash: copyHash,
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 1,
        path: 'view_conflict.md',
        hash: copyHash,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'view_conflict.md',
        hash: copyHash,
        conflictOf: 'original_view.md',
        conflictBase: 'base123',
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/conflicts/view?copyPath=view_conflict.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      copyPath: string;
      originalPath: string;
      base: string | null;
      diff: unknown[];
    }>();
    expect(body.copyPath).toBe('view_conflict.md');
    expect(body.originalPath).toBe('original_view.md');
    expect(body.base).toBe('base123');
    expect(Array.isArray(body.diff)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /topics
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/topics — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns empty nodes when no tema/ tags', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/topics',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json<{ nodes: unknown[] }>();
    expect(nodes).toEqual([]);
  });

  it('counts files per tema/ tag', async () => {
    // Two files with tag "tema/educación"
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'file1.md',
        hash: sha256hex('file1'),
        tagsJson: JSON.stringify(['tema/educación', 'other-tag']),
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'file2.md',
        hash: sha256hex('file2'),
        tagsJson: JSON.stringify(['tema/educación', 'tema/science']),
      })
      .onConflictDoNothing()
      .run();
    // One file with only "other-tag" (non-tema)
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'file3.md',
        hash: sha256hex('file3'),
        tagsJson: JSON.stringify(['other-tag']),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/topics',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json<{ nodes: Array<{ tag: string; count: number }> }>();

    const educacion = nodes.find((n) => n.tag === 'tema/educación');
    expect(educacion?.count).toBe(2);

    const science = nodes.find((n) => n.tag === 'tema/science');
    expect(science?.count).toBe(1);

    // Non-tema tag should not appear
    expect(nodes.find((n) => n.tag === 'other-tag')).toBeUndefined();
  });

  it('non-tema tags do not pollute topics tree', async () => {
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'mixed.md',
        hash: sha256hex('mixed'),
        tagsJson: JSON.stringify(['project/foo', 'status/done', 'tema/valid']),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/topics',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { nodes } = res.json<{ nodes: Array<{ tag: string }> }>();
    for (const n of nodes) {
      expect(n.tag).toMatch(/^tema\//);
    }
  });
});

// ---------------------------------------------------------------------------
// /topics/:tag
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/topics/:tag — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns files matching the tag', async () => {
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'tagged.md',
        hash: sha256hex('tagged'),
        title: 'Tagged Note',
        tagsJson: JSON.stringify(['tema/philosophy']),
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'other.md',
        hash: sha256hex('other'),
        tagsJson: JSON.stringify(['tema/science']),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/topics/philosophy',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { tag, files } = res.json<{
      tag: string;
      files: Array<{ path: string; title: string | null }>;
    }>();
    expect(tag).toBe('tema/philosophy');
    expect(files.length).toBe(1);
    expect(files[0]?.path).toBe('tagged.md');
    expect(files[0]?.title).toBe('Tagged Note');
  });

  it('returns empty files array for unknown tag', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/ct-grp/topics/nonexistent-tag',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { files } = res.json<{ files: unknown[] }>();
    expect(files).toEqual([]);
  });
});
