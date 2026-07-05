#!/usr/bin/env bash
# Postgres backup for WIT Connect — timestamped, gzipped, with retention.
#
#   ./scripts/backup.sh [output_dir]
#
# Uses DATABASE_URL if set; otherwise dumps from the docker-compose `db` service.
# Retention: keeps the newest $BACKUP_KEEP dumps (default 14).
set -euo pipefail

OUT_DIR="${1:-./backups}"
KEEP="${BACKUP_KEEP:-14}"
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
FILE="$OUT_DIR/wit_${TS}.sql.gz"

if [ -n "${DATABASE_URL:-}" ]; then
  pg_dump "$DATABASE_URL" | gzip > "$FILE"
else
  docker compose exec -T db pg_dump -U "${POSTGRES_USER:-wit}" "${POSTGRES_DB:-wit}" | gzip > "$FILE"
fi

# Prune old backups beyond the retention count.
ls -1t "$OUT_DIR"/wit_*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "backup written: $FILE ($(du -h "$FILE" | cut -f1))"
