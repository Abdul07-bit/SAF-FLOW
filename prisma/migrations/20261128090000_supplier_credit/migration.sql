-- Supplier credit & payables (SAF Dine Flow). See docs/SUPPLIER-CREDIT.md.
--
-- 1. dine_suppliers gains the payables profile (business name, WhatsApp,
--    category, payment terms, credit limit, notes). It stays the one supplier
--    table: stock items and purchase orders keep using it.
-- 2. Bills (supplier_purchases + items), payments, credit adjustments, the
--    allocations between them and the append-only supplier ledger.
-- 3. Alert settings and the alert log.
-- 4. Integrity: CHECK constraints, a trigger that refuses to rewrite or delete
--    financial records, RLS and same-tenant references on every new table.
-- 5. Catalog: plan feature dine.supplier_credit (Growth) and the
--    dine.payables.* permissions, so environments that only run migrations
--    (the Vercel pipeline) get them.


-- AlterTable
ALTER TABLE "dine_suppliers" ADD COLUMN     "business_name" TEXT,
ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "created_by_id" UUID,
ADD COLUMN     "credit_limit" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "payment_terms_days" INTEGER,
ADD COLUMN     "updated_at" TIMESTAMP(3),
ADD COLUMN     "whatsapp" TEXT;

-- CreateTable
CREATE TABLE "supplier_purchases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "supplier_id" UUID NOT NULL,
    "bill_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PURCHASE',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "bill_date" DATE NOT NULL,
    "due_date" DATE,
    "invoice_no" TEXT,
    "total" INTEGER NOT NULL,
    "notes" TEXT,
    "attachment_key" TEXT,
    "dine_purchase_id" UUID,
    "client_ref" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "supplier_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_purchase_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "product_name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "rate" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "stock_item_id" UUID,

    CONSTRAINT "supplier_purchase_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "supplier_id" UUID NOT NULL,
    "payment_no" INTEGER NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "receipt_key" TEXT,
    "source_purchase_id" UUID,
    "is_advance" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "client_ref" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "reversed_by_id" UUID,
    "reverse_reason" TEXT,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_credit_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "adjustment_no" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "adjustment_date" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "purchase_id" UUID,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "client_ref" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "reversed_by_id" UUID,
    "reverse_reason" TEXT,

    CONSTRAINT "supplier_credit_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "payment_id" UUID,
    "adjustment_id" UUID,
    "amount" INTEGER NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "entry_date" DATE NOT NULL,
    "entry_type" TEXT NOT NULL,
    "increase" INTEGER NOT NULL DEFAULT 0,
    "decrease" INTEGER NOT NULL DEFAULT 0,
    "purchase_id" UUID,
    "payment_id" UUID,
    "adjustment_id" UUID,
    "reference" TEXT,
    "description" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_credit_settings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notify_purchases" BOOLEAN NOT NULL DEFAULT true,
    "notify_payments" BOOLEAN NOT NULL DEFAULT true,
    "notify_overdue" BOOLEAN NOT NULL DEFAULT true,
    "total_credit_limit" INTEGER,
    "aging_days" INTEGER DEFAULT 30,
    "daily_summary" BOOLEAN NOT NULL DEFAULT true,
    "weekly_summary" BOOLEAN NOT NULL DEFAULT true,
    "monthly_summary" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_number" TEXT,
    "link_stock_purchases" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_credit_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "supplier_id" UUID,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "channels" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_dine_purchase_id_key" ON "supplier_purchases"("dine_purchase_id");

-- CreateIndex
CREATE INDEX "supplier_purchases_tenant_id_supplier_id_bill_date_idx" ON "supplier_purchases"("tenant_id", "supplier_id", "bill_date");

-- CreateIndex
CREATE INDEX "supplier_purchases_tenant_id_bill_date_idx" ON "supplier_purchases"("tenant_id", "bill_date");

