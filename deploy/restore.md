# Restoring a parche backup

This document explains how to restore a backup created by `deploy/backup.sh`.
Follow every step in order. Steps marked **[requires human confirmation]** will
permanently overwrite or discard live data — verify and confirm before running them.

---

## What a backup contains

```
$BACKUP_DIR/<date>/
  parche.db       — SQLite backup (autonomous file, no -wal / -shm needed)
  blobs.tar.gz    — archive of the blobs/ directory
```

---

## Restore procedure

### 1. Stop the server

```bash
docker compose down
```

`down` without `-v` is safe: the bind-mount `./data` is on the host filesystem
and is NOT removed. **Never run `docker compose down -v`** — that would remove
named volumes (not applicable here, but a good habit to enforce).

---

### 2. Preserve the current data directory (non-destructive)

**[requires human confirmation]**

Rename the live data directory instead of deleting it. This gives you a rollback
path if the restore goes wrong.

```bash
mv ./data ./data.bak
```

If `./data.bak` already exists from a previous attempt:

```bash
mv ./data ./data.bak.$(date +%s)
```

---

### 3. Create a fresh data directory

```bash
# uid/gid 1000 matches the `node` user inside the container
install -d -o 1000 -g 1000 ./data
```

---

### 4. Restore the database

```bash
cp /path/to/backup/<date>/parche.db ./data/parche.db
# Ownership — the container user must be able to write to it
chown 1000:1000 ./data/parche.db
```

Make sure there are **no stale WAL files** from the old database:

```bash
rm -f ./data/parche.db-wal ./data/parche.db-shm
```

---

### 5. Restore the blobs

```bash
tar xzf /path/to/backup/<date>/blobs.tar.gz -C ./data
# Fix ownership so the container can write new blobs
chown -R 1000:1000 ./data/blobs
```

---

### 6. Fix permissions on the whole data directory

```bash
chown -R 1000:1000 ./data
```

---

### 7. Start the server

```bash
docker compose up -d
```

---

### 8. Verify

```bash
# Health check
curl http://127.0.0.1:8787/health

# List members of a group to confirm data is intact
docker compose exec parche node dist/admin-cli.js list-members --group <slug>
```

---

## Notes

- **Rolling back:** if the restored data is wrong, stop the server (`docker compose down`),
  remove `./data`, and rename `./data.bak` back to `./data` before restarting.

- **Do not restore onto a running server.** Always stop the server first (step 1)
  to avoid WAL corruption from concurrent writes.

- **blobs.tar.gz is optional:** if you only need to restore the database (e.g., to
  recover from a logic error), you can skip step 5. The server will serve 404 for
  any blob whose file is missing, but it will not crash.

- **The backup is always complete.** `backup.sh` produces a fully autonomous SQLite
  file (no `-wal`/`-shm` required) via the Online Backup API. You can verify it
  independently:
  ```bash
  sqlite3 /path/to/backup/<date>/parche.db "PRAGMA integrity_check"
  # expected output: ok
  ```
