import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDir, makeTempDataDir } from '../test-helpers.js';
import { FilesystemStorage } from './filesystem-storage.js';
import { BlobTooLargeError, HashMismatchError, InvalidHashError } from './storage-port.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Recursively list all regular files under dir.
 */
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

describe('FilesystemStorage', () => {
  let dataDir: string;
  let storage: FilesystemStorage;

  beforeEach(async () => {
    dataDir = await makeTempDataDir();
    storage = new FilesystemStorage(dataDir, 20971520);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupDir(dataDir);
  });

  // ---- put: created / idempotent / mtime ------------------------------------
  describe('put', () => {
    it('creates a new blob and returns {created:true}', async () => {
      const body = Buffer.from('hello storage');
      const hash = sha256(body);

      const result = await storage.put(hash, body);
      expect(result.created).toBe(true);
      expect(result.size).toBe(body.length);

      expect(await storage.has(hash)).toBe(true);
    });

    it('is idempotent — second put returns {created:false} and mtime unchanged', async () => {
      const body = Buffer.from('idempotent blob');
      const hash = sha256(body);

      await storage.put(hash, body);

      const blobsDir = join(dataDir, 'blobs');
      const blobFilePath = join(blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);

      const { stat: statFn } = await import('node:fs/promises');
      const statBefore = await statFn(blobFilePath);

      await new Promise((r) => setTimeout(r, 50));

      const result2 = await storage.put(hash, body);
      expect(result2.created).toBe(false);
      expect(result2.size).toBe(body.length);

      const statAfter = await statFn(blobFilePath);
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });
  });

  // ---- HashMismatchError + no files -----------------------------------------
  describe('HashMismatchError', () => {
    it('throws HashMismatchError and leaves no files when hash does not match', async () => {
      const body = Buffer.from('mismatch body');
      const wrongHash = sha256(Buffer.from('other content'));

      await expect(storage.put(wrongHash, body)).rejects.toThrow(HashMismatchError);

      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
    });
  });

  // ---- BlobTooLargeError via chunked Readable, no content-length -------------
  describe('BlobTooLargeError', () => {
    it('throws BlobTooLargeError via oversized chunked Readable and leaves no files', async () => {
      const smallStorage = new FilesystemStorage(dataDir, 5);
      const oversizedBuf = Buffer.from('hello world!'); // 12 bytes > 5

      // Stream it as a chunked Readable (no content-length)
      const source = Readable.from(
        (async function* () {
          yield oversizedBuf.slice(0, 4);
          yield oversizedBuf.slice(4);
        })(),
      );

      const hash = sha256(oversizedBuf);

      await expect(smallStorage.put(hash, source)).rejects.toThrow(BlobTooLargeError);

      const files = await listFiles(dataDir);
      expect(files).toHaveLength(0);
    });
  });

  // ---- get / has / size present / absent ------------------------------------
  describe('get / has / size', () => {
    it('get returns a readable stream for existing blob', async () => {
      const body = Buffer.from('readable content');
      const hash = sha256(body);
      await storage.put(hash, body);

      const stream = await storage.get(hash);
      expect(stream).not.toBeNull();
      if (!stream) throw new Error('stream is null');

      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      expect(Buffer.concat(chunks)).toEqual(body);
    });

    it('get returns null for absent blob', async () => {
      const result = await storage.get('a'.repeat(64));
      expect(result).toBeNull();
    });

    it('has returns true for existing blob', async () => {
      const body = Buffer.from('exists');
      const hash = sha256(body);
      await storage.put(hash, body);
      expect(await storage.has(hash)).toBe(true);
    });

    it('has returns false for absent blob', async () => {
      expect(await storage.has('b'.repeat(64))).toBe(false);
    });

    it('size returns byte count for existing blob', async () => {
      const body = Buffer.from('size test');
      const hash = sha256(body);
      await storage.put(hash, body);
      expect(await storage.size(hash)).toBe(body.length);
    });

    it('size returns null for absent blob', async () => {
      expect(await storage.size('c'.repeat(64))).toBeNull();
    });
  });

  // ---- InvalidHashError -----------------------------------------------------
  describe('InvalidHashError', () => {
    it('throws InvalidHashError for invalid hash', async () => {
      await expect(storage.put('not-a-hash', Buffer.from('x'))).rejects.toThrow(InvalidHashError);
    });
  });

  // ---- AC10: no delete in storage interface ---------------------------------
  describe('AC10: no delete on StoragePort', () => {
    it("'delete' is not a property of storage", () => {
      expect('delete' in storage).toBe(false);
    });
  });

  // ---- existing blob survives error paths -----------------------------------
  describe('existing blob survives error paths', () => {
    it('existing blob unchanged after HashMismatchError on re-put', async () => {
      const body = Buffer.from('original content');
      const hash = sha256(body);
      await storage.put(hash, body);

      const blobsDir = join(dataDir, 'blobs');
      const blobFilePath = join(blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);

      const { stat: statFn, readFile } = await import('node:fs/promises');
      const statBefore = await statFn(blobFilePath);
      const contentBefore = await readFile(blobFilePath);

      // Put wrong body
      await expect(storage.put(hash, Buffer.from('wrong body here'))).rejects.toThrow(
        HashMismatchError,
      );

      const statAfter = await statFn(blobFilePath);
      const contentAfter = await readFile(blobFilePath);

      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
      expect(contentAfter).toEqual(contentBefore);
    });
  });

  // ---- AC10: unlink only targets tmp/ paths ---------------------------------
  describe('AC10: unlink targets only tmp/ paths', () => {
    it('every unlink call targets a path under <dataDir>/tmp/', async () => {
      const tmpDir = join(dataDir, 'tmp');
      const unlinkCalls: string[] = [];

      vi.mock('node:fs/promises', async (orig) => {
        const original = await orig<typeof import('node:fs/promises')>();
        return {
          ...original,
          unlink: vi.fn(async (path: string) => {
            unlinkCalls.push(path);
            return original.unlink(path);
          }),
        };
      });

      // Trigger HashMismatchError to cause a tmp unlink
      const body = Buffer.from('some content');
      const wrongHash = sha256(Buffer.from('different'));

      // Use a fresh storage that picks up the mocked module
      const storageWithMock = new FilesystemStorage(dataDir, 20971520);
      await expect(storageWithMock.put(wrongHash, body)).rejects.toThrow(HashMismatchError);

      // If any unlink occurred, it must have been under tmpDir
      for (const callPath of unlinkCalls) {
        expect(callPath.startsWith(tmpDir)).toBe(true);
      }

      vi.unmock('node:fs/promises');
    });
  });
});
