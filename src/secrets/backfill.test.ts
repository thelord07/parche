/**
 * PARCHE-012 — backfill de escaneo de secretos (ticket · test 4 A/B + N1/D2).
 * Modelado en src/meta/backfill.test.ts.
 */
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import { cleanupDir, makeApp, makeTempDataDir, seedGroupWithDevice } from '../test-helpers.js';
import { runSecretScan, startSecretScanBackground } from './backfill.js';
import { MAX_FINDINGS_PER_PATH } from './scan-path.js';
import type { SecretScanStatus } from './scan-status.js';

function makeTestStorage(blobs: Map<string, string>) {
  return {
    async get(hash: string): Promise<Readable | null> {
      const content = blobs.get(hash);
      if (content === undefined) return null;
      return Readable.from(Buffer.from(content, 'utf8'));
    },
    async put(_hash: string, _src: unknown) {
      return { created: true, size: 0 };
    },
    async has(hash: string) {
      return blobs.has(hash);
    },
    async size(hash: string) {
      return blobs.get(hash)?.length ?? null;
    },
  };
}

describe('secret-scan backfill', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('A: seed a .md with a secret → runSecretScan → 1 open row', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'a'.repeat(64);
    const content = 'value: AKIAIOSFODNN7EXAMPLE\n';
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'secret.md',
        pathKey: 'secret.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const rows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).toBeNull();
    expect(rows[0]?.kind).toBe('aws-access-key');
    expect(secretScanStatus.scan).toBe('done');

    await app.close();
  });

  it('idempotency: second run → same row count, found_at unchanged, no pending left', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'b'.repeat(64);
    const content = 'value: AKIAIOSFODNN7EXAMPLE\n';
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'secret2.md',
        pathKey: 'secret2.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });
    const firstRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();

    await runSecretScan({ db: app.db, storage, secretScanStatus });
    const secondRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();

    expect(secondRows).toHaveLength(firstRows.length);
    expect(secondRows[0]?.foundAt).toBe(firstRows[0]?.foundAt);

    await app.close();
  });

  it('B: resolved_at set when the head moves to a clean blob; row stays (never deleted)', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const dirtyHash = 'c'.repeat(64);
    const cleanHash = 'd'.repeat(64);
    const storage = makeTestStorage(
      new Map([
        [dirtyHash, 'value: AKIAIOSFODNN7EXAMPLE\n'],
        [cleanHash, 'nada que ver aquí\n'],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'c3.md',
        pathKey: 'c3.md',
        headHash: dirtyHash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });
    const before = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(before).toHaveLength(1);
    expect(before[0]?.resolvedAt).toBeNull();

    // Head moves to a clean blob
    app.db
      .update(files)
      .set({ headHash: cleanHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'c3.md')))
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'c3.md', cleanHash);

    const after = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(after).toHaveLength(1); // nunca se borra
    expect(after[0]?.resolvedAt).not.toBeNull();

    await app.close();
  });

  it('staleness: scanHeadForPath with a hash that is no longer the head writes nothing', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'e'.repeat(64);
    const newerHash = 'f'.repeat(64);
    const storage = makeTestStorage(
      new Map([
        [hash, 'value: AKIAIOSFODNN7EXAMPLE\n'],
        [newerHash, 'nada\n'],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'stale.md',
        pathKey: 'stale.md',
        headHash: newerHash,
        headSeq: 2,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');
    // hash is stale — the head is already newerHash
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'stale.md', hash);

    const rows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(rows).toHaveLength(0);
    const scanState = app.db
      .select()
      .from(secretScanState)
      .where(and(eq(secretScanState.groupId, group.groupId), eq(secretScanState.path, 'stale.md')))
      .get();
    expect(scanState).toBeUndefined();

    await app.close();
  });

  it('tombstone (D2): a head set to null resolves open findings on the next scan', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'g'.repeat(64);
    const storage = makeTestStorage(new Map([[hash, 'value: AKIAIOSFODNN7EXAMPLE\n']]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'tomb.md',
        pathKey: 'tomb.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    // Tombstone it
    app.db
      .update(files)
      .set({ headHash: null })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'tomb.md')))
      .run();

    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const rows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resolvedAt).not.toBeNull();

    await app.close();
  });

  it('partial clean (B3): only the finding whose secret disappeared is closed, the other stays open', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const bothHash = 'h'.repeat(64);
    const onlyOneHash = 'i'.repeat(64);
    const storage = makeTestStorage(
      new Map([
        [bothHash, 'a: AKIAIOSFODNN7EXAMPLE\nb: pch_abcdefgh12345678\n'],
        [onlyOneHash, 'a: AKIAIOSFODNN7EXAMPLE\n'],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'partial.md',
        pathKey: 'partial.md',
        headHash: bothHash,
        headSeq: 1,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'partial.md', bothHash);

    const beforeRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(beforeRows).toHaveLength(2);
    expect(beforeRows.every((r) => r.resolvedAt === null)).toBe(true);

    app.db
      .update(files)
      .set({ headHash: onlyOneHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'partial.md')))
      .run();
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'partial.md', onlyOneHash);

    const afterRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(afterRows).toHaveLength(2);
    const open = afterRows.filter((r) => r.resolvedAt === null);
    const closed = afterRows.filter((r) => r.resolvedAt !== null);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe('aws-access-key');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.kind).toBe('parche-token');

    await app.close();
  });

  it('N1 — truncation-150: no row is ever closed across two runs when findings exceed the cap', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    // 150 distinct AWS-shaped keys → > MAX_FINDINGS_PER_PATH (100) distinct findings,
    // proving the truncation branch is actually hit (not just "<= cap" by luck).
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) {
      lines.push(`AKIA${String(i).padStart(16, '0')}`);
    }
    const content = lines.map((v) => `key: ${v}`).join('\n');
    const hash = 'j'.repeat(64);
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'many.md',
        pathKey: 'many.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'many.md', hash);

    // Query ALL rows (no isNull filter) — proves nothing beyond the cap was inserted
    // and that the truncation branch really fired (exactly MAX_FINDINGS_PER_PATH rows).
    const afterFirst = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(afterFirst).toHaveLength(MAX_FINDINGS_PER_PATH);
    expect(afterFirst.every((r) => r.resolvedAt === null)).toBe(true);

    // Second run over the same (unchanged) content: nothing gets closed.
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'many.md', hash);
    const afterSecond = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(afterSecond).toHaveLength(MAX_FINDINGS_PER_PATH);
    expect(
      afterSecond.filter((r) => r.resolvedAt !== null),
      'no row should ever be closed when the finding set was truncated',
    ).toHaveLength(0);

    await app.close();
  });

  it('reopen: dirty → clean (resolved) → ack → dirty again (different content, same secret) reopens the SAME row', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const dirtyHash1 = 'l'.repeat(64);
    const cleanHash = 'm'.repeat(64);
    const dirtyHash2 = 'n'.repeat(64);
    const storage = makeTestStorage(
      new Map([
        [dirtyHash1, `value: ${secret}\n`],
        [cleanHash, 'nada que ver aquí\n'],
        // Different surrounding content, same secret value → same (kind,fingerprint).
        [dirtyHash2, `# otra nota distinta\nvalue: ${secret}\notro texto\n`],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'reopen.md',
        pathKey: 'reopen.md',
        headHash: dirtyHash1,
        headSeq: 1,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');

    // 1. Dirty → 1 open row.
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'reopen.md', dirtyHash1);
    const afterDirty = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(afterDirty).toHaveLength(1);
    const findingId = afterDirty[0]!.id;

    // 2. Head moves to a clean blob → row resolved.
    app.db
      .update(files)
      .set({ headHash: cleanHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'reopen.md')))
      .run();
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'reopen.md', cleanHash);
    const afterClean = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.id, findingId))
      .get();
    expect(afterClean?.resolvedAt).not.toBeNull();

    // 3. Ack it (as the web route does — db.update, never a new row).
    const ackedAt = new Date().toISOString();
    app.db
      .update(secretFindings)
      .set({ acknowledgedAt: ackedAt, acknowledgedBy: group.userId })
      .where(eq(secretFindings.id, findingId))
      .run();
    const afterAck = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.id, findingId))
      .get();
    expect(afterAck?.acknowledgedAt).not.toBeNull();
    expect(afterAck?.acknowledgedBy).toBe(group.userId);

    // 4. Head moves to dirty content again — different text, SAME secret value.
    app.db
      .update(files)
      .set({ headHash: dirtyHash2 })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'reopen.md')))
      .run();
    await scanHeadForPath({ db: app.db, storage }, group.groupId, 'reopen.md', dirtyHash2);

    const rows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(rows).toHaveLength(1); // onConflictDoUpdate reopened the SAME row, never a new one.
    const reopened = rows[0]!;
    expect(reopened.id).toBe(findingId);
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.acknowledgedAt).toBeNull();
    expect(reopened.acknowledgedBy).toBeNull();
    expect(reopened.foundAt).toBe(afterDirty[0]!.foundAt); // found_at unchanged
    expect(reopened.hash).toBe(dirtyHash2);

    await app.close();
  });

  it('1 note with 2 kinds → secret_scan_state written, second run has nothing pending', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'k'.repeat(64);
    const content = 'a: AKIAIOSFODNN7EXAMPLE\nb: pch_abcdefgh12345678\n';
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'twokinds.md',
        pathKey: 'twokinds.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const rows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds.has('aws-access-key')).toBe(true);
    expect(kinds.has('parche-token')).toBe(true);

    const state = app.db
      .select()
      .from(secretScanState)
      .where(
        and(eq(secretScanState.groupId, group.groupId), eq(secretScanState.path, 'twokinds.md')),
      )
      .get();
    expect(state?.hash).toBe(hash);

    await runSecretScan({ db: app.db, storage, secretScanStatus });
    const rows2 = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(rows2).toHaveLength(rows.length);

    await app.close();
  });

  it('startSecretScanBackground does not block synchronously', async () => {
    const app = await makeApp(dataDir);
    await app.ready();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    const storage = makeTestStorage(new Map());

    const before = Date.now();
    startSecretScanBackground({ db: app.db, storage, secretScanStatus });
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(50);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secretScanStatus.scan).toBe('done');

    await app.close();
  });
});
