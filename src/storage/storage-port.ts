import type { Readable } from 'node:stream';

export interface PutResult {
  /** true when the blob was newly stored, false when it already existed. */
  created: boolean;
  /** Byte size of the blob. */
  size: number;
}

/**
 * Content-addressed blob storage.
 * parche never removes blobs — there is no remove/erase operation on this interface.
 */
export interface StoragePort {
  /**
   * Store a blob.
   * - Always verifies that the sha256 of the body matches `hash`.
   * - If the blob already exists: verifies hash without writing to disk.
   * - Throws InvalidHashError when hash is not a valid sha256 hex string.
   * - Throws HashMismatchError when the body's digest does not match hash.
   * - Throws BlobTooLargeError when the body exceeds the configured maximum.
   */
  put(hash: string, source: Readable | Buffer): Promise<PutResult>;

  /**
   * Retrieve a blob as a readable stream, or null if it does not exist.
   */
  get(hash: string): Promise<Readable | null>;

  /**
   * Check whether a blob exists.
   */
  has(hash: string): Promise<boolean>;

  /**
   * Return the byte size of a blob, or null if it does not exist.
   */
  size(hash: string): Promise<number | null>;
}

export class InvalidHashError extends Error {
  override name = 'InvalidHashError';
  constructor(hash: string) {
    super(`invalid hash: ${hash}`);
  }
}

export class HashMismatchError extends Error {
  override name = 'HashMismatchError';
  constructor(hash: string) {
    super(`hash mismatch for: ${hash}`);
  }
}

export class BlobTooLargeError extends Error {
  override name = 'BlobTooLargeError';
  constructor(maxBytes: number) {
    super(`blob exceeds maximum size of ${maxBytes} bytes`);
  }
}
