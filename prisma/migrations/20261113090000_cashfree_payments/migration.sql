-- SAF Flow takes online payments through Cashfree. RAZORPAY stays in the enum
-- so historic rows remain valid; new gateway payments use CASHFREE.
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CASHFREE' BEFORE 'OTHER';
