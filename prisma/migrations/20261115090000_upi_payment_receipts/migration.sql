-- SAF Flow takes payments by UPI transfer to SAF's own UPI ID (no gateway).
-- The business uploads a screenshot + UPI reference (UTR); a Super Admin
-- checks it against the bank statement and approves or rejects it.
ALTER TABLE "payments"
  ADD COLUMN "receipt_key" TEXT,
  ADD COLUMN "review_note" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMP(3);

-- At most one receipt waiting for review per invoice (blocks double submits).
CREATE UNIQUE INDEX "payments_one_pending_receipt"
  ON "payments" ("invoice_id")
  WHERE "status" = 'PENDING' AND "receipt_key" IS NOT NULL;

-- The same UPI reference can only settle one payment.
CREATE UNIQUE INDEX "payments_upi_reference_once"
  ON "payments" ("reference")
  WHERE "method" = 'UPI' AND "receipt_key" IS NOT NULL AND "status" <> 'FAILED';
