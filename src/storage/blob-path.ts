import { join } from 'node:path';

/** Accepts only lowercase hex sha256 strings (exactly 64 characters). */
export const HASH_RE = /^[a-f0-9]{64}$/;

export function isValidHash(hash: string): boolean {
  return HASH_RE.test(hash);
}

/**
 * Returns the sharded path for a blob:
 *   <blobsDir>/<hash[0..1]>/<hash[2..3]>/<hash>
 */
export function blobPath(blobsDir: string, hash: string): string {
  return join(blobsDir, hash.slice(0, 2), hash.slice(2, 4), hash);
}
