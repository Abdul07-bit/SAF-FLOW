/** Environment for the automated tests (separate saf_test database). */
export const TEST_ENV: Record<string, string> = {
  DATABASE_URL: process.env.TEST_DATABASE_URL || "postgresql://saf_app:saf_app_dev_password@localhost:5433/saf_test?schema=public",
  DIRECT_URL: process.env.TEST_DIRECT_URL || "postgresql://saf_owner:saf_owner_dev_password@localhost:5433/saf_test?schema=public",
  APP_URL: "http://localhost:3000",
  SAF_ADMIN_USERNAME: "saf@admin",
  SAF_ADMIN_PASSWORD: "AdminPass123",
  SAF_DISABLE_RATE_LIMIT: "1",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./storage-test",
  CRON_SECRET: "test-cron-secret-0123456789",
  CASHFREE_CLIENT_ID: "cf_test_client",
  CASHFREE_CLIENT_SECRET: "cf_test_secret",
  CASHFREE_ENV: "sandbox",
  LOGIN_MAX_FAILURES: "5",
  LOGIN_LOCK_MINUTES: "15",
};
