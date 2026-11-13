/**
 * PARCHE-012 — backfill de escaneo de secretos (ticket · test 4 A/B + N1/D2).
 * Modelado en src/meta/backfill.test.ts.
 */
import { Readable } from 'node:stream';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { files, secretFindings, secretScanState } from '../db/schema.js';
import {
  cleanupDir,
  makeApp,
  makeTempDataDir,
  seedGroupWithDevice,
  seedWebSession,
} from '../test-helpers.js';
import { BATCH_SIZE, runSecretScan, startSecretScanBackground } from './backfill.js';
import { RULES_VERSION } from './rules-version.js';
import { MAX_FINDINGS_PER_PATH } from './scan-path.js';
import type { SecretScanStatus } from './scan-status.js';

/** Versión de reglas fija para las llamadas directas a `scanHeadForPath` en estos tests. */
const TEST_RULES_VERSION = RULES_VERSION;

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'c3.md',
      cleanHash,
      TEST_RULES_VERSION,
    );

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'stale.md',
      hash,
      TEST_RULES_VERSION,
    );

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'partial.md',
      bothHash,
      TEST_RULES_VERSION,
    );

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'partial.md',
      onlyOneHash,
      TEST_RULES_VERSION,
    );

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'many.md',
      hash,
      TEST_RULES_VERSION,
    );

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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'many.md',
      hash,
      TEST_RULES_VERSION,
    );
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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'reopen.md',
      dirtyHash1,
      TEST_RULES_VERSION,
    );
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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'reopen.md',
      cleanHash,
      TEST_RULES_VERSION,
    );
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
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'reopen.md',
      dirtyHash2,
      TEST_RULES_VERSION,
    );

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

