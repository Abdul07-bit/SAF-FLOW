/**
 * Emergency recovery: issues a new temporary password for a Super Admin
 * account when nobody can sign in to /admin any more.
 *
 *   npx tsx scripts/reset-admin-password.ts              # the first Super Admin
 *   npx tsx scripts/reset-admin-password.ts saf@admin    # a specific one
 *
 * In Docker:
 *   docker compose --profile app run --rm migrate npx tsx scripts/reset-admin-password.ts
 *
 * The account is unlocked, all its sessions are signed out, and the new
 * password must be changed at the next sign-in. The reset is audit-logged.
 */
import { prisma, withPlatform } from "../src/server/db";
import { hashPassword } from "../src/server/auth/password";
import { revokeUserSessions } from "../src/server/auth/session";
import { writeAudit } from "../src/server/core/audit";
import { normalizeUsername, temporaryPassword } from "../src/server/core/ids";

const wanted = process.argv[2] ? normalizeUsername(process.argv[2]) : null;

withPlatform(async (db) => {
  const admin = await db.user.findFirst({
    where: { kind: "PLATFORM", ...(wanted ? { username: wanted } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) throw new Error(wanted ? `No Super Admin account named ${wanted}.` : "No Super Admin account exists. Run: npx tsx prisma/seed.ts");
  const password = temporaryPassword();
  await db.user.update({
    where: { id: admin.id },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true, isActive: true, failedLoginCount: 0, lockedUntil: null },
  });
  await revokeUserSessions(db, admin.id);
  await writeAudit(db, { action: "admin.user.reset_password", entityType: "user", entityId: admin.id, meta: { via: "cli" } });
  return { username: admin.username, password };
})
  .then(({ username, password }) => {
    console.log(`Login ID: ${username}`);
    console.log(`Temporary password (shown once): ${password}`);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
