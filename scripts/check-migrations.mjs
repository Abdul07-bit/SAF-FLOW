#!/usr/bin/env node
/**
 * Migration safety gate (CI). Fails when a migration contains a destructive
 * statement that could lose customer data, unless the statement's line (or the
 * line above it) carries an explicit, reviewed marker:
 *
 *   -- saf:allow-destructive <reason>
 *
 * Also fails when a migration creates a table with a tenant_id column but
 * never enables Row-Level Security on it (every tenant table must be isolated).
 * Usage: node scripts/check-migrations.mjs [migrationsDir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] || "prisma/migrations";
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bDROP\s+POLICY\b(?![\s\S]*CREATE\s+POLICY)/i,
  /\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
  /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i,
];

/**
 * Already-applied migrations reviewed during the security audit (2026-11-13).
 * They cannot be edited (Prisma checksums), so their reviewed statements are
 * listed here instead of carrying the inline marker. Never add new entries:
 * new migrations use the inline marker so the reason sits next to the SQL.
 */
const REVIEWED = {
  // Drops tenant_isolation and immediately recreates it, widened to the SAF Team staff scope.
  "20261112100000_saf_flow_foundation": [331],
};

const problems = [];
const all = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).sort();
const rlsEnabled = new Set();
const tenantTables = new Map();

for (const m of all) {
  const file = path.join(dir, m, "migration.sql");
  let sql;
  try {
    sql = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = sql.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/--.*$/, "");
    if (!code.trim()) return;
    const allowed = /saf:allow-destructive\s+\S+/.test(line) || /saf:allow-destructive\s+\S+/.test(lines[i - 1] ?? "") || (REVIEWED[m] ?? []).includes(i + 1);
    for (const re of DESTRUCTIVE) {
      if (re.test(code) && !allowed) problems.push(`${m}:${i + 1}: destructive statement without "-- saf:allow-destructive <reason>": ${code.trim().slice(0, 120)}`);
    }
  });
  // RLS bookkeeping (static: explicit ALTER TABLE ... ENABLE and the array-driven DO blocks).
  for (const t of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+ENABLE ROW LEVEL SECURITY/gi)) rlsEnabled.add(t[1]);
  for (const arr of sql.matchAll(/FOREACH\s+t\s+IN\s+ARRAY\s+ARRAY\[([\s\S]*?)\][\s\S]*?ENABLE ROW LEVEL SECURITY/gi))
    for (const t of arr[1].matchAll(/'(\w+)'/g)) rlsEnabled.add(t[1]);
  for (const ct of sql.matchAll(/CREATE TABLE\s+"(\w+)"\s*\(([\s\S]*?)\n\);/gi))
    if (/"tenant_id"/.test(ct[2])) tenantTables.set(ct[1], m);
}

for (const [t, m] of tenantTables) {
  if (!rlsEnabled.has(t)) problems.push(`${m}: table "${t}" has tenant_id but Row-Level Security is never enabled for it`);
}

if (problems.length) {
  console.error(`Migration safety check failed (${problems.length}):\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`Migration safety check passed: ${all.length} migrations, ${tenantTables.size} tenant tables all under RLS.`);
