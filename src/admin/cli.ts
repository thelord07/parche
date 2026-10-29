/**
 * parche admin CLI
 *
 * Usage (dev):  pnpm admin <command> [options]
 * Usage (prod): node dist/admin-cli.js <command> [options]
 *
 * Commands:
 *   create-group    --name --slug --owner-name --owner-email [--device-label]
 *   create-invite   --group --role <admin|editor|reader> [--expires 24h|7d|never] [--max-uses N]
 *   list-members    --group
 *   revoke-device   --device <id>
 *   revoke-invite   --group --code
 *   create-device   --group --email [--label]
 *   backup-db       <dest>
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  backupDb,
  createDevice,
  createGroup,
  createInvite,
  listMembers,
  revokeDevice,
  revokeInvite,
} from './commands.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command) {
    process.stderr.write(
      'Usage: parche-admin <command> [options]\n' +
        'Commands: create-group, create-invite, list-members, revoke-device, revoke-invite, create-device, backup-db\n',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const { db, raw } = await openDb(config.dataDir);
  runMigrations(raw);

  try {
    switch (command) {
      case 'create-group': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: {
            name: { type: 'string' },
            slug: { type: 'string' },
            'owner-name': { type: 'string' },
            'owner-email': { type: 'string' },
            'device-label': { type: 'string' },
          },
        });
        const name = requireString(values, 'name');
        const slug = requireString(values, 'slug');
        const ownerName = requireString(values, 'owner-name');
        const ownerEmail = requireString(values, 'owner-email');
        const deviceLabel =
          typeof values['device-label'] === 'string' ? values['device-label'] : undefined;

        const result = createGroup(db, { name, slug, ownerName, ownerEmail, deviceLabel });
        process.stdout.write(
          `${JSON.stringify({
            groupId: result.groupId,
            userId: result.userId,
            deviceId: result.deviceId,
            deviceToken: result.deviceToken,
          })}\n`,
        );
        break;
      }

      case 'create-invite': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: {
            group: { type: 'string' },
            role: { type: 'string' },
            expires: { type: 'string' },
            'max-uses': { type: 'string' },
          },
        });
        const group = requireString(values, 'group');
        const roleRaw = requireString(values, 'role');

        if (!['admin', 'editor', 'reader'].includes(roleRaw)) {
          throw new Error(`Invalid role '${roleRaw}'. Must be admin, editor, or reader.`);
        }
        const role = roleRaw as 'admin' | 'editor' | 'reader';

        const expiresRaw = typeof values.expires === 'string' ? values.expires : 'never';
        if (!['24h', '7d', 'never'].includes(expiresRaw)) {
          throw new Error(`Invalid --expires value '${expiresRaw}'. Must be 24h, 7d, or never.`);
        }
        const expires = expiresRaw as '24h' | '7d' | 'never';

        const maxUsesRaw = typeof values['max-uses'] === 'string' ? values['max-uses'] : undefined;
        const maxUses = maxUsesRaw !== undefined ? parseInt(maxUsesRaw, 10) : undefined;
        if (maxUses !== undefined && (Number.isNaN(maxUses) || maxUses < 1)) {
          throw new Error('--max-uses must be a positive integer');
        }

        const result = createInvite(db, { group, role, expires, maxUses });
        process.stdout.write(
          `${JSON.stringify({ inviteId: result.inviteId, inviteCode: result.inviteCode })}\n`,
        );
        break;
      }

      case 'list-members': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: { group: { type: 'string' } },
        });
        const group = requireString(values, 'group');
        const rows = listMembers(db, { group });
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        break;
      }

      case 'revoke-device': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: { device: { type: 'string' } },
        });
        const deviceId = requireString(values, 'device');
        revokeDevice(db, { deviceId });
        process.stdout.write(`${JSON.stringify({ ok: true, deviceId })}\n`);
        break;
      }

      case 'revoke-invite': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: {
            group: { type: 'string' },
            code: { type: 'string' },
          },
        });
        const group = requireString(values, 'group');
        const code = requireString(values, 'code');
        revokeInvite(db, { group, code });
        process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
        break;
      }

      case 'create-device': {
        const { values } = parseArgs({
          args: process.argv.slice(3),
          options: {
            group: { type: 'string' },
            email: { type: 'string' },
            label: { type: 'string' },
          },
        });
        const group = requireString(values, 'group');
        const email = requireString(values, 'email');
        const label = typeof values.label === 'string' ? values.label : undefined;

        const result = createDevice(db, { group, email, label });
        process.stdout.write(
          `${JSON.stringify({ deviceId: result.deviceId, deviceToken: result.deviceToken })}\n`,
        );
        break;
      }

      case 'backup-db': {
        const dest = process.argv[3];
        if (!dest || dest.trim() === '') {
          throw new Error(
            'Usage: backup-db <dest>\n  <dest> must be a non-empty path for the output .db file',
          );
        }
        await backupDb(raw, dest);
        process.stdout.write(`${JSON.stringify({ ok: true, dest })}\n`);
        break;
      }

      default: {
        throw new Error(
          `Unknown command '${command}'. ` +
            'Available: create-group, create-invite, list-members, revoke-device, revoke-invite, create-device, backup-db',
        );
      }
    }
  } finally {
    raw.close();
  }
}

function requireString(
  values: Record<string, string | boolean | string[] | boolean[] | undefined>,
  key: string,
): string {
  const val = values[key];
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(`--${key} is required and must be a non-empty string`);
  }
  return val;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
