-- Split payments: one bill paid with several tenders (e.g. Rs 400 UPI + Rs 300 cash).
-- payment_method = 'SPLIT' and the parts live in payment_split as
-- [{ "method": "UPI", "amount": 40000 }, { "method": "CASH", "amount": 30000 }] (paise).
ALTER TYPE "TenderType" ADD VALUE IF NOT EXISTS 'SPLIT';

ALTER TABLE "dine_orders" ADD COLUMN "payment_split" JSONB;
ALTER TABLE "bill_sales" ADD COLUMN "payment_split" JSONB;
