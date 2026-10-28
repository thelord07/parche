/**
 * AC10: unlink targets only tmp/ paths.
 *
 * vi.mock MUST be at module top (hoisted) so FilesystemStorage closes over the
 * mocked unlink. vi.mock inside an it() is NOT hoisted and is vacuous — the
 * module has already been imported with the real implementation.
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDir, makeTempDataDir } from '../test-helpers.js';
import { FilesystemStorage } from './filesystem-storage.js';
import { BlobTooLargeError, HashMismatchError } from './storage-port.js';

// vi.hoisted ensures the array exists before the vi.mock factory runs.
const unlinkCalls = vi.hoisted(() => [] as string[]);

// Hoist the mock so FilesystemStorage's `import { unlink } from 'node:fs/promises'`
// resolves to this spy instead of the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...orig,
    unlink: vi.fn((p: unknown) => {
      unlinkCalls.push(String(p));
      return orig.unlink(p as string);
    }),
  };
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function listFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(full);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

describe('AC10: unlink targets only tmp/ paths', () => {
  let dataDir: string;

  beforeEach(async () => {
    // Clear the call log before each test.
    unlinkCalls.length = 0;
    dataDir = await makeTempDataDir();
  });

  afterEach(async () => {
    await cleanupDir(dataDir);
  });

  it('HashMismatch path: unlink is called at least once and all calls target <dataDir>/tmp/', async () => {
    const storage = new FilesystemStorage(dataDir, 20971520);
    const body = Buffer.from('some content for mismatch test');
    const wrongHash = sha256(Buffer.from('different content'));

    await expect(storage.put(wrongHash, body)).rejects.toThrow(HashMismatchError);

    // Non-vacuous: at least one unlink must have been called.
    expect(unlinkCalls.length).toBeGreaterThan(0);

    // Every unlink call must target a path under <dataDir>/tmp/.
    const tmpDir = join(dataDir, 'tmp');
    for (const callPath of unlinkCalls) {
      expect(callPath.startsWith(tmpDir)).toBe(true);
    }

    // No files remain under tmp/ after cleanup.
    const tmpFiles = await listFiles(join(dataDir, 'tmp'));
    expect(tmpFiles).toHaveLength(0);

    // No blobs were written.
    const blobFiles = await listFiles(join(dataDir, 'blobs'));
    expect(blobFiles).toHaveLength(0);
  });

  it('BlobTooLarge path: unlink is called at least once and all calls target <dataDir>/tmp/', async () => {
    const smallStorage = new FilesystemStorage(dataDir, 5);
    const oversizedBuf = Buffer.from('hello world!'); // 12 bytes > 5

    const source = Readable.from(
      (async function* () {
        yield oversizedBuf.slice(0, 4);
        yield oversizedBuf.slice(4);
      })(),
    );

    const hash = sha256(oversizedBuf);

    await expect(smallStorage.put(hash, source)).rejects.toThrow(BlobTooLargeError);

    // Non-vacuous: at least one unlink must have been called.
    expect(unlinkCalls.length).toBeGreaterThan(0);

    // Every unlink call must target a path under <dataDir>/tmp/.
    const tmpDir = join(dataDir, 'tmp');
    for (const callPath of unlinkCalls) {
      expect(callPath.startsWith(tmpDir)).toBe(true);
    }

    // No files remain under tmp/ after cleanup.
    const tmpFiles = await listFiles(join(dataDir, 'tmp'));
    expect(tmpFiles).toHaveLength(0);

    // No blobs were written.
    const blobFiles = await listFiles(join(dataDir, 'blobs'));
    expect(blobFiles).toHaveLength(0);
  });
});
