import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as pipelineCallback, Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { blobPath, isValidHash } from './blob-path.js';
import {
  BlobTooLargeError,
  HashMismatchError,
  InvalidHashError,
  type PutResult,
  type StoragePort,
} from './storage-port.js';

const pipeline = promisify(pipelineCallback);

export class FilesystemStorage implements StoragePort {
  private readonly blobsDir: string;
  private readonly tmpDir: string;
  private readonly maxBytes: number;

  constructor(dataDir: string, maxBytes: number) {
    this.blobsDir = join(dataDir, 'blobs');
    this.tmpDir = join(dataDir, 'tmp');
    this.maxBytes = maxBytes;
  }

  async put(hash: string, source: Readable | Buffer): Promise<PutResult> {
    if (!isValidHash(hash)) {
      throw new InvalidHashError(hash);
    }

    // Normalize Buffer → Readable
    const readable: Readable = Buffer.isBuffer(source) ? Readable.from(source) : source;

    const existingSize = await this.size(hash);

    if (existingSize !== null) {
      // Blob already exists: verify body against the stored hash without writing to disk.
      await this._verifyStream(readable, hash);
      return { created: false, size: existingSize };
    }

    // New blob: stream to a temp file, verify digest, then hard-link into place atomically.
    await mkdir(this.tmpDir, { recursive: true });
    const tmpPath = join(this.tmpDir, `${hash}.${process.pid}.${randomUUID()}.tmp`);

    let bytesWritten = 0;
    let digest = '';

    try {
      const hasher = createHash('sha256');
      const maxBytesRef = this.maxBytes;
      const fileStream = createWriteStream(tmpPath);
      let accumulated = 0;

      await pipeline(
        readable,
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            accumulated += chunk.length;
            if (accumulated > maxBytesRef) {
              cb(new BlobTooLargeError(maxBytesRef));
              return;
            }
            hasher.update(chunk);
            fileStream.write(chunk, cb);
          },
          final(cb) {
            fileStream.end(cb);
          },
        }),
      );

      digest = hasher.digest('hex');
      bytesWritten = accumulated;
    } catch (err) {
      // Clean up own temp file on any error via the single allowed removal.
      await cleanupTmp(tmpPath);
      throw err;
    }

    if (digest !== hash) {
      // Digest mismatch — clean up own temp file via the single allowed removal.
      await cleanupTmp(tmpPath);
      throw new HashMismatchError(hash);
    }

    // Ensure shard directory exists, then hard-link temp into place atomically.
    // link() throws EEXIST if the destination already exists (unlike rename which
    // would silently overwrite), so exactly one concurrent winner gets created:true
    // and the rest get created:false.
    const dest = blobPath(this.blobsDir, hash);
    const shardDir = join(this.blobsDir, hash.slice(0, 2), hash.slice(2, 4));
    await mkdir(shardDir, { recursive: true });

    try {
      await link(tmpPath, dest);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        // Race: another process stored the same blob concurrently.
        // Clean up own temp file — the stored blob is unaffected.
        await cleanupTmp(tmpPath);
        return { created: false, size: bytesWritten };
      }
      await cleanupTmp(tmpPath);
      throw err;
    }

    // Hard link created: remove the tmp file (it is now an extra link to the blob inode).
    await cleanupTmp(tmpPath);
    return { created: true, size: bytesWritten };
  }

  async get(hash: string): Promise<Readable | null> {
    const p = blobPath(this.blobsDir, hash);
    try {
      await stat(p);
      return createReadStream(p);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      throw err;
    }
  }

  async has(hash: string): Promise<boolean> {
    return (await this.size(hash)) !== null;
  }

  async size(hash: string): Promise<number | null> {
    const p = blobPath(this.blobsDir, hash);
    try {
      const s = await stat(p);
      return s.size;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Consume a readable stream and verify its sha256 equals `hash` without writing to disk.
   * Enforces maxBytes — throws BlobTooLargeError if the body is too large.
   * Throws HashMismatchError if the digest does not match.
   */
  private async _verifyStream(source: Readable, hash: string): Promise<void> {
    const maxBytesRef = this.maxBytes;
    const hasher = createHash('sha256');
    let accumulated = 0;

    await pipeline(
      source,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          accumulated += chunk.length;
          if (accumulated > maxBytesRef) {
            cb(new BlobTooLargeError(maxBytesRef));
            return;
          }
          hasher.update(chunk);
          cb();
        },
      }),
    );

    const digest = hasher.digest('hex');
    if (digest !== hash) {
      throw new HashMismatchError(hash);
    }
  }
}

/**
 * Remove own temp file — the single removal in this module.
 * Never touches blob storage paths (under `blobs/`).
 * Swallows ENOENT so double-cleanup is safe.
 */
async function cleanupTmp(tmpPath: string): Promise<void> {
  try {
    await unlink(tmpPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
}
