import { createHash } from 'node:crypto';
import type { HashPort } from '@chamba/core';

/**
 * `HashPort` implementation backed by `node:crypto`. parche does not depend on
 * `@chamba/adapters`, so this mirrors `node-hash.ts` there in a few lines.
 * Module-level singleton — reused everywhere the scanner needs a `HashPort`.
 */
class NodeHash implements HashPort {
  sha256(data: Uint8Array): Promise<string> {
    return Promise.resolve(createHash('sha256').update(data).digest('hex'));
  }
}

export const nodeHash = new NodeHash();