// ---------------------------------------------------------------------------
// PARCHE-013 — S4.0 (B1): "no se escaneó" nunca equivale a "limpio".
// ---------------------------------------------------------------------------
describe('scanHeadForPath — B1 fail-open fix', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('head > SCAN_MAX_BYTES (.md) con un hallazgo abierto → resolved_at sigue NULL (contenido truncado, corrección 2)', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const { SCAN_MAX_BYTES } = await import('./scan-blob.js');
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const smallHash = 'o'.repeat(64);
    const bigHash = 'p'.repeat(64);
    // El head crece por encima de lo que `readBoundedFromStream` lee
    // (SCAN_MAX_BYTES + 1): el texto escaneado es solo el PREFIJO del blob
    // real (D3/OQ3 — `.md` es `isScannable`, así que `shouldScanContent` con
    // `gatePath` decodifica lossy y SIN tope lo que se le dé, pero nuestra
    // propia lectura acotada ya cortó el buffer). `contentTruncated` detecta
    // esto y S4.0 corrección 2 impide cerrar nada a partir de un prefijo.
    const bigContent = `${'x'.repeat(SCAN_MAX_BYTES + 1024)}\n${secret}\n`;
    const storage = makeTestStorage(
      new Map([
        [smallHash, `value: ${secret}\n`],
        [bigHash, bigContent],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'grows-too-big.md',
        pathKey: 'grows-too-big.md',
        headHash: smallHash,
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

    // Head crece por encima del tope de escaneo.
    app.db
      .update(files)
      .set({ headHash: bigHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'grows-too-big.md')))
      .run();

    await runSecretScan({ db: app.db, storage, secretScanStatus });
    const after = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(after).toHaveLength(1);
    // B1 — nunca se cierra solo porque no se pudo escanear (demasiado grande).
    expect(after[0]?.resolvedAt).toBeNull();

    await app.close();
  });

  it('T2 (rama lossy): un .md no-UTF-8 válido con un secreto SÍ se escanea y produce un hallazgo (paridad D3/OQ3)', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    // ISO-8859-1 con una ñ (0xF1 no es UTF-8 válido), con un secreto detrás.
    // Antes de D3/OQ3 el servidor se saltaba este archivo (rama estricta);
    // con `gatePath` pasado, `shouldScanContent` decodifica lossy y SIN tope
    // — exactamente el comportamiento 1.15.0 del cliente para `.md`.
    const binaryHash = 'r'.repeat(64);
    const content = Buffer.concat([
      Buffer.from([0xf1, 0xf1]), // inválido como UTF-8
      Buffer.from('\nvalue: AKIAIOSFODNN7EXAMPLE\n', 'utf8'),
    ]);
    const storage = {
      async get(hash: string): Promise<Readable | null> {
        return hash === binaryHash ? Readable.from(content) : null;
      },
      async put(_hash: string, _src: unknown) {
        return { created: true, size: 0 };
      },
      async has(hash: string) {
        return hash === binaryHash;
      },
      async size() {
        return null;
      },
    };

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'latin1.md',
        pathKey: 'latin1.md',
        headHash: binaryHash,
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
    expect(rows[0]?.kind).toBe('aws-access-key');
    expect(rows[0]?.resolvedAt).toBeNull();

    await app.close();
  });

  it('B1 defensivo: findings===null (ruta NO escaneable) nunca reconcilia, aunque se llame directo a scanHeadForPath', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    // Ruta sin extensión `isScannable` → gatePath queda undefined dentro de
    // scanHeadForPath → rama estricta de shouldScanContent → null para
    // binario. Ni push.ts ni el backfill llaman hoy a scanHeadForPath para
    // una ruta así (ambos filtran por isScannable primero), pero la función
    // debe seguir siendo segura si alguna vez se invoca igual (B1).
    const textHash = 'q'.repeat(64);
    const binaryHash = 'r2'.padEnd(64, '0');
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const storage = {
      async get(hash: string): Promise<Readable | null> {
        if (hash === textHash) return Readable.from(Buffer.from(`value: ${secret}\n`, 'utf8'));
        if (hash === binaryHash) {
          return Readable.from(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
        }
        return null;
      },
      async put(_hash: string, _src: unknown) {
        return { created: true, size: 0 };
      },
      async has(hash: string) {
        return hash === textHash || hash === binaryHash;
      },
      async size() {
        return null;
      },
    };

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'becomes-binary.data',
        pathKey: 'becomes-binary.data',
        headHash: textHash,
        headSeq: 1,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'becomes-binary.data',
      textHash,
      TEST_RULES_VERSION,
    );
    const before = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(before).toHaveLength(1);
    expect(before[0]?.resolvedAt).toBeNull();

    app.db
      .update(files)
      .set({ headHash: binaryHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'becomes-binary.data')))
      .run();

    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'becomes-binary.data',
      binaryHash,
      TEST_RULES_VERSION,
    );
    const after = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(after).toHaveLength(1);
    // B1 — nunca se cierra solo porque no se pudo escanear.
    expect(after[0]?.resolvedAt).toBeNull();

    // nit ronda 2 — aun sin reconciliar, se registra que ya se intentó con
    // esta versión de reglas (y este hash), para no releer el blob en cada
    // arranque mientras la ruta siga sin ser escaneable.
    const state = app.db
      .select()
      .from(secretScanState)
      .where(
        and(
          eq(secretScanState.groupId, group.groupId),
          eq(secretScanState.path, 'becomes-binary.data'),
        ),
      )
      .get();
    expect(state?.hash).toBe(binaryHash);
    expect(state?.rulesVersion).toBe(RULES_VERSION);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 — S4.2 (B2): ciclo de vida completo de `resolved_reason`.
