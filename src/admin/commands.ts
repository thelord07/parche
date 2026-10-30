import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { roleSchema } from '@chamba/core';
import { and, eq, isNull } from 'drizzle-orm';
import {
  generateDeviceToken,
  generateInviteCode,
  hashInviteCode,
  hashToken,
  parseExpiry,
} from '../auth/tokens.js';
import type { AppDb, RawDb } from '../db/client.js';
import { devices, groups, invites, members, users } from '../db/schema.js';
import { newId } from '../ids.js';

// ---------------------------------------------------------------------------
// Invite roles: a subset of the full role set (owner is never assignable)
// ---------------------------------------------------------------------------

export const INVITE_ROLES = ['admin', 'editor', 'reader'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

function isInviteRole(value: string): value is InviteRole {
  // Validate against core's roleSchema first, then check it's not owner
  const parsed = roleSchema.safeParse(value);
  return parsed.success && value !== 'owner';
}

// ---------------------------------------------------------------------------
// create-group
// ---------------------------------------------------------------------------

export interface CreateGroupOptions {
  name: string;
  slug: string;
  ownerName: string;
  ownerEmail: string;
  deviceLabel?: string;
}

export interface CreateGroupResult {
  groupId: string;
  userId: string;
  deviceId: string;
  /** Plain-text device token — print once to stdout, never store. */
  deviceToken: string;
}

/**
 * Create a group, owner user (or reuse by email), owner member, and owner device.
 * Runs in a single transaction. Returns the plain-text token (print once).
 */
export function createGroup(db: AppDb, options: CreateGroupOptions): CreateGroupResult {
  const { name, slug, ownerName, ownerEmail, deviceLabel = 'owner' } = options;
  const now = new Date().toISOString();
  const groupId = newId();
  const deviceId = newId();
  const deviceToken = generateDeviceToken();
  const tokenHash = hashToken(deviceToken);

  let userId = '';

  db.transaction((tx) => {
    // Reuse existing user by email, or create a new one
    const existing = tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ownerEmail))
      .get();
    if (existing) {
      userId = existing.id;
    } else {
      userId = newId();
      tx.insert(users)
        .values({ id: userId, name: ownerName, email: ownerEmail, createdAt: now })
        .run();
    }

    tx.insert(groups).values({ id: groupId, slug, name, createdAt: now }).run();
    tx.insert(members).values({ groupId, userId, role: 'owner', createdAt: now }).run();
    tx.insert(devices)
      .values({ id: deviceId, userId, groupId, label: deviceLabel, tokenHash, createdAt: now })
      .run();
  });

  return { groupId, userId, deviceId, deviceToken };
}

// ---------------------------------------------------------------------------
// create-group-for-user (web API — no device, user already exists)
// ---------------------------------------------------------------------------

export interface CreateGroupForUserOptions {
  name: string;
  slug: string;
  userId: string;
}

export interface CreateGroupForUserResult {
  groupId: string;
}

/**
 * Create a group and make the given user its owner.
 * Unlike createGroup, no device is created (the user is authenticated via the web session).
 * Runs in a single transaction.
 */
export function createGroupForUser(
  db: AppDb,
  options: CreateGroupForUserOptions,
): CreateGroupForUserResult {
  const { name, slug, userId } = options;
  const now = new Date().toISOString();
  const groupId = newId();

  db.transaction((tx) => {
    tx.insert(groups).values({ id: groupId, slug, name, createdAt: now }).run();
    tx.insert(members).values({ groupId, userId, role: 'owner', createdAt: now }).run();
  });

  return { groupId };
}

// ---------------------------------------------------------------------------
// create-invite
// ---------------------------------------------------------------------------

export interface CreateInviteOptions {
  /** Group slug */
  group: string;
  role: InviteRole;
  expires?: '24h' | '7d' | 'never';
  maxUses?: number;
}

export interface CreateInviteResult {
  inviteId: string;
  /** Plain-text invite code — print once to stdout, never store. */
  inviteCode: string;
}

/**
 * Create an invite for an existing group. Role must be admin|editor|reader (never owner).
 * Returns the plain-text code (print once).
 */
export function createInvite(db: AppDb, options: CreateInviteOptions): CreateInviteResult {
  const { group: slug, role, expires = 'never', maxUses } = options;

  if (!isInviteRole(role)) {
    throw new Error(`Invalid role '${role}'. Must be one of: ${INVITE_ROLES.join(', ')}`);
  }

  const now = new Date().toISOString();

  const grp = db.select({ id: groups.id }).from(groups).where(eq(groups.slug, slug)).get();
  if (!grp) {
    throw new Error(`Group '${slug}' not found`);
  }

  // Invites need a created_by user. Use the first active owner.
  const owner = db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.groupId, grp.id), eq(members.role, 'owner'), isNull(members.removedAt)))
    .get();
  if (!owner) {
    throw new Error(`Group '${slug}' has no active owner`);
  }

  const inviteId = newId();
  const inviteCode = generateInviteCode();
  const codeHash = hashInviteCode(inviteCode);
  const expiresAt = parseExpiry(expires);

  db.insert(invites)
    .values({
      id: inviteId,
      groupId: grp.id,
      codeHash,
      role,
      createdBy: owner.userId,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      maxUses: maxUses ?? null,
      uses: 0,
      createdAt: now,
    })
    .run();

  return { inviteId, inviteCode };
}

