-- ===========================================================================
-- SAF Flow security hardening (see SECURITY_AUDIT_REPORT.md)
--
--  SEC-04  Global catalog tables writable from a tenant scope -> RLS.
--  SEC-05  Foreign keys are checked without RLS, so a tenant row could point
--          at another tenant's record -> same-tenant reference trigger.
--  SEC-11  Audit trail immutable for every role, not only saf_app.
--  SEC-01  TOTP multi-factor authentication and step-up columns.
--
-- Backward compatible: only adds columns (with defaults), policies and
-- triggers. No data is changed or removed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SEC-01: multi-factor authentication
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN "mfa_secret_enc" TEXT,
  ADD COLUMN "mfa_enabled_at" TIMESTAMP(3),
  ADD COLUMN "mfa_recovery_hashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "sessions"
  ADD COLUMN "mfa_pending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfa_failures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mfa_verified_at" TIMESTAMP(3),
  ADD COLUMN "step_up_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- SEC-04: global catalog tables. Everyone may read them (sessions resolve
-- roles, plans and features in every scope); only platform scopes (Super
-- Admin bypass, or a SAF Team member's staff scope) may change them. A bug in
-- a tenant route can no longer rewrite roles, prices or plan features.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'products', 'plans', 'plan_features', 'feature_catalog',
    'roles', 'role_permissions', 'permissions', 'platform_settings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY catalog_read ON %I FOR SELECT USING (true)', t);
    EXECUTE format(
      'CREATE POLICY catalog_write ON %I FOR ALL '
      'USING (saf_rls_bypass() OR saf_staff_user() IS NOT NULL) '
      'WITH CHECK (saf_rls_bypass() OR saf_staff_user() IS NOT NULL)', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- SEC-05: same-tenant references.
--
-- PostgreSQL validates foreign keys without applying RLS, so an INSERT in
-- tenant A's scope could reference a row of tenant B if its UUID were known.
-- This trigger rejects that. The parent lookup runs with the bypass flag set
-- briefly (and restored) so platform-level parents (users with tenant_id NULL,
-- e.g. a SAF Team member on staff_assignments) are recognised as such.
--
-- Rule, for every single-column FK from a table with tenant_id to a table
-- with tenant_id:   parent.tenant_id IS NULL  OR  child.tenant_id IS NULL
--                   OR parent.tenant_id = child.tenant_id
-- Implemented as a trigger (not composite FKs) so Prisma never tries to
-- drop it as schema drift.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saf_check_tenant_refs() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  child_tenant uuid := NEW.tenant_id;
  doc jsonb;
  i int;
  col text;
  parent text;
  ref_value text;
  parent_tenant uuid;
  found_row boolean;
  prev_bypass text;
BEGIN
  IF child_tenant IS NULL THEN
    RETURN NEW;
  END IF;
  doc := to_jsonb(NEW);
  i := 0;
  WHILE i < TG_NARGS LOOP
    col := TG_ARGV[i];
    parent := TG_ARGV[i + 1];
    i := i + 2;
    ref_value := doc ->> col;
    CONTINUE WHEN ref_value IS NULL;
    -- Skip unchanged references on UPDATE (cheap, and keeps legacy rows editable).
    IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> col) IS NOT DISTINCT FROM ref_value
       AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id THEN
      CONTINUE;
    END IF;
    prev_bypass := coalesce(current_setting('app.bypass_rls', true), '');
    PERFORM set_config('app.bypass_rls', 'on', true);
    -- Every referenced table is keyed by a uuid id (verified at migration time).
    EXECUTE format('SELECT true, tenant_id FROM %I WHERE id = $1::uuid', parent)
      INTO found_row, parent_tenant USING ref_value;
    PERFORM set_config('app.bypass_rls', prev_bypass, true);
    IF found_row AND parent_tenant IS NOT NULL AND parent_tenant <> child_tenant THEN
      RAISE EXCEPTION 'SAF_CROSS_TENANT_REF: %.% references a row of another business', TG_TABLE_NAME, col
        USING ERRCODE = '23503';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ch.relname AS child,
           string_agg(quote_literal(a.attname) || ', ' || quote_literal(pa.relname), ', ' ORDER BY a.attname) AS args,
           string_agg(quote_ident(a.attname), ', ' ORDER BY a.attname) AS cols
    FROM pg_constraint k
    JOIN pg_class ch ON ch.oid = k.conrelid
    JOIN pg_class pa ON pa.oid = k.confrelid
    JOIN pg_namespace n ON n.oid = ch.relnamespace AND n.nspname = 'public'
    JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
    WHERE k.contype = 'f'
      AND array_length(k.conkey, 1) = 1
      AND a.attname <> 'tenant_id'
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = ch.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pa.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
    GROUP BY ch.relname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS saf_tenant_refs ON %I', r.child);
    EXECUTE format(
      'CREATE TRIGGER saf_tenant_refs BEFORE INSERT OR UPDATE OF tenant_id, %s ON %I '
      'FOR EACH ROW EXECUTE FUNCTION saf_check_tenant_refs(%s)', r.cols, r.child, r.args);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- SEC-11: the audit trail is append-only for EVERY role (saf_app already has
-- no UPDATE/DELETE grant; this also covers the owner role and cascades).
-- A DBA performing a documented retention purge sets app.audit_purge = 'on'
-- in their own session; see SECURITY_INCIDENT_RESPONSE.md.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saf_audit_immutable() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.audit_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SAF_AUDIT_IMMUTABLE: audit_logs rows cannot be % ', lower(TG_OP)
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER saf_audit_immutable
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION saf_audit_immutable();

CREATE INDEX IF NOT EXISTS "audit_logs_action_created_at_idx" ON "audit_logs" ("action", "created_at");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
    GRANT EXECUTE ON FUNCTION saf_check_tenant_refs(), saf_audit_immutable() TO saf_app;
  END IF;
END $$;
