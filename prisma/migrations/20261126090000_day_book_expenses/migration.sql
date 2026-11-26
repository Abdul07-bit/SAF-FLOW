-- Day book: business days, daily order numbers, shop expenses, daily WhatsApp report.
--
-- 1. dine_orders / bill_sales get business_date (the trading day the order
--    belongs to; a shop that closes at 02:00 books a 01:30 order on the
--    previous date) and daily_no (1, 2, 3... per branch, restarting every
--    business day). order_no / sale_no stay as the running number.
-- 2. dine_expenses and bill_expenses (stay_expenses already exists).
-- 3. daily_reports: one row per business day and product for the Growth
--    plan's end-of-day PDF on WhatsApp, so the job never sends twice.
-- 4. Catalog: the new plan features and the expenses.manage permission, so
--    environments that only run migrations (the Vercel pipeline) get them.

-- ---------------------------------------------------------------------------
-- 1. Business date and daily number
-- ---------------------------------------------------------------------------
ALTER TABLE "dine_orders" ADD COLUMN "business_date" DATE, ADD COLUMN "daily_no" INTEGER;
ALTER TABLE "bill_sales" ADD COLUMN "business_date" DATE, ADD COLUMN "daily_no" INTEGER;

-- Existing rows: IST calendar date of creation (every shop starts with the
-- default hours, which roll over at midnight), numbered in creation order.
UPDATE "dine_orders" o SET "business_date" = x.d, "daily_no" = x.n
FROM (
  SELECT id, d, row_number() OVER (PARTITION BY tenant_id, branch_id, d ORDER BY order_no) AS n
  FROM (SELECT id, tenant_id, branch_id, order_no, ("created_at" + interval '5 hours 30 minutes')::date AS d FROM "dine_orders") s
) x
WHERE o.id = x.id;

UPDATE "bill_sales" b SET "business_date" = x.d, "daily_no" = x.n
FROM (
  SELECT id, d, row_number() OVER (PARTITION BY tenant_id, branch_id, d ORDER BY sale_no) AS n
  FROM (SELECT id, tenant_id, branch_id, sale_no, ("created_at" + interval '5 hours 30 minutes')::date AS d FROM "bill_sales") s
) x
WHERE b.id = x.id;

ALTER TABLE "dine_orders" ALTER COLUMN "business_date" SET NOT NULL, ALTER COLUMN "daily_no" SET NOT NULL;
ALTER TABLE "bill_sales" ALTER COLUMN "business_date" SET NOT NULL, ALTER COLUMN "daily_no" SET NOT NULL;

CREATE UNIQUE INDEX "dine_orders_tenant_id_branch_id_business_date_daily_no_key" ON "dine_orders"("tenant_id", "branch_id", "business_date", "daily_no");
CREATE INDEX "dine_orders_tenant_id_business_date_idx" ON "dine_orders"("tenant_id", "business_date");
CREATE UNIQUE INDEX "bill_sales_tenant_id_branch_id_business_date_daily_no_key" ON "bill_sales"("tenant_id", "branch_id", "business_date", "daily_no");
CREATE INDEX "bill_sales_tenant_id_business_date_idx" ON "bill_sales"("tenant_id", "business_date");

-- Continue today's (and yesterday's) daily counters after the backfilled numbers.
-- Keys match nextSeq(db, tenantId, `dine-daily:<branch>:<date>`) / `bill-daily:...`.
INSERT INTO "doc_sequences" ("scope", "tenant_id", "value")
SELECT tenant_id::text || ':dine-daily:' || branch_id::text || ':' || to_char(business_date, 'YYYY-MM-DD'), tenant_id, max(daily_no)
FROM "dine_orders"
WHERE business_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 1
GROUP BY tenant_id, branch_id, business_date
ON CONFLICT ("scope") DO UPDATE SET "value" = GREATEST("doc_sequences"."value", EXCLUDED."value");

INSERT INTO "doc_sequences" ("scope", "tenant_id", "value")
SELECT tenant_id::text || ':bill-daily:' || branch_id::text || ':' || to_char(business_date, 'YYYY-MM-DD'), tenant_id, max(daily_no)
FROM "bill_sales"
WHERE business_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 1
GROUP BY tenant_id, branch_id, business_date
ON CONFLICT ("scope") DO UPDATE SET "value" = GREATEST("doc_sequences"."value", EXCLUDED."value");