// ---------------------------------------------------------------------------
describe('scanHeadForPath — resolved_reason lifecycle (B2)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('abrir → cerrar por rules_update → reabrir → cerrar de verdad por cambio de head', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const dirtyHash = 's'.repeat(64);
    const cleanHash = 't'.repeat(64);
    const dirtyHash2 = 'u'.repeat(64);
    const storage = makeTestStorage(
      new Map([
        [dirtyHash, `value: ${secret}\n`],
        [cleanHash, 'nada que ver aquí\n'],
        [dirtyHash2, `value: ${secret}\n`],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'b2-cycle.md',
        pathKey: 'b2-cycle.md',
        headHash: dirtyHash,
        headSeq: 1,
      })
      .run();

    const { scanHeadForPath } = await import('./scan-path.js');

    // 1. Abrir.
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'b2-cycle.md',
      dirtyHash,
      TEST_RULES_VERSION,
    );
    const open = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(open).toHaveLength(1);
    expect(open[0]?.resolvedAt).toBeNull();
    expect(open[0]?.resolvedReason).toBeNull();
    const findingId = open[0]!.id;

    // 2. Cerrar por `rules_update`: el head NO cambia (mismo hash), pero la
    // regla ya no lo flaguea — se simula pasando closeReason explícito
    // (equivalente a lo que backfill.ts calcula cuando hashChanged=false y
    // rulesChanged=true).
    app.db
      .update(secretFindings)
      .set({ hash: dirtyHash })
      .where(eq(secretFindings.id, findingId))
      .run();
    await scanHeadForPath(
      {
        db: app.db,
        storage: {
          ...storage,
          async get() {
            return Readable.from(Buffer.from('nada que ver aquí\n', 'utf8'));
          },
        },
      },
      group.groupId,
      'b2-cycle.md',
      dirtyHash,
      TEST_RULES_VERSION,
      'rules_update',
    );
    const closedByRules = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.id, findingId))
      .get();
    expect(closedByRules?.resolvedAt).not.toBeNull();
    expect(closedByRules?.resolvedReason).toBe('rules_update');
    expect(closedByRules?.acknowledgedAt).toBeNull();

    // 3. Reabrir — mismo valor de secreto, misma fila (UNIQUE
    // group/path/kind/fingerprint): resolved_at/resolved_reason/acknowledged_*
    // vuelven a NULL, found_at no cambia.
    app.db
      .update(files)
      .set({ headHash: dirtyHash2 })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'b2-cycle.md')))
      .run();
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'b2-cycle.md',
      dirtyHash2,
      TEST_RULES_VERSION,
    );
    const reopened = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.id, findingId))
      .get();
    expect(reopened?.id).toBe(findingId);
    expect(reopened?.resolvedAt).toBeNull();
    expect(reopened?.resolvedReason).toBeNull();
    expect(reopened?.acknowledgedAt).toBeNull();
    expect(reopened?.acknowledgedBy).toBeNull();
    expect(reopened?.foundAt).toBe(open[0]?.foundAt);

    // 4. Cerrar de verdad — el head avanza a un blob limpio, sin closeReason:
    // resolved_reason debe quedar NULL (cierre normal, requiere ack).
    app.db
      .update(files)
      .set({ headHash: cleanHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'b2-cycle.md')))
      .run();
    await scanHeadForPath(
      { db: app.db, storage },
      group.groupId,
      'b2-cycle.md',
      cleanHash,
      TEST_RULES_VERSION,
    );
    const closedNormally = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.id, findingId))
      .get();
    expect(closedNormally?.resolvedAt).not.toBeNull();
    expect(closedNormally?.resolvedReason).toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 — D3: re-escaneo completo cuando cambia la versión de reglas.
