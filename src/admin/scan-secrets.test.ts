/**
 * Tests for the scan-secrets admin command (PARCHE-012).
 * Patrón de src/admin/backup-db.test.ts.
 */
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretFindings } from '../db/schema.js';
import { cleanupDir, makeApp, makeTempDataDir, seedGroupWithDevice } from '../test-helpers.js';
import { scanSecrets } from './commands.js';

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

describe('scanSecrets (admin command)', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('inserts findings on a seeded dataDir; a second run does not duplicate', async () => {
    const app = await makeApp(dataDir);
    await app.ready();
    const group = await seedGroupWithDevice(app);

    const hash = 'a'.repeat(64);
    const content = 'value: AKIAIOSFODNN7EXAMPLE\n';
    const storage = makeTestStorage(new Map([[hash, content]]));

    const { files } = await import('../db/schema.js');
    app.db
      .insert(files)
      .values({
        groupId: group.groupId,
        path: 'admin-test.md',
        pathKey: 'admin-test.md',
        headHash: hash,
        headSeq: 1,
      })
      .run();

    await scanSecrets(app.db, storage);

    const firstRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(firstRows).toHaveLength(1);

    await scanSecrets(app.db, storage);
    const secondRows = app.db
      .select()
      .from(secretFindings)
      .where(eq(secretFindings.groupId, group.groupId))
      .all();
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0]?.foundAt).toBe(firstRows[0]?.foundAt);

    await app.close();
  });
});
