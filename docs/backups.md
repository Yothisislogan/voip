# Postgres backups

The CRM data (contacts, calls, transcripts, scores, surveys, email intake) lives
in Postgres. Back it up on a schedule.

## Take a backup

```bash
# Docker-compose deployment (dumps the db service):
./scripts/backup.sh

# Or against any DATABASE_URL:
DATABASE_URL=postgresql://user:pass@host:5432/wit ./scripts/backup.sh /var/backups/wit
```

Writes a gzipped, timestamped dump (`wit_YYYYmmdd_HHMMSS.sql.gz`) to the output
directory and keeps the newest `BACKUP_KEEP` (default 14).

## Schedule it (cron)

```cron
# Daily at 02:30, keep 30 days, into /var/backups/wit
30 2 * * * cd /opt/wit-connect && BACKUP_KEEP=30 ./scripts/backup.sh /var/backups/wit >> /var/log/wit-backup.log 2>&1
```

For durability, sync `/var/backups/wit` off-box (e.g. `rclone` to object storage,
or Hetzner Storage Box). A backup on the same server does not survive disk loss.

## Restore

```bash
# Docker-compose:
gunzip -c backups/wit_YYYYmmdd_HHMMSS.sql.gz | docker compose exec -T db psql -U wit -d wit

# Or against a DATABASE_URL:
gunzip -c wit_YYYYmmdd_HHMMSS.sql.gz | psql "$DATABASE_URL"
```

Restoring into a fresh database also recreates the schema (the dump is a full
`pg_dump`). After restoring, re-run `npm run migrate` — it's idempotent and will
apply any migrations newer than the dump.

## Verify the round trip (automated)

An untested backup is not a backup. `npm run restore-test` proves the whole
cycle without touching your live data:

```bash
DATABASE_URL=postgresql://user:pass@host:5432/wit npm run restore-test
```

It dumps the live DB, restores it into a throwaway scratch database, compares
the table set and per-table row counts (source vs restore), confirms migrations
report "up to date" on the restore (no schema drift), then drops the scratch
database. Exits non-zero on any mismatch, so it can gate a deploy or run on a
schedule. Requires `pg_dump`/`psql`/`createdb`/`dropdb` on PATH and permission
to `CREATE DATABASE` on the server.

## Notes

- Run `npm run restore-test` periodically (e.g. weekly) — an untested backup is
  not a backup.
- The dump contains customer PII. Encrypt at rest and restrict access
  (see `docs/secure-ai-architecture.md`).