// ---------------------------------------------------------------------------
// list-members
// ---------------------------------------------------------------------------

export interface MemberEntry {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

/**
 * List active members (removed_at IS NULL) for a group.
 */
export function listMembers(db: AppDb, options: { group: string }): MemberEntry[] {
  const grp = db.select({ id: groups.id }).from(groups).where(eq(groups.slug, options.group)).get();
  if (!grp) {
    throw new Error(`Group '${options.group}' not found`);
  }

  const rows = db
    .select({
      userId: members.userId,
      name: users.name,
      email: users.email,
      role: members.role,
      createdAt: members.createdAt,
    })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.groupId, grp.id), isNull(members.removedAt)))
    .all();

  return rows;
}

// ---------------------------------------------------------------------------
// revoke-device
// ---------------------------------------------------------------------------

/**
 * Revoke a device by id — sets revoked_at, never deletes.
 */
export function revokeDevice(db: AppDb, options: { deviceId: string }): void {
  const now = new Date().toISOString();
  const result = db
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.id, options.deviceId), isNull(devices.revokedAt)))
    .run();

  if (result.changes === 0) {
    throw new Error(`Device '${options.deviceId}' not found or already revoked`);
  }
}

// ---------------------------------------------------------------------------
// revoke-invite
// ---------------------------------------------------------------------------

/**
 * Revoke an invite by group slug + plain-text code — sets revoked_at, never deletes.
 */
export function revokeInvite(db: AppDb, options: { group: string; code: string }): void {
  const now = new Date().toISOString();
  const codeHash = hashInviteCode(options.code);

  const grp = db.select({ id: groups.id }).from(groups).where(eq(groups.slug, options.group)).get();
  if (!grp) {
    throw new Error(`Group '${options.group}' not found`);
  }

  const result = db
    .update(invites)
    .set({ revokedAt: now })
    .where(
      and(eq(invites.groupId, grp.id), eq(invites.codeHash, codeHash), isNull(invites.revokedAt)),
    )
    .run();

  if (result.changes === 0) {
    throw new Error(`Invite not found or already revoked`);
  }
}

// ---------------------------------------------------------------------------
// create-device (gate decision: replaces the join flow for existing members)
// ---------------------------------------------------------------------------

export interface CreateDeviceOptions {
  /** Group slug */
  group: string;
  /** Email of the active member to create a device for */
  email: string;
  label?: string;
}

export interface CreateDeviceResult {
  deviceId: string;
  /** Plain-text device token — print once to stdout, never store. */
  deviceToken: string;
}

/**
 * Create a new device for an existing active member of the group.
 * Throws if the member is not found or is not active.
 */
export function createDevice(db: AppDb, options: CreateDeviceOptions): CreateDeviceResult {
  const { group: slug, email, label = 'device' } = options;
  const now = new Date().toISOString();

  const grp = db.select({ id: groups.id }).from(groups).where(eq(groups.slug, slug)).get();
  if (!grp) {
    throw new Error(`Group '${slug}' not found`);
  }

  const user = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (!user) {
    throw new Error(`User with email '${email}' not found`);
  }

  const member = db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.groupId, grp.id), eq(members.userId, user.id), isNull(members.removedAt)))
    .get();

  if (!member) {
    throw new Error(`'${email}' is not an active member of group '${slug}'`);
  }

  const deviceId = newId();
  const deviceToken = generateDeviceToken();
  const tokenHash = hashToken(deviceToken);

  db.insert(devices)
    .values({ id: deviceId, userId: user.id, groupId: grp.id, label, tokenHash, createdAt: now })
    .run();

  return { deviceId, deviceToken };
}

// ---------------------------------------------------------------------------
// backup-db
// ---------------------------------------------------------------------------

/**
 * Create an online backup of the SQLite database using better-sqlite3's
 * `db.backup(dest)` API (SQLite Online Backup API). The backup is a
 * complete, autonomous database file — no WAL or SHM files needed.
 *
 * @param rawDb - The raw better-sqlite3 Database instance (not the drizzle wrapper).
 * @param dest  - Absolute or relative path for the output backup file. Its parent
 *                directory is created if missing, by the process that runs the
 *                backup — inside Docker that is the container user, which owns /data,
 *                so `deploy/backup.sh` never has to create anything under ./data.
 */
export async function backupDb(rawDb: RawDb, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await rawDb.backup(dest);
}