-- ---------------------------------------------------------------------------
-- 2. Expenses
-- ---------------------------------------------------------------------------
CREATE TABLE "dine_expenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "expense_date" DATE NOT NULL,
    "paid_to" TEXT,
    "method" "TenderType" NOT NULL DEFAULT 'CASH',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dine_expenses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bill_expenses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "expense_date" DATE NOT NULL,
    "paid_to" TEXT,
    "method" "TenderType" NOT NULL DEFAULT 'CASH',
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dine_expenses_tenant_id_expense_date_idx" ON "dine_expenses"("tenant_id", "expense_date");
CREATE INDEX "bill_expenses_tenant_id_expense_date_idx" ON "bill_expenses"("tenant_id", "expense_date");
ALTER TABLE "dine_expenses" ADD CONSTRAINT "dine_expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bill_expenses" ADD CONSTRAINT "bill_expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Daily reports
-- ---------------------------------------------------------------------------
CREATE TABLE "daily_reports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "business_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "sent_to" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_reports_tenant_id_product_code_business_date_key" ON "daily_reports"("tenant_id", "product_code", "business_date");
CREATE INDEX "daily_reports_tenant_id_created_at_idx" ON "daily_reports"("tenant_id", "created_at");
ALTER TABLE "daily_reports" ADD CONSTRAINT "daily_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant isolation (same policy shape as every other tenant table, including the SAF Team staff scope).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dine_expenses', 'bill_expenses', 'daily_reports']
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
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saf_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "dine_expenses", "bill_expenses", "daily_reports" TO saf_app;
  END IF;
  -- Supabase Data API roles never reach SAF tables (see supabase_data_api_lockdown).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "dine_expenses", "bill_expenses", "daily_reports" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "dine_expenses", "bill_expenses", "daily_reports" FROM authenticated;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Catalog (mirrors src/config/catalog.ts; the seed keeps names in sync).
-- On a fresh database the products do not exist yet and nothing is inserted.
-- ---------------------------------------------------------------------------
INSERT INTO "feature_catalog" ("key", "product_code", "name", "group_name", "default_tier", "sort_order")
SELECT f.key, f.product, f.name, 'Reports', f.tier::"PlanTier", 900
FROM (VALUES
  ('dine.expenses', 'dine', 'Daily expense management', 'BASIC'),
  ('bill.expenses', 'bill', 'Daily expense management', 'BASIC'),
  ('dine.day_book', 'dine', 'Day book: daily sales, expenses and orders', 'BASIC'),
  ('stay.day_book', 'stay', 'Day book: daily sales, expenses and orders', 'BASIC'),
  ('bill.day_book', 'bill', 'Day book: daily sales, expenses and orders', 'BASIC'),
  ('dine.daily_report_whatsapp', 'dine', 'Daily closing report on WhatsApp (PDF)', 'GROWTH'),
  ('stay.daily_report_whatsapp', 'stay', 'Daily closing report on WhatsApp (PDF)', 'GROWTH'),
  ('bill.daily_report_whatsapp', 'bill', 'Daily closing report on WhatsApp (PDF)', 'GROWTH')
) AS f(key, product, name, tier)
WHERE EXISTS (SELECT 1 FROM "products" p WHERE p.code = f.product)
ON CONFLICT ("key") DO NOTHING;

-- Basic features go into both plans, Growth features into Growth.
INSERT INTO "plan_features" ("plan_id", "feature_key")
SELECT p.id, fc.key
FROM "feature_catalog" fc
JOIN "plans" p ON p.product_code = fc.product_code AND (fc.default_tier = 'BASIC' OR p.tier = 'GROWTH')
WHERE fc.key IN (
  'dine.expenses', 'bill.expenses', 'dine.day_book', 'stay.day_book', 'bill.day_book',
  'dine.daily_report_whatsapp', 'stay.daily_report_whatsapp', 'bill.daily_report_whatsapp'
)
ON CONFLICT DO NOTHING;

INSERT INTO "permissions" ("key", "product_code", "name")
SELECT v.key, v.product, 'Record shop expenses'
FROM (VALUES ('dine.expenses.manage', 'dine'), ('bill.expenses.manage', 'bill')) AS v(key, product)
WHERE EXISTS (SELECT 1 FROM "products" p WHERE p.code = v.product)
ON CONFLICT ("key") DO NOTHING;

-- Managers hold every permission of their product.
INSERT INTO "role_permissions" ("role_id", "permission_key")
SELECT r.id, r.product_code || '.expenses.manage'
FROM "roles" r
WHERE r.code = 'manager' AND r.product_code IN ('dine', 'bill')
  AND EXISTS (SELECT 1 FROM "permissions" pm WHERE pm.key = r.product_code || '.expenses.manage')
ON CONFLICT DO NOTHING;
