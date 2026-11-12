-- ===========================================================================
-- SMARTAUTO FLEX - tenant isolation with PostgreSQL Row-Level Security
-- ===========================================================================
--
-- The application connects as the non-superuser role `saf_app`. Every request
-- runs inside a transaction that sets ONE of:
--
--   SET LOCAL app.tenant_id = '<uuid>'   -- tenant-scoped work
--   SET LOCAL app.bypass_rls = 'on'      -- platform (Super Admin) and the
--                                           authentication bootstrap only
--
-- If neither is set, every tenant table returns zero rows and rejects writes
-- (fail-closed). FORCE ROW LEVEL SECURITY applies the policies to the table
-- owner as well, so only a superuser can read across tenants unconditionally.
-- ===========================================================================

CREATE OR REPLACE FUNCTION saf_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION saf_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

-- The tenants table is keyed by id rather than tenant_id.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenants"
  USING (saf_rls_bypass() OR id = saf_current_tenant())
  WITH CHECK (saf_rls_bypass() OR id = saf_current_tenant());

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- core
    'businesses', 'branches', 'product_subscriptions', 'subscription_events',
    'tenant_features', 'tenant_product_settings', 'doc_sequences', 'users',
    'user_product_access', 'sessions', 'audit_logs', 'notifications',
    'invoices', 'payments', 'support_tickets', 'support_messages',
    -- staff
    'employee_profiles', 'staff_shifts', 'shift_assignments', 'staff_attendance',
    'employee_id_cards',
    -- dine
    'dine_tables', 'dine_menu_categories', 'dine_menu_items', 'dine_orders',
    'dine_order_items', 'dine_kitchen_orders', 'dine_stock_items',
    'dine_recipe_items', 'dine_stock_movements', 'dine_suppliers',
    'dine_purchases', 'dine_purchase_items', 'dine_wastage',
    -- stay
    'stay_room_types', 'stay_rooms', 'stay_guests', 'stay_reservations',
    'stay_folio_charges', 'stay_folio_payments', 'stay_expenses',
    'stay_housekeeping_tasks', 'stay_maintenance_records',
    -- bill
    'bill_categories', 'bill_products', 'bill_stock_levels',
    'bill_stock_movements', 'bill_customers', 'bill_counters', 'bill_sales',
    'bill_sale_items', 'bill_suppliers', 'bill_purchases', 'bill_purchase_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (saf_rls_bypass() OR tenant_id = saf_current_tenant()) '
      'WITH CHECK (saf_rls_bypass() OR tenant_id = saf_current_tenant())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Hotel rooms can never be double-booked, even under concurrent requests.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "stay_reservations"
  ADD CONSTRAINT stay_reservations_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in_date, check_out_date, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status IN ('CONFIRMED', 'CHECKED_IN'));

ALTER TABLE "stay_reservations"
  ADD CONSTRAINT stay_reservations_dates_valid CHECK (check_out_date > check_in_date);

-- ---------------------------------------------------------------------------
-- Runtime role privileges (role is created by deploy/postgres-init).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
    GRANT USAGE ON SCHEMA public TO saf_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO saf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO saf_app;
    GRANT EXECUTE ON FUNCTION saf_current_tenant(), saf_rls_bypass() TO saf_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO saf_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO saf_app;
    -- Audit trail is append-only for the application.
    REVOKE UPDATE, DELETE ON "audit_logs" FROM saf_app;
    -- The application never touches migration bookkeeping.
    REVOKE ALL ON "_prisma_migrations" FROM saf_app;
  END IF;
END $$;