// ---------------------------------------------------------------------------
describe('runSecretScan — re-scan on rules_version change (D3)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('un archivo limpio escaneado con una versión vieja se re-escanea cuando la versión actual difiere y abre un hallazgo nuevo', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const secret = 'sk_' + 'live_' + '51H8FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1234';
    const hash = 'v'.repeat(64);
    const storage = makeTestStorage(new Map([[hash, `stripe: ${secret}\n`]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'old-version.md',
        pathKey: 'old-version.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const now = new Date().toISOString();
    // Simula un escaneo previo con una versión de reglas vieja que no
    // conocía el patrón sk_live_ — "limpio" bajo esa versión.
    app.db
      .insert(secretScanState)
      .values({
        groupId: group.groupId,
        path: 'old-version.md',
        hash,
        rulesVersion: '0.0.1',
        scannedAt: now,
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
    expect(rows[0]?.kind).toBe('stripe-secret-key');

    const state = app.db
      .select()
      .from(secretScanState)
      .where(
        and(eq(secretScanState.groupId, group.groupId), eq(secretScanState.path, 'old-version.md')),
      )
      .get();
    expect(state?.rulesVersion).toBe(RULES_VERSION);

    await app.close();
  });

  it('segundo arranque con la misma versión de reglas: 0 rutas pendientes, nada vuelve a leerse', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'w'.repeat(64);
    let reads = 0;
    const storage = {
      async get(h: string): Promise<Readable | null> {
        reads++;
        if (h !== hash) return null;
        return Readable.from(Buffer.from('nada que ver aquí\n', 'utf8'));
      },
      async put(_hash: string, _src: unknown) {
        return { created: true, size: 0 };
      },
      async has(h: string) {
        return h === hash;
      },
      async size() {
        return null;
      },
    };

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'stable.md',
        pathKey: 'stable.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });
    expect(reads).toBe(1);
    expect(secretScanStatus.pending).toBe(0);

    await runSecretScan({ db: app.db, storage, secretScanStatus });
    // Mismo hash, misma rulesVersion registrada → ya no entra en pending.
    expect(reads).toBe(1);
    expect(secretScanStatus.pending).toBe(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Review ronda 1 (#1) — closeReason derivation dentro de runSecretScan
// (findPendingPaths/toPendingPath), no literal, y verificado también por la
// ruta web (GET /api/web/g/:slug/secrets).
// Review ronda 1 (#4) — rollback safety: solo semver mayor cierra por
// rules_update.
// ---------------------------------------------------------------------------
describe('runSecretScan — closeReason derivation (review ronda 1 #1/#4)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('(a) hash sin cambiar + rules_version vieja (menor) + hallazgo que ya no aplica → resolved_reason=rules_update, excluido de open y pendingRotation', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);
    const ownerSession = seedWebSession(app, group.userId);

    // Contenido que YA NO matchea ninguna regla (el caso del ticket:
    // `crypto.randomUUID()` sin comillas no es un `assignment`).
    const content = 'const token = crypto.randomUUID();\n';
    const hash = 'z1'.padEnd(64, '1');
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'reda.md',
        pathKey: 'reda.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    // Hallazgo abierto previamente, con el MISMO hash del head actual (no
    // hay cambio de contenido) y una versión de reglas VIEJA (menor que la
    // instalada) en secret_scan_state.
    const now = new Date().toISOString();
    app.db
      .insert(secretFindings)
      .values({
        groupId: group.groupId,
        path: 'reda.md',
        hash,
        kind: 'assignment',
        fingerprint: 'aaaaaaaaaaaa',
        foundAt: now,
        resolvedAt: null,
        resolvedReason: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
      })
      .run();
    app.db
      .insert(secretScanState)
      .values({
        groupId: group.groupId,
        path: 'reda.md',
        hash,
        rulesVersion: '0.0.1',
        scannedAt: now,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    // Pasa por runSecretScan → findPendingPaths/fetchPendingBatch/toPendingPath
    // calcula el closeReason; no se pasa 'rules_update' a mano en el test.
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const row = app.db
      .select()
      .from(secretFindings)
      .where(and(eq(secretFindings.groupId, group.groupId), eq(secretFindings.path, 'reda.md')))
      .get();
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedReason).toBe('rules_update');

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/g/${group.groupSlug}/secrets`,
      cookies: { parche_session: ownerSession },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      open: { items: Array<{ path: string }> };
      pendingRotation: { items: Array<{ path: string }> };
    }>();
    expect(body.open.items.some((i) => i.path === 'reda.md')).toBe(false);
    expect(body.pendingRotation.items.some((i) => i.path === 'reda.md')).toBe(false);

    await app.close();
  });

  it('(b) hash CAMBIADO + rules_version vieja → resolved_reason=null (cierre normal), SÍ aparece en pendingRotation', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);
    const ownerSession = seedWebSession(app, group.userId);

    const dirtyHash = 'z2'.padEnd(64, '2');
    const cleanHash = 'z3'.padEnd(64, '3');
    const storage = makeTestStorage(
      new Map([
        [dirtyHash, 'aws: AKIAIOSFODNN7EXAMPLE\n'],
        [cleanHash, 'nada que ver aquí\n'],
      ]),
    );

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'redb.md',
        pathKey: 'redb.md',
        headHash: dirtyHash,
        headSeq: 1,
      })
      .run();

    const now = new Date().toISOString();
    app.db
      .insert(secretFindings)
      .values({
        groupId: group.groupId,
        path: 'redb.md',
        hash: dirtyHash,
        kind: 'aws-access-key',
        fingerprint: 'bbbbbbbbbbbb',
        foundAt: now,
        resolvedAt: null,
        resolvedReason: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
      })
      .run();
    // secret_scan_state registrado con el hash VIEJO (ya escaneado antes) y
    // una rules_version también vieja.
    app.db
      .insert(secretScanState)
      .values({
        groupId: group.groupId,
        path: 'redb.md',
        hash: dirtyHash,
        rulesVersion: '0.0.1',
        scannedAt: now,
      })
      .run();

    // El head AVANZA a un blob limpio distinto — el contenido sí cambió.
    app.db
      .update(files)
      .set({ headHash: cleanHash })
      .where(and(eq(files.groupId, group.groupId), eq(files.path, 'redb.md')))
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const row = app.db
      .select()
      .from(secretFindings)
      .where(and(eq(secretFindings.groupId, group.groupId), eq(secretFindings.path, 'redb.md')))
      .get();
    expect(row?.resolvedAt).not.toBeNull();
    // Cierre normal — el contenido cambió, así que SÍ requiere ack.
    expect(row?.resolvedReason).toBeNull();

    const res = await app.inject({
      method: 'GET',
      url: `/api/web/g/${group.groupSlug}/secrets`,
      cookies: { parche_session: ownerSession },
    });
    const body = res.json<{ pendingRotation: { items: Array<{ path: string }> } }>();
    expect(body.pendingRotation.items.some((i) => i.path === 'redb.md')).toBe(true);

    await app.close();
  });

  it('(rollback safety) rules_version instalada NO mayor (igual) que la registrada → nunca rules_update, aunque el hash esté intacto', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const content = 'const token = crypto.randomUUID();\n';
    const hash = 'z4'.padEnd(64, '4');
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'rollback.md',
        pathKey: 'rollback.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const now = new Date().toISOString();
    app.db
      .insert(secretFindings)
      .values({
        groupId: group.groupId,
        path: 'rollback.md',
        hash,
        kind: 'assignment',
        fingerprint: 'cccccccccccc',
        foundAt: now,
        resolvedAt: null,
        resolvedReason: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
      })
      .run();
    // Misma versión instalada registrada ya (no "vieja", no "mayor"): un
    // reintento del mismo arranque no debe inventar un rules_update.
    app.db
      .insert(secretScanState)
      .values({
        groupId: group.groupId,
        path: 'rollback.md',
        hash,
        rulesVersion: RULES_VERSION,
        scannedAt: now,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    // Al ser igual la versión, la ruta ni siquiera entra en pendientes —
    // el hallazgo sigue abierto (ni normal ni rules_update).
    const row = app.db
      .select()
      .from(secretFindings)
      .where(and(eq(secretFindings.groupId, group.groupId), eq(secretFindings.path, 'rollback.md')))
      .get();
    expect(row?.resolvedAt).toBeNull();

    await app.close();
  });

  it('(rollback safety) rules_version registrada MAYOR que la instalada (downgrade de @chamba/core) → nunca rules_update', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const content = 'const token = crypto.randomUUID();\n';
    const hash = 'z5'.padEnd(64, '5');
    const storage = makeTestStorage(new Map([[hash, content]]));

    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'downgrade.md',
        pathKey: 'downgrade.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    const now = new Date().toISOString();
    app.db
      .insert(secretFindings)
      .values({
        groupId: group.groupId,
        path: 'downgrade.md',
        hash,
        kind: 'assignment',
        fingerprint: 'dddddddddddd',
        foundAt: now,
        resolvedAt: null,
        resolvedReason: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
      })
      .run();
    // Registrada con una versión MAYOR que la instalada ahora (simula que el
    // servidor se degradó/rollback a una @chamba/core más vieja después de
    // haber escaneado con una más nueva).
    app.db
      .insert(secretScanState)
      .values({
        groupId: group.groupId,
        path: 'downgrade.md',
        hash,
        rulesVersion: '999.0.0',
        scannedAt: now,
      })
      .run();

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    const row = app.db
      .select()
      .from(secretFindings)
      .where(
        and(eq(secretFindings.groupId, group.groupId), eq(secretFindings.path, 'downgrade.md')),
      )
      .get();
    // La ruta SÍ se re-escanea (rulesVersion difiere), y el contenido ya no
    // matchea — pero como la versión instalada NO es mayor (es menor), el
    // cierre es NORMAL, nunca rules_update (pide ack).
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.resolvedReason).toBeNull();

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Review ronda 2 (#2) — BATCH_SIZE + k rutas pendientes, con un blob
// ausente a mitad del primer lote y rutas no escaneables (.png) mezcladas.
// Prueba las tres correcciones de ronda 2 a la vez: el filtro SQL por
// extensión (las .png nunca entran al conjunto pendiente), el conteo único
// antes del bucle (no por página), y que el blob ausente no detenga el
// cursor dentro de la misma corrida.
// ---------------------------------------------------------------------------
describe('runSecretScan — BATCH_SIZE+k rutas, blob ausente, rutas no escaneables (review ronda 2 #2)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('procesa las dos páginas completas; el blob ausente (mitad de la 1ª página) no detiene el cursor; .png nunca es "pendiente"', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const N = BATCH_SIZE + 10; // dos páginas: 500 + 10
    const MISSING_BLOB_INDEX = 250; // a mitad de la primera página
    const SECRET_INDEXES = new Set([0, N - 1]); // primer path (página 1) y último (página 2)

    const hashFor = (i: number) => i.toString().padStart(64, '0');
    const pathFor = (i: number) => `scan-test/note${String(i).padStart(4, '0')}.md`;

    const blobs = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      if (i === MISSING_BLOB_INDEX) continue; // deliberadamente ausente del storage
      blobs.set(
        hashFor(i),
        SECRET_INDEXES.has(i) ? 'aws: AKIAIOSFODNN7EXAMPLE\n' : 'nada que ver aquí\n',
      );
    }
    const storage = makeTestStorage(blobs);

    for (let i = 0; i < N; i++) {
      app.db
        .insert(files)
        .values({
          groupId: group.groupId,
          path: pathFor(i),
          pathKey: pathFor(i),
          headHash: hashFor(i),
          headSeq: i + 1,
        })
        .run();
    }

    // Rutas vivas NO escaneables (.png) — no deben seleccionarse nunca,
    // ni contar como "pendientes", ni obtener fila en secret_scan_state.
    const PNG_COUNT = 5;
    for (let i = 0; i < PNG_COUNT; i++) {
      app.db
        .insert(files)
        .values({
          groupId: group.groupId,
          path: `assets/image${i}.png`,
          pathKey: `assets/image${i}.png`,
          headHash: `png${i}`.padStart(64, '0'),
          headSeq: 100000 + i,
        })
        .run();
    }

    const secretScanStatus: SecretScanStatus = { scan: 'idle' };
    await runSecretScan({ db: app.db, storage, secretScanStatus });

    // Toda ruta escaneable, salvo la del blob ausente, quedó registrada en
    // secret_scan_state con el hash/versión actuales — incluidas rutas de
    // la 1ª Y la 2ª página.
    for (let i = 0; i < N; i++) {
      const state = app.db
        .select()
        .from(secretScanState)
        .where(
          and(eq(secretScanState.groupId, group.groupId), eq(secretScanState.path, pathFor(i))),
        )
        .get();
      if (i === MISSING_BLOB_INDEX) {
        expect(
          state,
          `path ${i} (blob ausente) no debería avanzar secret_scan_state`,
        ).toBeUndefined();
      } else {
        expect(state?.hash, `path ${i}`).toBe(hashFor(i));
        expect(state?.rulesVersion, `path ${i}`).toBe(RULES_VERSION);
      }
    }

    // Hallazgos esperados en la PRIMERA (índice 0) y ÚLTIMA (índice N-1,
    // segunda página) ruta con secreto — la paginación no pierde filas.
    for (const i of SECRET_INDEXES) {
      const row = app.db
        .select()
        .from(secretFindings)
        .where(and(eq(secretFindings.groupId, group.groupId), eq(secretFindings.path, pathFor(i))))
        .get();
      expect(row?.kind, `path ${i}`).toBe('aws-access-key');
      expect(row?.resolvedAt, `path ${i}`).toBeNull();
    }

    // El path con blob ausente no generó ningún hallazgo (nada que escanear).
    const missingRow = app.db
      .select()
      .from(secretFindings)
      .where(
        and(
          eq(secretFindings.groupId, group.groupId),
          eq(secretFindings.path, pathFor(MISSING_BLOB_INDEX)),
        ),
      )
      .get();
    expect(missingRow).toBeUndefined();

    // Las .png nunca obtuvieron secret_scan_state (nunca se seleccionaron).
    for (let i = 0; i < PNG_COUNT; i++) {
      const state = app.db
        .select()
        .from(secretScanState)
        .where(
          and(
            eq(secretScanState.groupId, group.groupId),
            eq(secretScanState.path, `assets/image${i}.png`),
          ),
        )
        .get();
      expect(state, `png ${i}`).toBeUndefined();
    }

    // Estado final: las N-1 rutas escaneables con blob se escanearon con
    // éxito; la del blob ausente cuenta como `failed`, no como `scanned`,
    // pero YA se intentó en esta corrida (el cursor pasó de largo). `pending`
    // llega a 0 porque, para efectos de ESTA corrida, no queda nada por
    // INTENTAR — la ruta fallida sigue genuinamente pendiente para la
    // PRÓXIMA corrida (su secret_scan_state nunca avanzó, así que
    // `pendingCondition` la volverá a seleccionar en el próximo arranque).
    expect(secretScanStatus.scanned).toBe(N - 1);
    expect(secretScanStatus.pending).toBe(0);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PARCHE-013 (A14) — la selección de pendientes está acotada por índice, sin
// full table scan de secret_findings. No se añade ningún índice nuevo.
// ---------------------------------------------------------------------------
describe('runSecretScan — selección acotada por índice (A14)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('la query real de runSecretScan (buildPendingBatchQuery.toSQL()) no hace full scan de files, sin cursor', async () => {
    const app = await makeApp(dataDir);
    await app.ready();

    // Nota: A14 mencionaba `secret_findings_open_idx` para la selección
    // originalmente propuesta en S4.1 (acotada a hallazgos abiertos); esta
    // implementación reutiliza en su lugar el mecanismo de backfill YA
    // EXISTENTE (más amplio, cubre D3 — re-escaneo completo cuando cambia
    // rules_version), que nunca consulta secret_findings para la selección,
    // así que ese índice no aplica aquí.
    const { buildPendingBatchQuery } = await import('./backfill.js');
    const { sql: querySql, params } = buildPendingBatchQuery(app.db, RULES_VERSION, null).toSQL();

    const plan = app.rawDb.prepare(`EXPLAIN QUERY PLAN ${querySql}`).all(...params) as Array<{
      detail: string;
    }>;
    const detail = plan.map((row) => row.detail).join(' | ');

    // El LEFT JOIN se resuelve por índice (PK de secret_scan_state), no por
    // un segundo full scan de la tabla más grande.
    expect(detail).toMatch(/USING INDEX/);
    // files es la tabla ancla del LEFT JOIN: aparece una vez, nunca un
    // segundo acceso de tipo SCAN sobre ella.
    const filesScanCount = (detail.match(/SCAN f(?:iles)?\b/g) ?? []).length;
    expect(filesScanCount).toBeLessThanOrEqual(1);

    await app.close();
  });

  it('con cursor (keyset), la misma query sigue resolviendo por índice — no degrada a full scan en páginas posteriores', async () => {
    const app = await makeApp(dataDir);
    await app.ready();

    const { buildPendingBatchQuery } = await import('./backfill.js');
    const { sql: querySql, params } = buildPendingBatchQuery(app.db, RULES_VERSION, {
      groupId: 'g1',
      path: 'a.md',
    }).toSQL();

    const plan = app.rawDb.prepare(`EXPLAIN QUERY PLAN ${querySql}`).all(...params) as Array<{
      detail: string;
    }>;
    const detail = plan.map((row) => row.detail).join(' | ');
    expect(detail).toMatch(/USING INDEX/);

    await app.close();
  });
});
