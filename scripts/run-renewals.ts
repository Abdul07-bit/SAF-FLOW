/**
 * Runs the renewal job once, directly against the database:
 *   - expires subscriptions whose grace period has ended
 *   - raises renewal invoices and sends renewal reminders
 *
 *   npm run jobs:renewals
 *
 * Use this from a host cron / Task Scheduler when you are not running the
 * `cron` container (which calls POST /api/jobs/renewals instead). Safe to run
 * repeatedly: reminders are sent at most once a day per subscription and an
 * open renewal invoice is never duplicated.
 */
import { prisma, withPlatform } from "../src/server/db";
import { writeAudit } from "../src/server/core/audit";
import { runRenewalJob } from "../src/server/core/subscriptions";

withPlatform(async (db) => {
  const result = await runRenewalJob(db);
  await writeAudit(db, { action: "jobs.renewals", meta: { ...result, via: "cli" } });
  return result;
})
  .then((r) => console.log(`Renewal job: ${r.expired} expired, ${r.invoicesRaised} invoice(s) raised, ${r.reminders} reminder(s) sent.`))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
