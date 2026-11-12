#!/bin/bash
# Runs once when the PostgreSQL data volume is first created.
# - POSTGRES_USER (saf_owner) owns the schema and runs migrations.
# - saf_app is the runtime role: NOT superuser and NOT BYPASSRLS, so
#   Row-Level Security policies apply to every query the application makes.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
      CREATE ROLE saf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${SAF_APP_PASSWORD}';
    END IF;
  END
  \$\$;
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO saf_app;
  GRANT USAGE ON SCHEMA public TO saf_app;
  CREATE DATABASE saf_test OWNER "$POSTGRES_USER";
  GRANT CONNECT ON DATABASE saf_test TO saf_app;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname saf_test <<-EOSQL
  GRANT USAGE ON SCHEMA public TO saf_app;
EOSQL
