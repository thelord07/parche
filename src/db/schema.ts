import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  seqCounter: integer('seq_counter').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: text('email_verified_at'),
  createdAt: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// members — PK (group_id, user_id)
// Partial unique index enforces a single live owner per group.
// ---------------------------------------------------------------------------

export const members = sqliteTable(
  'members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    createdAt: text('created_at').notNull(),
    removedAt: text('removed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    // One live owner per group: UNIQUE(group_id) WHERE role = 'owner' AND removed_at IS NULL
    uniqueIndex('members_one_owner_idx')
      .on(t.groupId)
      .where(sql`${t.role} = 'owner' AND ${t.removedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// devices — only token_hash is stored, never the plain token
// ---------------------------------------------------------------------------

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
});

// ---------------------------------------------------------------------------
// invites — only code_hash is stored, never the plain code
// code_hint: first 4 chars of the plain code for display (XXXX-••••)
// ---------------------------------------------------------------------------

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  groupId: text('group_id')
    .notNull()
    .references(() => groups.id),
  codeHash: text('code_hash').notNull().unique(),
  codeHint: text('code_hint'),
  role: text('role').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  expiresAt: text('expires_at'),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// files — PK (group_id, path); head_hash NULL = tombstone
// head_seq >= 1: every file row is created by an actual push entry
// ---------------------------------------------------------------------------

export const files = sqliteTable(
  'files',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    path: text('path').notNull(),
    pathKey: text('path_key').notNull(),
    headHash: text('head_hash'),
    headSeq: integer('head_seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.path] }),
    index('files_group_path_key_idx').on(t.groupId, t.pathKey),
    check('files_head_seq_check', sql`${t.headSeq} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// changes — append-only; PK (group_id, seq); seq >= 1
// ---------------------------------------------------------------------------

export const changes = sqliteTable(
  'changes',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    seq: integer('seq').notNull(),
    path: text('path').notNull(),
    hash: text('hash'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id),
    at: text('at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.seq] }),
    check('changes_seq_check', sql`${t.seq} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// sessions — web session (cookie parche_session); only token_hash stored
// ---------------------------------------------------------------------------

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  lastSeenAt: text('last_seen_at'),
});

// ---------------------------------------------------------------------------
// magic_links — single-use auth tokens; only token_hash stored
// ---------------------------------------------------------------------------

export const magicLinks = sqliteTable('magic_links', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  ip: text('ip'),
});

// ---------------------------------------------------------------------------
// blob_refs — tracks which group uploaded/uses each blob hash
// ---------------------------------------------------------------------------

export const blobRefs = sqliteTable(
  'blob_refs',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id),
    hash: text('hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.hash] })],
);
