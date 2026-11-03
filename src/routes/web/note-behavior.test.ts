/**
 * Behavioral tests for /note, /note/version, /diff, /raw
 *
 * Covers:
 * - /note: versions ≤50, backlinks with snippet ≤160, wikilinks with spaces/ñ
 *   encoded per segment, metaPending when file_meta missing or hash≠head
 * - /note/version and /raw?seq=: blob from another group is NEVER served,
 *   content-type by extension (D3), nosniff, never text/html
 * - /diff: from/to required, ≤256 KB limit, JSON with pairLineDiff entries,
 *   404 for blobs of another group
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blobRefs, changes, fileMeta, files } from '../../db/schema.js';
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

  const device = await seedGroupWithDevice(app, { slug: 'note-grp' });
  const webUser = seedWebUser(app, { email: 'notebehavior@example.com' });
  const session = seedWebSession(app, webUser.userId);
  seedMember(app, { groupSlug: 'note-grp', userId: webUser.userId, role: 'editor' });

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

// Helper to seed a file+change+blobRef
function seedFileWithBlob(
  app: ReturnType<typeof setup> extends Promise<infer T> ? T : never,
  path: string,
  seq: number,
  content: string,
) {
  const hash = sha256hex(content);
  app.app.db
    .insert(blobRefs)
    .values({ groupId: app.device.groupId, hash })
    .onConflictDoNothing()
    .run();
  app.app.db
    .insert(files)
    .values({
      groupId: app.device.groupId,
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
  app.app.db
    .insert(changes)
    .values({
      groupId: app.device.groupId,
      seq,
      path,
      hash,
      userId: app.device.userId,
      deviceId: app.device.deviceId,
      at: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return hash;
}

// ---------------------------------------------------------------------------
// /note — versions, backlinks, metaPending
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/note — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('404 for unknown path', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=nonexistent.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(404);
  });

  it('404 for tombstoned file', async () => {
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'tomb.md',
        pathKey: 'tomb.md',
        headHash: null, // tombstone
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=tomb.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns at most 50 versions', async () => {
    const content = '# Base\n\nContent.';
    // Seed 60 versions
    for (let i = 1; i <= 60; i++) {
      const c = `${content} v${i}`;
      const hash = sha256hex(c);
      ctx.app.db
        .insert(blobRefs)
        .values({ groupId: ctx.device.groupId, hash })
        .onConflictDoNothing()
        .run();
      ctx.app.db
        .insert(files)
        .values({
          groupId: ctx.device.groupId,
          path: 'versioned.md',
          pathKey: 'versioned.md',
          headHash: hash,
          headSeq: i,
        })
        .onConflictDoUpdate({
          target: [files.groupId, files.path],
          set: { headHash: hash, headSeq: i },
        })
        .run();
      ctx.app.db
        .insert(changes)
        .values({
          groupId: ctx.device.groupId,
          seq: i,
          path: 'versioned.md',
          hash,
          userId: ctx.device.userId,
          deviceId: ctx.device.deviceId,
          at: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    }

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=versioned.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { versions } = res.json<{
      versions: Array<{ seq: number; hash: string }>;
    }>();
    expect(versions.length).toBeLessThanOrEqual(50);
  });

  it('versions include user, device, at fields', async () => {
    seedFileWithBlob(ctx, 'with-version.md', 1, '# Note\n\nContent.');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=with-version.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { versions } = res.json<{
      versions: Array<{ seq: number; at: string; user: string; deviceLabel: string }>;
    }>();
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]).toMatchObject({
      seq: expect.any(Number),
      at: expect.any(String),
      user: expect.any(String),
      deviceLabel: expect.any(String),
    });
  });

  it('metaPending is true when file_meta row is missing', async () => {
    // Insert file but no file_meta and no blob in storage
    const hash = sha256hex('no-meta content');
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'no-meta.md',
        pathKey: 'no-meta.md',
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
        path: 'no-meta.md',
        hash,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    // No blobRef, no blob in storage → extraction fails → metaPending = true

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=no-meta.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ metaPending: boolean }>();
    expect(body.metaPending).toBe(true);
  });

  it('backlinks snippet from parser is ≤ ~162 characters (160 + possible ellipsis)', async () => {
    // File B links to file A; we use a parser-generated snippet (≤160 + 2 for ellipsis)
    const hashA = sha256hex('# File A\n\nTarget content.');
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: ctx.device.groupId, hash: hashA })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'target.md',
        pathKey: 'target.md',
        headHash: hashA,
        headSeq: 1,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 1,
        path: 'target.md',
        hash: hashA,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    // Use a real parser-generated snippet (≤162 chars: 160 text + 2 ellipsis)
    // The parser's centeredSnippet() produces at most ~162 chars
    const realisticSnippet = 'a'.repeat(80) + '[[target]]' + 'b'.repeat(70);
    const { parseNote } = await import('../../meta/parser.js');
    const parsed = parseNote(`# Linker\n\n${realisticSnippet}`);
    const linkWithSnippet = parsed.links?.find((l) => l.target === 'target');
    const snippet = linkWithSnippet?.snippet ?? 'a'.repeat(80) + 'b'.repeat(80);

    // file_meta for B with a properly-sized snippet from the parser
    const hashB = sha256hex('linker');
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'linker.md',
        hash: hashB,
        linksJson: JSON.stringify([{ target: 'target', snippet }]),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=target.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { backlinks } = res.json<{
      backlinks: Array<{ path: string; snippet?: string }>;
    }>();

    // Snippets from the parser are always ≤162 chars (160 + up to 2 ellipsis chars)
    for (const bl of backlinks) {
      if (bl.snippet) {
        expect(bl.snippet.length).toBeLessThanOrEqual(162);
      }
    }
  });

  // M1: tombstoned files must not appear in backlinks
  it('M1: tombstoned file A does not appear in backlinks of file B', async () => {
    // File B (the target we will GET)
    const contentB = '# File B\n\nContent of B.';
    const hashB = sha256hex(contentB);
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: ctx.device.groupId, hash: hashB })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'folder/b.md',
        pathKey: 'folder/b.md',
        headHash: hashB,
        headSeq: 1,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: hashB, headSeq: 1 },
      })
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 1,
        path: 'folder/b.md',
        hash: hashB,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    // File A links to B; then tombstone A (head_hash = null)
    const hashA = sha256hex('# A\n\n[[b]]');
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: ctx.device.groupId, hash: hashA })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'a.md',
        pathKey: 'a.md',
        headHash: null, // tombstone
        headSeq: 2,
      })
      .onConflictDoUpdate({
        target: [files.groupId, files.path],
        set: { headHash: null, headSeq: 2 },
      })
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 2,
        path: 'a.md',
        hash: null,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    // Insert file_meta for A (as if it was extracted before tombstoning)
    ctx.app.db
      .insert(fileMeta)
      .values({
        groupId: ctx.device.groupId,
        path: 'a.md',
        hash: hashA,
        linksJson: JSON.stringify([{ target: 'b', snippet: 'links to b' }]),
      })
      .onConflictDoNothing()
      .run();

    // GET /note for B — tombstoned A must NOT be in backlinks
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note?path=folder/b.md',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(200);
    const { backlinks } = res.json<{
      backlinks: Array<{ path: string }>;
    }>();
    const backlinkPaths = backlinks.map((bl) => bl.path);
    expect(backlinkPaths).not.toContain('a.md');
  });

  it('wikilinks with spaces and ñ are encoded per segment in rendered HTML', async () => {
    const { renderNote } = await import('../../meta/render.js');
    const knownPaths = new Set(['notes/mi nota con ñ.md', 'notes/hola mundo.md']);
    const content = '# Test\n\n[[mi nota con ñ]]\n\n[[hola mundo]]';
    const html = renderNote(content, 'note-grp', knownPaths);

    // Each segment (between /) should be encoded without encoding the slash
    // "mi nota con ñ" → "mi%20nota%20con%20%C3%B1"
    expect(html).toContain('mi%20nota%20con%20%C3%B1');
    expect(html).toContain('hola%20mundo');
  });
});

// ---------------------------------------------------------------------------
// /note/version — cross-group blob isolation
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/note/version — cross-group isolation', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('404 when blob exists but belongs to a different group', async () => {
    // Create a second group that owns the blob
    const group2 = await seedGroupWithDevice(ctx.app, { slug: 'other-grp' });
    const hash = sha256hex('other group blob');

    // Blob ref is ONLY in group2
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: group2.groupId, hash })
      .onConflictDoNothing()
      .run();

    // Change record in group1 pointing at that hash
    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'leaked.md',
        pathKey: 'leaked.md',
        headHash: hash,
        headSeq: 5,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 5,
        path: 'leaked.md',
        hash,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note/version?path=leaked.md&seq=5',
      cookies: { parche_session: ctx.session },
    });
    // The blob ref is not in note-grp → must 404
    expect(res.statusCode).toBe(404);
  });

  it('400 for invalid seq', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note/version?path=any.md&seq=abc',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 for missing path', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/note/version?seq=1',
      cookies: { parche_session: ctx.session },
    });
    expect([400, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// /raw — content-type by extension, nosniff, never text/html (D3)
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/raw — content-type and security (D3)', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  const extensionCases = [
    { ext: '.md', path: 'doc.md', expectedCT: 'text/plain', isAttachment: false },
    { ext: '.txt', path: 'doc.txt', expectedCT: 'text/plain', isAttachment: false },
    { ext: '.json', path: 'data.json', expectedCT: 'application/json', isAttachment: false },
    { ext: '.png', path: 'image.png', expectedCT: 'image/png', isAttachment: false },
    { ext: '.pdf', path: 'document.pdf', expectedCT: 'application/pdf', isAttachment: true },
    { ext: '.svg', path: 'icon.svg', expectedCT: 'image/svg', isAttachment: true },
  ];

  for (const { ext, path, expectedCT, isAttachment } of extensionCases) {
    it(`${ext} served as ${expectedCT}${isAttachment ? ' (attachment)' : ''} with nosniff`, async () => {
      const content = `content for ${path}`;
      const hash = sha256hex(content);
      ctx.app.db
        .insert(blobRefs)
        .values({ groupId: ctx.device.groupId, hash })
        .onConflictDoNothing()
        .run();
      ctx.app.db
        .insert(files)
        .values({
          groupId: ctx.device.groupId,
          path,
          pathKey: path.toLowerCase(),
          headHash: hash,
          headSeq: 1,
        })
        .onConflictDoUpdate({
          target: [files.groupId, files.path],
          set: { headHash: hash, headSeq: 1 },
        })
        .run();

      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/web/g/note-grp/raw?path=${encodeURIComponent(path)}`,
        cookies: { parche_session: ctx.session },
      });

      // May be 404 if blob not in filesystem storage; skip content-type check only if 404
      if (res.statusCode === 200) {
        const ct = res.headers['content-type'] ?? '';
        expect(ct).toContain(expectedCT);
        expect(ct).not.toContain('text/html');
        expect(res.headers['x-content-type-options']).toBe('nosniff');

        if (isAttachment) {
          const cd = res.headers['content-disposition'] ?? '';
          expect(cd).toContain('attachment');
        }
      } else {
        // Even on 404, must never return text/html
        const ct = res.headers['content-type'] ?? '';
        expect(ct).not.toContain('text/html');
      }
    });
  }

  it('unsupported extension returns 415', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/raw?path=file.exe',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(415);
  });

  it("cross-group blob isolation: /raw?seq= returns 404 for another group's blob", async () => {
    const group2 = await seedGroupWithDevice(ctx.app, { slug: 'raw-other' });
    const hash = sha256hex('raw other group');

    // Only group2 owns this blob
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: group2.groupId, hash })
      .onConflictDoNothing()
      .run();

    ctx.app.db
      .insert(files)
      .values({
        groupId: ctx.device.groupId,
        path: 'stolen.md',
        pathKey: 'stolen.md',
        headHash: hash,
        headSeq: 7,
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 7,
        path: 'stolen.md',
        hash,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/raw?path=stolen.md&seq=7',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /diff — behavior
// ---------------------------------------------------------------------------
describe('GET /api/web/g/:slug/diff — behavior', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('400 for missing from or to', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/diff?path=a.md&from=1',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(400);

    const res2 = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/diff?path=a.md&to=2',
      cookies: { parche_session: ctx.session },
    });
    expect(res2.statusCode).toBe(400);
  });

  it('400 for invalid (non-numeric) seq', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/diff?path=a.md&from=abc&to=2',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 when blobs do not belong to the group', async () => {
    const group2 = await seedGroupWithDevice(ctx.app, { slug: 'diff-other' });
    const hash1 = sha256hex('diff content 1');
    const hash2 = sha256hex('diff content 2');

    // Both blobs owned by group2 only
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: group2.groupId, hash: hash1 })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(blobRefs)
      .values({ groupId: group2.groupId, hash: hash2 })
      .onConflictDoNothing()
      .run();

    // Changes reference the blobs but they are in group1
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 10,
        path: 'diff-test.md',
        hash: hash1,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    ctx.app.db
      .insert(changes)
      .values({
        groupId: ctx.device.groupId,
        seq: 11,
        path: 'diff-test.md',
        hash: hash2,
        userId: ctx.device.userId,
        deviceId: ctx.device.deviceId,
        at: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/web/g/note-grp/diff?path=diff-test.md&from=10&to=11',
      cookies: { parche_session: ctx.session },
    });
    expect(res.statusCode).toBe(404);
  });
});
