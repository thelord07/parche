import type { Readable } from 'node:stream';
import type { AppDb } from '../db/client.js';
import { fileMeta } from '../db/schema.js';
import type { StoragePort } from '../storage/storage-port.js';
import { parseNote } from './parser.js';

export interface FileMetaDeps {
  db: AppDb;
  storage: StoragePort;
  log?: { warn(msg: string, obj?: unknown): void };
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Extract metadata from a blob and UPSERT into file_meta.
 * Never throws — errors are logged via deps.log.
 */
export async function updateFileMetaFromBlob(
  deps: FileMetaDeps,
  groupId: string,
  path: string,
  hash: string,
): Promise<void> {
  try {
    const stream = await deps.storage.get(hash);
    if (!stream) return;
    const content = await readStream(stream);
    const parsed = parseNote(content);

    deps.db
      .insert(fileMeta)
      .values({
        groupId,
        path,
        hash,
        title: parsed.title ?? null,
        summary: parsed.summary ?? null,
        type: parsed.type ?? null,
        tagsJson: parsed.tags.length > 0 ? JSON.stringify(parsed.tags) : null,
        workItem: parsed.workItem ?? null,
        project: parsed.project ?? null,
        conflictOf: parsed.conflictOf ?? null,
        conflictBase: parsed.conflictBase ?? null,
        linksJson: parsed.links.length > 0 ? JSON.stringify(parsed.links) : null,
      })
      .onConflictDoUpdate({
        target: [fileMeta.groupId, fileMeta.path],
        set: {
          hash,
          title: parsed.title ?? null,
          summary: parsed.summary ?? null,
          type: parsed.type ?? null,
          tagsJson: parsed.tags.length > 0 ? JSON.stringify(parsed.tags) : null,
          workItem: parsed.workItem ?? null,
          project: parsed.project ?? null,
          conflictOf: parsed.conflictOf ?? null,
          conflictBase: parsed.conflictBase ?? null,
          linksJson: parsed.links.length > 0 ? JSON.stringify(parsed.links) : null,
        },
      })
      .run();
  } catch (err) {
    deps.log?.warn('file-meta: updateFileMetaFromBlob failed', {
      groupId,
      path,
      hash,
      err: String(err),
    });
  }
}
