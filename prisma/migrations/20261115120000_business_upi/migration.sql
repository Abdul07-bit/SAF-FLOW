-- Each business can collect customer payments by UPI: its own UPI ID (a QR
-- with the bill amount is generated) and/or an uploaded QR image.
ALTER TABLE "businesses"
  ADD COLUMN "upi_id" TEXT,
  ADD COLUMN "upi_payee_name" TEXT,
  ADD COLUMN "upi_qr_key" TEXT;