-- CreateIndex
CREATE INDEX "supplier_purchases_tenant_id_status_due_date_idx" ON "supplier_purchases"("tenant_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_tenant_id_bill_no_key" ON "supplier_purchases"("tenant_id", "bill_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_purchases_tenant_id_client_ref_key" ON "supplier_purchases"("tenant_id", "client_ref");

-- CreateIndex
CREATE INDEX "supplier_purchase_items_purchase_id_idx" ON "supplier_purchase_items"("purchase_id");

-- CreateIndex
CREATE INDEX "supplier_payments_tenant_id_supplier_id_payment_date_idx" ON "supplier_payments"("tenant_id", "supplier_id", "payment_date");

-- CreateIndex
CREATE INDEX "supplier_payments_tenant_id_payment_date_idx" ON "supplier_payments"("tenant_id", "payment_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_tenant_id_payment_no_key" ON "supplier_payments"("tenant_id", "payment_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_tenant_id_client_ref_key" ON "supplier_payments"("tenant_id", "client_ref");

-- CreateIndex
CREATE INDEX "supplier_credit_adjustments_tenant_id_supplier_id_adjustmen_idx" ON "supplier_credit_adjustments"("tenant_id", "supplier_id", "adjustment_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_adjustments_tenant_id_adjustment_no_key" ON "supplier_credit_adjustments"("tenant_id", "adjustment_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_adjustments_tenant_id_client_ref_key" ON "supplier_credit_adjustments"("tenant_id", "client_ref");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_tenant_id_supplier_id_idx" ON "supplier_payment_allocations"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_purchase_id_idx" ON "supplier_payment_allocations"("purchase_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_payment_id_idx" ON "supplier_payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_adjustment_id_idx" ON "supplier_payment_allocations"("adjustment_id");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_tenant_id_supplier_id_entry_date_idx" ON "supplier_ledger_entries"("tenant_id", "supplier_id", "entry_date");

-- CreateIndex
CREATE INDEX "supplier_ledger_entries_tenant_id_entry_date_idx" ON "supplier_ledger_entries"("tenant_id", "entry_date");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_settings_tenant_id_key" ON "supplier_credit_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "supplier_notifications_tenant_id_created_at_idx" ON "supplier_notifications"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_notifications_tenant_id_dedupe_key_key" ON "supplier_notifications"("tenant_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "dine_suppliers_tenant_id_is_active_idx" ON "dine_suppliers"("tenant_id", "is_active");

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchases" ADD CONSTRAINT "supplier_purchases_dine_purchase_id_fkey" FOREIGN KEY ("dine_purchase_id") REFERENCES "dine_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_purchase_items" ADD CONSTRAINT "supplier_purchase_items_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_source_purchase_id_fkey" FOREIGN KEY ("source_purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_adjustments" ADD CONSTRAINT "supplier_credit_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_adjustments" ADD CONSTRAINT "supplier_credit_adjustments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_adjustments" ADD CONSTRAINT "supplier_credit_adjustments_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "supplier_credit_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "dine_suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "supplier_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "supplier_credit_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_settings" ADD CONSTRAINT "supplier_credit_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_notifications" ADD CONSTRAINT "supplier_notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Integrity rules (money in paise; kinds and statuses are closed lists)
-- ---------------------------------------------------------------------------
ALTER TABLE "dine_suppliers"
  ADD CONSTRAINT "dine_suppliers_category_check" CHECK ("category" IN ('CHICKEN', 'MEAT', 'VEGETABLES', 'GROCERIES', 'DAIRY', 'BEVERAGES', 'OTHER')),
  ADD CONSTRAINT "dine_suppliers_terms_check" CHECK ("payment_terms_days" IS NULL OR "payment_terms_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "dine_suppliers_credit_limit_check" CHECK ("credit_limit" IS NULL OR "credit_limit" >= 0);

ALTER TABLE "supplier_purchases"
  ADD CONSTRAINT "supplier_purchases_kind_check" CHECK ("kind" IN ('PURCHASE', 'OPENING_BALANCE')),
  ADD CONSTRAINT "supplier_purchases_status_check" CHECK ("status" IN ('ACTIVE', 'CANCELLED')),
  ADD CONSTRAINT "supplier_purchases_total_check" CHECK ("total" > 0),
  ADD CONSTRAINT "supplier_purchases_due_check" CHECK ("due_date" IS NULL OR "due_date" >= "bill_date"),
  ADD CONSTRAINT "supplier_purchases_cancel_check" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL));

ALTER TABLE "supplier_purchase_items"
  ADD CONSTRAINT "supplier_purchase_items_unit_check" CHECK ("unit" IN ('KG', 'GRAM', 'LITRE', 'PIECE', 'BOX', 'PACKET', 'OTHER')),
  ADD CONSTRAINT "supplier_purchase_items_qty_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "supplier_purchase_items_rate_check" CHECK ("rate" >= 0),
  ADD CONSTRAINT "supplier_purchase_items_amount_check" CHECK ("amount" >= 0);

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_method_check" CHECK ("method" IN ('CASH', 'UPI', 'BANK_TRANSFER', 'OTHER')),
  ADD CONSTRAINT "supplier_payments_status_check" CHECK ("status" IN ('ACTIVE', 'REVERSED')),
  ADD CONSTRAINT "supplier_payments_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "supplier_payments_reverse_check" CHECK (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL));

ALTER TABLE "supplier_credit_adjustments"
  ADD CONSTRAINT "supplier_credit_adjustments_direction_check" CHECK ("direction" IN ('INCREASE', 'DECREASE')),
  ADD CONSTRAINT "supplier_credit_adjustments_kind_check" CHECK ("kind" IN ('RETURN', 'DISCOUNT', 'CORRECTION', 'WRITE_OFF', 'OTHER')),
  ADD CONSTRAINT "supplier_credit_adjustments_status_check" CHECK ("status" IN ('ACTIVE', 'REVERSED')),
  ADD CONSTRAINT "supplier_credit_adjustments_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "supplier_credit_adjustments_reverse_check" CHECK (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL));

ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "supplier_payment_allocations_source_check" CHECK (("payment_id" IS NULL) <> ("adjustment_id" IS NULL));

ALTER TABLE "supplier_ledger_entries"
  ADD CONSTRAINT "supplier_ledger_entries_type_check" CHECK ("entry_type" IN (
    'OPENING_BALANCE', 'PURCHASE', 'PAYMENT', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE',
    'PURCHASE_CANCELLED', 'PAYMENT_REVERSED', 'ADJUSTMENT_REVERSED')),
  ADD CONSTRAINT "supplier_ledger_entries_amount_check" CHECK ("increase" >= 0 AND "decrease" >= 0 AND ("increase" > 0) <> ("decrease" > 0));

ALTER TABLE "supplier_credit_settings"
  ADD CONSTRAINT "supplier_credit_settings_limit_check" CHECK ("total_credit_limit" IS NULL OR "total_credit_limit" >= 0),
  ADD CONSTRAINT "supplier_credit_settings_aging_check" CHECK ("aging_days" IS NULL OR "aging_days" BETWEEN 1 AND 365);

-- ---------------------------------------------------------------------------
-- Financial records cannot be rewritten. Bills, payments and adjustments may
-- only be cancelled / reversed (once); allocations may only be voided; ledger
-- entries and bill lines never change. Covers every database role, like the
-- audit trail; a DBA retention purge sets app.audit_purge = 'on'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saf_payables_guard() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  o jsonb;
  n jsonb;
  k text;
  allowed text[];
BEGIN
  IF coalesce(current_setting('app.audit_purge', true), '') = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' OR TG_TABLE_NAME IN ('supplier_ledger_entries', 'supplier_purchase_items') THEN
    RAISE EXCEPTION 'SAF_PAYABLES_IMMUTABLE: % rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '42501';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  allowed := CASE TG_TABLE_NAME
    WHEN 'supplier_purchases' THEN ARRAY['status', 'cancelled_at', 'cancelled_by_id', 'cancel_reason', 'invoice_no', 'due_date', 'notes', 'attachment_key', 'updated_at']
    WHEN 'supplier_payments' THEN ARRAY['status', 'reversed_at', 'reversed_by_id', 'reverse_reason', 'reference', 'notes', 'receipt_key', 'updated_at', 'source_purchase_id']
    WHEN 'supplier_credit_adjustments' THEN ARRAY['status', 'reversed_at', 'reversed_by_id', 'reverse_reason', 'updated_at', 'purchase_id']
    WHEN 'supplier_payment_allocations' THEN ARRAY['voided_at', 'void_reason']
  END;
  FOR k IN SELECT jsonb_object_keys(n) LOOP
    IF (o -> k) IS DISTINCT FROM (n -> k) AND NOT (k = ANY (allowed)) THEN
      RAISE EXCEPTION 'SAF_PAYABLES_IMMUTABLE: %.% cannot be changed; record a reversal or adjustment instead', TG_TABLE_NAME, k USING ERRCODE = '42501';
    END IF;
  END LOOP;
  -- One-way status changes.
  IF (o ->> 'status') IN ('CANCELLED', 'REVERSED') AND (o -> 'status') IS DISTINCT FROM (n -> 'status') THEN
    RAISE EXCEPTION 'SAF_PAYABLES_IMMUTABLE: a cancelled or reversed record cannot be reopened' USING ERRCODE = '42501';
  END IF;
  IF TG_TABLE_NAME = 'supplier_payment_allocations' AND (o ->> 'voided_at') IS NOT NULL
     AND ((o -> 'voided_at') IS DISTINCT FROM (n -> 'voided_at') OR (o -> 'void_reason') IS DISTINCT FROM (n -> 'void_reason')) THEN
    RAISE EXCEPTION 'SAF_PAYABLES_IMMUTABLE: a voided allocation cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['supplier_purchases', 'supplier_purchase_items', 'supplier_payments',
                             'supplier_credit_adjustments', 'supplier_payment_allocations', 'supplier_ledger_entries']
  LOOP
    EXECUTE format('CREATE TRIGGER saf_payables_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION saf_payables_guard()', tbl);
  END LOOP;
END $$;

-- Allocations can never settle more than a bill's total or use more than a
-- payment / credit's amount, and only link live records of the same supplier.
-- (The application locks the supplier first; this is the database backstop.)
CREATE OR REPLACE FUNCTION saf_payables_allocation_check() RETURNS trigger
  LANGUAGE plpgsql AS
$$
DECLARE
  bill_total int;
  bill_status text;
  bill_supplier uuid;
  src_amount int;
  src_status text;
  src_supplier uuid;
  used int;
BEGIN
  SELECT total, status, supplier_id INTO bill_total, bill_status, bill_supplier FROM supplier_purchases WHERE id = NEW.purchase_id;
  IF bill_status IS DISTINCT FROM 'ACTIVE' OR bill_supplier IS DISTINCT FROM NEW.supplier_id THEN
    RAISE EXCEPTION 'SAF_ALLOCATION_INVALID: bill is not an active bill of this supplier' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO used FROM supplier_payment_allocations WHERE purchase_id = NEW.purchase_id AND voided_at IS NULL;
  IF used + NEW.amount > bill_total THEN
    RAISE EXCEPTION 'SAF_ALLOCATION_INVALID: bill would be over-settled' USING ERRCODE = '23514';
  END IF;
  IF NEW.payment_id IS NOT NULL THEN
    SELECT amount, status, supplier_id INTO src_amount, src_status, src_supplier FROM supplier_payments WHERE id = NEW.payment_id;
    SELECT coalesce(sum(amount), 0) INTO used FROM supplier_payment_allocations WHERE payment_id = NEW.payment_id AND voided_at IS NULL;
  ELSE
    SELECT amount, status, supplier_id INTO src_amount, src_status, src_supplier FROM supplier_credit_adjustments WHERE id = NEW.adjustment_id AND direction = 'DECREASE';
    SELECT coalesce(sum(amount), 0) INTO used FROM supplier_payment_allocations WHERE adjustment_id = NEW.adjustment_id AND voided_at IS NULL;
  END IF;
  IF src_status IS DISTINCT FROM 'ACTIVE' OR src_supplier IS DISTINCT FROM NEW.supplier_id OR used + NEW.amount > src_amount THEN
    RAISE EXCEPTION 'SAF_ALLOCATION_INVALID: payment or credit would be over-used' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER saf_payables_allocation_check
  BEFORE INSERT ON "supplier_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION saf_payables_allocation_check();

-- ---------------------------------------------------------------------------
-- Tenant isolation: RLS (same policy as every tenant table, SAF Team staff
-- scope included) and the same-tenant reference trigger from
-- security_hardening for every new foreign key to a tenant table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_purchases', 'supplier_purchase_items', 'supplier_payments', 'supplier_credit_adjustments',
                           'supplier_payment_allocations', 'supplier_ledger_entries', 'supplier_credit_settings', 'supplier_notifications']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (saf_rls_bypass() OR tenant_id = saf_current_tenant() OR saf_staff_tenant(tenant_id)) '
      'WITH CHECK (saf_rls_bypass() OR tenant_id = saf_current_tenant() OR saf_staff_tenant(tenant_id))', t);
  END LOOP;
END $$;

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
      AND ch.relname LIKE 'supplier\_%'
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = ch.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = pa.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
    GROUP BY ch.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER saf_tenant_refs BEFORE INSERT OR UPDATE OF tenant_id, %s ON %I '
      'FOR EACH ROW EXECUTE FUNCTION saf_check_tenant_refs(%s)', r.cols, r.child, r.args);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
    -- No DELETE anywhere: financial records are cancelled or reversed, never removed.
    GRANT SELECT, INSERT, UPDATE ON "supplier_purchases", "supplier_payments", "supplier_credit_adjustments",
      "supplier_payment_allocations", "supplier_credit_settings", "supplier_notifications" TO saf_app;
    GRANT SELECT, INSERT ON "supplier_purchase_items", "supplier_ledger_entries" TO saf_app;
    -- Default privileges (rls_security) would otherwise give saf_app UPDATE and DELETE here too.
    REVOKE DELETE ON "supplier_purchases", "supplier_purchase_items", "supplier_payments", "supplier_credit_adjustments",
      "supplier_payment_allocations", "supplier_ledger_entries", "supplier_notifications" FROM saf_app;
    REVOKE UPDATE ON "supplier_purchase_items", "supplier_ledger_entries" FROM saf_app;
    GRANT EXECUTE ON FUNCTION saf_payables_guard(), saf_payables_allocation_check() TO saf_app;
  END IF;
  -- Supabase Data API roles never reach SAF tables (see supabase_data_api_lockdown).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "supplier_purchases", "supplier_purchase_items", "supplier_payments", "supplier_credit_adjustments",
      "supplier_payment_allocations", "supplier_ledger_entries", "supplier_credit_settings", "supplier_notifications" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "supplier_purchases", "supplier_purchase_items", "supplier_payments", "supplier_credit_adjustments",
      "supplier_payment_allocations", "supplier_ledger_entries", "supplier_credit_settings", "supplier_notifications" FROM authenticated;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Catalog (mirrors src/config/catalog.ts; the seed keeps names in sync).
-- On a fresh database the products do not exist yet and nothing is inserted.
-- ---------------------------------------------------------------------------
INSERT INTO "feature_catalog" ("key", "product_code", "name", "group_name", "default_tier", "sort_order")
SELECT 'dine.supplier_credit', 'dine', 'Supplier credit & payables', 'Purchasing', 'GROWTH'::"PlanTier", 910
WHERE EXISTS (SELECT 1 FROM "products" p WHERE p.code = 'dine')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "plan_features" ("plan_id", "feature_key")
SELECT p.id, 'dine.supplier_credit'
FROM "plans" p
WHERE p.product_code = 'dine' AND p.tier = 'GROWTH'
  AND EXISTS (SELECT 1 FROM "feature_catalog" fc WHERE fc.key = 'dine.supplier_credit')
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("key", "product_code", "name")
SELECT v.key, 'dine', v.name
FROM (VALUES
  ('dine.payables.view', 'View supplier balances, ledgers and credit reports'),
  ('dine.payables.manage', 'Record suppliers, credit purchases and supplier payments'),
  ('dine.payables.adjust', 'Cancel, reverse and adjust supplier transactions; supplier credit settings')
) AS v(key, name)
WHERE EXISTS (SELECT 1 FROM "products" p WHERE p.code = 'dine')
ON CONFLICT ("key") DO NOTHING;

-- Managers hold every permission of their product.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT r.id, k.key
FROM "roles" r
CROSS JOIN (VALUES ('dine.payables.view'), ('dine.payables.manage'), ('dine.payables.adjust')) AS k(key)
WHERE r.code = 'manager' AND r.product_code = 'dine'
  AND EXISTS (SELECT 1 FROM "permissions" pm WHERE pm.key = k.key)
ON CONFLICT DO NOTHING;
