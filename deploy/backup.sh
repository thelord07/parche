#!/usr/bin/env bash
# deploy/backup.sh — hot backup for parche (SQLite + blobs)
#
# Usage:
#   BACKUP_DIR=/srv/parche-backups ./deploy/backup.sh
#
# Environment variables:
#   BACKUP_DIR       — (required) absolute path to the backup root directory.
#                      Must already exist. Must not be /.
#   BACKUP_KEEP_DAYS — (optional) number of days to keep backups (default: 14).
#                      Must be a positive integer.
#
# The script must be run from the parche project directory (where
# docker-compose.yml lives) so that `docker compose` can find the service.
#
# Runs as root (the VPS is operated as root); it never writes inside ./data.
# Cron example (root crontab, daily at 03:00):
#   0 3 * * * cd /srv/parche && BACKUP_DIR=/srv/parche-backups ./deploy/backup.sh >> /var/log/parche-backup.log 2>&1

set -euo pipefail

# ---------------------------------------------------------------------------
# Validate BACKUP_DIR
# ---------------------------------------------------------------------------

: "${BACKUP_DIR:?BACKUP_DIR is required (e.g. BACKUP_DIR=/srv/parche-backups)}"

# Must be absolute
if [[ "$BACKUP_DIR" != /* ]]; then
  echo "ERROR: BACKUP_DIR must be an absolute path, got: $BACKUP_DIR" >&2
  exit 1
fi

# Must not be the filesystem root
if [[ "$BACKUP_DIR" == "/" ]]; then
  echo "ERROR: BACKUP_DIR must not be /" >&2
  exit 1
fi

# Must exist (never auto-create — accidental typos would create a wrong dir)
if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "ERROR: BACKUP_DIR does not exist: $BACKUP_DIR" >&2
  exit 1
fi

# Resolve to real absolute path (no symlinks, no relative components)
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"

# Double-check after resolution (paranoia)
if [[ "$BACKUP_DIR" == "/" ]]; then
  echo "ERROR: BACKUP_DIR resolves to / — aborting" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate BACKUP_KEEP_DAYS
# ---------------------------------------------------------------------------

BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

if ! [[ "$BACKUP_KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: BACKUP_KEEP_DAYS must be a positive integer, got: $BACKUP_KEEP_DAYS" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Prepare destination directory for today's backup
# ---------------------------------------------------------------------------

DATE="$(date -u +%Y-%m-%d)"
DEST="$BACKUP_DIR/$DATE"
mkdir -p "$DEST"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting backup → $DEST"

# ---------------------------------------------------------------------------
# 1. SQLite hot backup via the admin CLI (better-sqlite3 Online Backup API)
# ---------------------------------------------------------------------------
# The CLI runs *inside* the container so it operates in the same kernel context
# as the server process — WAL shared memory is coherent and the backup is
# a fully autonomous, consistent snapshot (no -wal / -shm files needed).

# The CLI creates /data/.backup-tmp itself, as the container user that owns
# /data. This script never creates anything under ./data, so it works when run
# as root on the host (bind-mount ownership stays with uid 1000).
TMP_NAME="parche-$(date -u +%Y%m%dT%H%M%SZ).db"
TMP_DB="/data/.backup-tmp/$TMP_NAME"
TMP_DB_HOST="./data/.backup-tmp/$TMP_NAME"

echo "  → creating DB snapshot inside container…"
docker compose exec -T parche \
  node dist/admin-cli.js backup-db "$TMP_DB"

# Move the snapshot out of the bind mount into DEST
mv "$TMP_DB_HOST" "$DEST/parche.db"

echo "  → DB backup written to $DEST/parche.db"

# ---------------------------------------------------------------------------
# 2. Blob archive (blobs are immutable/append-only → safe to tar in hot mode)
# ---------------------------------------------------------------------------

if [[ -d ./data/blobs ]]; then
  echo "  → archiving blobs…"
  # No error suppression: a tar failure (permissions, disk full) aborts the
  # script with a non-zero exit code instead of leaving a partial backup.
  tar czf "$DEST/blobs.tar.gz" -C ./data blobs
  echo "  → blob archive written to $DEST/blobs.tar.gz"
else
  echo "  → no ./data/blobs directory yet (no blob uploaded): skipping blob archive"
fi

# ---------------------------------------------------------------------------
# 3. Retention — delete dated backup directories older than BACKUP_KEEP_DAYS
# ---------------------------------------------------------------------------
# Safety: only removes directories whose names look like a date (20xx-xx-xx)
# and whose full path starts with BACKUP_DIR/ — never touches ./data.

echo "  → pruning backups older than $BACKUP_KEEP_DAYS days…"
while IFS= read -r -d '' old_dir; do
  # Paranoia: verify the path really is inside BACKUP_DIR
  if [[ "$old_dir" != "$BACKUP_DIR/"* ]]; then
    echo "  SKIP (outside BACKUP_DIR): $old_dir" >&2
    continue
  fi
  echo "  → removing old backup: $old_dir"
  rm -rf "$old_dir"
done < <(find "$BACKUP_DIR" \
  -mindepth 1 -maxdepth 1 \
  -type d \
  -name '20[0-9][0-9]-[0-1][0-9]-[0-3][0-9]' \
  -mtime +"$BACKUP_KEEP_DAYS" \
  -print0)

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Backup complete."
