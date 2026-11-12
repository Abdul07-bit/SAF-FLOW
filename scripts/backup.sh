#!/usr/bin/env bash
# SMARTAUTO FLEX backup: PostgreSQL dump + uploaded files (MinIO bucket).
#
#   ./scripts/backup.sh                 # writes to ./backups
#   BACKUP_DIR=/mnt/backups KEEP_DAYS=30 ./scripts/backup.sh
#
# Run from the project directory on the Docker host, e.g. nightly from cron:
#   15 2 * * *  cd /opt/saf && ./scripts/backup.sh >> /var/log/saf-backup.log 2>&1
#
# Copy the resulting files off the server (object storage, another machine).
# A backup that lives only on the same disk is not a backup.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "[$(date -Is)] database dump"
# Custom format: compressed, restorable selectively with pg_restore.
docker compose exec -T postgres pg_dump -U saf_owner -d saf --format=custom --no-owner \
  > "$BACKUP_DIR/saf-db-$STAMP.dump.partial"

# Fail loudly on an empty dump instead of rotating good backups away.
if [ ! -s "$BACKUP_DIR/saf-db-$STAMP.dump.partial" ]; then
  rm -f "$BACKUP_DIR/saf-db-$STAMP.dump.partial"
  echo "ERROR: database dump is empty" >&2
  exit 1
fi
mv "$BACKUP_DIR/saf-db-$STAMP.dump.partial" "$BACKUP_DIR/saf-db-$STAMP.dump"

echo "[$(date -Is)] uploaded files"
# Archive the whole MinIO data volume through a throwaway container, so this
# does not depend on which tools the MinIO image ships.
MINIO_ID="$(docker compose ps -aq minio 2>/dev/null || true)"
if [ -n "$MINIO_ID" ]; then
  docker run --rm --volumes-from "$MINIO_ID" alpine:3.20 tar -C /data -czf - . > "$BACKUP_DIR/saf-files-$STAMP.tar.gz.partial"
  mv "$BACKUP_DIR/saf-files-$STAMP.tar.gz.partial" "$BACKUP_DIR/saf-files-$STAMP.tar.gz"
else
  echo "  no MinIO container (external S3 in use?) - back up that bucket with your provider's tools"
fi

find "$BACKUP_DIR" -name 'saf-db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'saf-files-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "[$(date -Is)] done: backup $STAMP written to $BACKUP_DIR"
