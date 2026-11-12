-- SAF Flow foundation: platform RBAC, SAF Team assignments, invitations,
-- Supabase identity link, branch restrictions, staff-scoped RLS.


-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "auth_user_id" UUID,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "platform_roles" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "all_tenants" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "customized" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "platform_permissions" (
    "key" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "platform_permissions_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "platform_role_permissions" (
    "role_code" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("role_code","permission_key")
);

-- CreateTable
CREATE TABLE "platform_staff_profiles" (
    "user_id" UUID NOT NULL,
    "employee_code" TEXT NOT NULL,
    "department" TEXT,
    "designation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_staff_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "staff_assignments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "assigned_by_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_assignment_branches" (
    "assignment_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "staff_assignment_branches_pkey" PRIMARY KEY ("assignment_id","branch_id")
);

-- CreateTable
CREATE TABLE "staff_assignment_modules" (
    "assignment_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "staff_assignment_modules_pkey" PRIMARY KEY ("assignment_id","product_code")
);

-- CreateTable
CREATE TABLE "staff_assignment_permissions" (
    "assignment_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "staff_assignment_permissions_pkey" PRIMARY KEY ("assignment_id","permission_key")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "delivery" TEXT NOT NULL DEFAULT 'email',
    "invited_by_id" UUID,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_branch_access" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,

    CONSTRAINT "user_branch_access_pkey" PRIMARY KEY ("user_id","branch_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_staff_profiles_employee_code_key" ON "platform_staff_profiles"("employee_code");

-- CreateIndex
CREATE INDEX "staff_assignments_tenant_id_idx" ON "staff_assignments"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_assignments_user_id_tenant_id_key" ON "staff_assignments"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_idx" ON "invitations"("tenant_id");

-- CreateIndex
CREATE INDEX "invitations_user_id_idx" ON "invitations"("user_id");

-- CreateIndex
CREATE INDEX "user_branch_access_tenant_id_idx" ON "user_branch_access"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "users"("auth_user_id");

-- System platform roles must exist before users.platform_role references them.
-- Permissions and role grants are synced by the seed from src/config/platform.ts.
INSERT INTO "platform_roles" ("code", "name", "description", "all_tenants", "is_system", "sort_order", "updated_at") VALUES
  ('SUPER_ADMIN',         'Platform Super Admin',     'Full control of SAF Flow.',                       true,  true, 1, CURRENT_TIMESTAMP),
  ('PLATFORM_ADMIN',      'Platform Administrator',   'Runs the platform day to day.',                   true,  true, 2, CURRENT_TIMESTAMP),
  ('OPERATIONS_MANAGER',  'Operations Manager',       'Manages assigned clients.',                       false, true, 3, CURRENT_TIMESTAMP),
  ('CLIENT_SUCCESS',      'Client Success Manager',   'Looks after assigned clients.',                   false, true, 4, CURRENT_TIMESTAMP),
  ('TECH_SUPPORT',        'Technical Support',        'Resolves assigned clients'' technical issues.',   false, true, 5, CURRENT_TIMESTAMP),
  ('BILLING_MANAGER',     'Billing Manager',          'Invoices and payments for assigned clients.',     false, true, 6, CURRENT_TIMESTAMP),
  ('IMPLEMENTATION_EXEC', 'Implementation Executive', 'Onboards new clients.',                           false, true, 7, CURRENT_TIMESTAMP),
  ('AUDITOR',             'Read-only Auditor',        'Read-only access to every business.',             true,  true, 8, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Least privilege: an unknown legacy role grants nothing.
UPDATE "users" SET "platform_role" = NULL
WHERE "platform_role" IS NOT NULL AND "platform_role" NOT IN (SELECT "code" FROM "platform_roles");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_fkey" FOREIGN KEY ("platform_role") REFERENCES "platform_roles"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "platform_roles"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "platform_permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_staff_profiles" ADD CONSTRAINT "platform_staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignments" ADD CONSTRAINT "staff_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_branches" ADD CONSTRAINT "staff_assignment_branches_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_branches" ADD CONSTRAINT "staff_assignment_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_branches" ADD CONSTRAINT "staff_assignment_branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_modules" ADD CONSTRAINT "staff_assignment_modules_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_modules" ADD CONSTRAINT "staff_assignment_modules_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "products"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_modules" ADD CONSTRAINT "staff_assignment_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_permissions" ADD CONSTRAINT "staff_assignment_permissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "staff_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_assignment_permissions" ADD CONSTRAINT "staff_assignment_permissions_permission_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "platform_permissions"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- SAF Flow foundation - identity constraints
-- ===========================================================================

-- Email is the login for Supabase-identity accounts: one account per email.
CREATE UNIQUE INDEX "users_identity_email_key" ON "users" (lower("email")) WHERE "auth_user_id" IS NOT NULL;

-- Every account has exactly one way to authenticate.
ALTER TABLE "users" ADD CONSTRAINT "users_credential_present"
  CHECK ("password_hash" IS NOT NULL OR "auth_user_id" IS NOT NULL);

-- ===========================================================================
-- SAF Team scoping with Row-Level Security
-- ===========================================================================
--
-- A third request scope joins the two from 20261110120000_rls_security:
--
--   SET LOCAL app.staff_user_id = '<uuid>'   -- SAF Team member whose role
--                                               does NOT have all_tenants
--
-- In that scope every tenant table exposes only the rows of businesses the
-- member is actively assigned to (staff_assignments). Members whose role has
-- all_tenants (Super Admin, Platform Admin, Auditor) keep using
-- app.bypass_rls. Nothing in the staff scope can change assignments.
-- ===========================================================================

CREATE OR REPLACE FUNCTION saf_staff_user() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.staff_user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION saf_staff_tenant(t uuid) RETURNS boolean
  LANGUAGE sql STABLE AS
$$
  SELECT saf_staff_user() IS NOT NULL AND t IS NOT NULL AND EXISTS (
    SELECT 1 FROM staff_assignments a
    WHERE a.user_id = saf_staff_user() AND a.tenant_id = t
      AND a.is_active AND a.revoked_at IS NULL)
$$;

-- Assignment tables: readable by their own member, writable only by
-- platform-wide administrators (bypass scope).
ALTER TABLE "staff_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_assignment_read ON "staff_assignments" FOR SELECT
  USING (saf_rls_bypass() OR user_id = saf_staff_user());
CREATE POLICY staff_assignment_write ON "staff_assignments" FOR ALL
  USING (saf_rls_bypass()) WITH CHECK (saf_rls_bypass());

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff_assignment_branches', 'staff_assignment_modules', 'staff_assignment_permissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY own_assignment_read ON %I FOR SELECT USING (saf_rls_bypass() OR EXISTS '
      '(SELECT 1 FROM staff_assignments a WHERE a.id = assignment_id))', t);
    EXECUTE format('CREATE POLICY assignment_write ON %I FOR ALL USING (saf_rls_bypass()) WITH CHECK (saf_rls_bypass())', t);
  END LOOP;
END $$;

-- Platform RBAC catalog: readable in every scope (sessions resolve roles),
-- writable only in bypass scope.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_roles', 'platform_permissions', 'platform_role_permissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY catalog_read ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY catalog_write ON %I FOR ALL USING (saf_rls_bypass()) WITH CHECK (saf_rls_bypass())', t);
  END LOOP;
END $$;

ALTER TABLE "platform_staff_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_staff_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_profile_access ON "platform_staff_profiles"
  USING (saf_rls_bypass() OR user_id = saf_staff_user())
  WITH CHECK (saf_rls_bypass());

-- New tenant-owned tables get the standard isolation policy first ...
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations', 'user_branch_access'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (saf_rls_bypass() OR tenant_id = saf_current_tenant()) '
      'WITH CHECK (saf_rls_bypass() OR tenant_id = saf_current_tenant())', t);
  END LOOP;
END $$;

-- ... then EVERY tenant_isolation policy is widened to the staff scope.
DO $$
DECLARE
  r record;
  col text;
BEGIN
  FOR r IN SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation' LOOP
    col := CASE WHEN r.tablename = 'tenants' THEN 'id' ELSE 'tenant_id' END;
    EXECUTE format('DROP POLICY tenant_isolation ON %I', r.tablename);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (saf_rls_bypass() OR %2$I = saf_current_tenant() OR saf_staff_tenant(%2$I)) '
      'WITH CHECK (saf_rls_bypass() OR %2$I = saf_current_tenant() OR saf_staff_tenant(%2$I))',
      r.tablename, col);
  END LOOP;
END $$;

-- Platform-level rows (tenant_id IS NULL) a scoped member legitimately
-- writes: their own audit trail and platform document counters.
CREATE POLICY staff_platform_audit ON "audit_logs" FOR INSERT
  WITH CHECK (saf_staff_user() IS NOT NULL AND tenant_id IS NULL);
CREATE POLICY staff_platform_sequences ON "doc_sequences"
  USING (saf_staff_user() IS NOT NULL AND tenant_id IS NULL)
  WITH CHECK (saf_staff_user() IS NOT NULL AND tenant_id IS NULL);

-- ===========================================================================
-- Runtime role privileges for the new objects
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "platform_roles", "platform_permissions", "platform_role_permissions", "platform_staff_profiles",
      "staff_assignments", "staff_assignment_branches", "staff_assignment_modules", "staff_assignment_permissions",
      "invitations", "user_branch_access"
      TO saf_app;
    GRANT EXECUTE ON FUNCTION saf_staff_user(), saf_staff_tenant(uuid) TO saf_app;
  END IF;
END $$;

-- ===========================================================================
-- Supabase hardening. On Supabase, the public schema is reachable through the
-- Data API (PostgREST) with the publishable key. SAF Flow never uses the Data
-- API for its tables, so the API roles get no access at all. No-op on plain
-- PostgreSQL where these roles do not exist.
-- ===========================================================================
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
