-- TOTP replay protection: the last accepted 30-second time step per user.
-- A code (or any code from an earlier step) can never be accepted twice.
ALTER TABLE "users" ADD COLUMN "mfa_last_step" BIGINT;
