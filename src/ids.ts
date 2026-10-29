import { randomUUID } from 'node:crypto';

/**
 * Generate a new UUID v4 string for use as a primary key.
 */
export function newId(): string {
  return randomUUID();
}
