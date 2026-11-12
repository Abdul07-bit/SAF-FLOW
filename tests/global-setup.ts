import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { TEST_ENV } from "./env";

/**
 * Brings the test database up to date (non-destructive `migrate deploy`) and
 * seeds the catalog. Tests create their own uniquely-coded businesses, so they
 * never depend on a wiped database. To start completely fresh, drop and
 * recreate the saf_test database yourself (see docs/TESTING.md).
 */
export default function setup() {
  const env = { ...process.env, ...TEST_ENV };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { env, stdio: "pipe" });
  rmSync("./storage-test", { recursive: true, force: true });
}
