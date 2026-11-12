#!/usr/bin/env bash
# Restores a database dump made by scripts/backup.sh. DESTRUCTIVE: replaces
# every table in the target database.
#
#   ./scripts/restore.sh backups/saf-db-20261110-021500.dump saf_verify   # scratch database (safe)
#   ./scripts/restore.sh backups/saf-db-20261110-021500.dump              # the live "saf" database
#
# Restore into a scratch database first to verify a backup. Restoring into
# "saf" asks for confirmation and needs the app stopped:
#   docker compose --profile app stop app cron
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump file> [database]}"
DB="${2:-saf}"
[ -s "$DUMP" ] || { echo "Dump file not found or empty: $DUMP" >&2; exit 1; }
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Invalid database name: $DB" >&2; exit 1; }

if [ "$DB" = "saf" ]; then
  read -r -p "This REPLACES the live database 'saf'. Type RESTORE to continue: " answer
  [ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
else
  docker compose exec -T postgres psql -U saf_owner -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$DB\"" -c "CREATE DATABASE \"$DB\" OWNER saf_owner"
fi

docker compose exec -T postgres pg_restore -U saf_owner -d "$DB" --clean --if-exists --no-owner --exit-on-error < "$DUMP"

# The dump carries the table grants of the application role (including the
# append-only audit log), so nothing is re-granted here - a blanket GRANT would
# hand saf_app DELETE on audit_logs. Only schema access is not part of the dump.
docker compose exec -T postgres psql -U saf_owner -d "$DB" -v ON_ERROR_STOP=1 \
  -c "GRANT USAGE ON SCHEMA public TO saf_app" \
  -c "SELECT count(*) AS tenants, has_table_privilege('saf_app', 'tenants', 'SELECT') AS app_can_read, has_table_privilege('saf_app', 'audit_logs', 'DELETE') AS audit_deletable FROM tenants"
# Expected: app_can_read = t, audit_deletable = f.

echo "Restored $DUMP into database '$DB'."
