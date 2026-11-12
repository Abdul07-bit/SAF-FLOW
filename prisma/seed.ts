/**
 * Seed configuration. Idempotent - safe to run on every deploy.
 *
 *   npx tsx prisma/seed.ts           catalog, plans, roles, settings, Super Admin
 *   npx tsx prisma/seed.ts --demo    + demo businesses with sample data
 *
 * Catalog sync rules:
 *  - products / features / permissions / roles are upserted from src/config/catalog.ts
 *  - plans are created with DEFAULT_PRICING once; later runs never touch prices
 *    (the Super Admin owns pricing)
 *  - a plan receives a feature automatically only when the plan or the feature
 *    is new, so features an admin removed from a plan stay removed
 */
import {
  ALL_FEATURES, DEFAULT_GRACE_DAYS, DEFAULT_PRICING, PRODUCT_LIST, TIERS, rolePermissionKeys,
} from "../src/config/catalog";
import { prisma, withPlatform, type Tx } from "../src/server/db";
import { hashPassword } from "../src/server/auth/password";
import { normalizeUsername, temporaryPassword } from "../src/server/core/ids";
import { PLATFORM_DEFAULTS } from "../src/server/core/settings";
import { PLATFORM_PERMISSIONS, PLATFORM_ROLES } from "../src/config/platform";

export async function seedCatalog(db: Tx, log = console.log) {
  for (const [i, p] of PRODUCT_LIST.entries()) {
    await db.product.upsert({
      where: { code: p.code },
      create: { code: p.code, name: p.name, tagline: p.tagline, description: p.description, sortOrder: i },
      update: { sortOrder: i },
    });
  }

  const existingFeatures = new Set((await db.featureCatalog.findMany({ select: { key: true } })).map((f) => f.key));
  const newFeatureKeys = new Set<string>();
  for (const [i, f] of ALL_FEATURES.entries()) {
    if (!existingFeatures.has(f.key)) newFeatureKeys.add(f.key);
    const productCode = f.key.split(".")[0];
    await db.featureCatalog.upsert({
      where: { key: f.key },
      create: { key: f.key, productCode, name: f.name, groupName: f.group, defaultTier: f.tier, sortOrder: i },
      update: { name: f.name, groupName: f.group, defaultTier: f.tier, sortOrder: i },
    });
  }
  const catalogKeys = new Set(ALL_FEATURES.map((f) => f.key));
  const stale = [...existingFeatures].filter((k) => !catalogKeys.has(k));
  if (stale.length) await db.featureCatalog.deleteMany({ where: { key: { in: stale } } });

  const permKeys = new Set<string>();
  for (const p of PRODUCT_LIST) {
    for (const perm of p.permissions) {
      permKeys.add(perm.key);
      await db.permission.upsert({
        where: { key: perm.key },
        create: { key: perm.key, productCode: p.code, name: perm.name },
        update: { name: perm.name },
      });
    }
  }
  await db.permission.deleteMany({ where: { key: { notIn: [...permKeys] } } });

  for (const p of PRODUCT_LIST) {
    for (const r of p.roles) {
      const role = await db.role.upsert({
        where: { productCode_code: { productCode: p.code, code: r.code } },
        create: { productCode: p.code, code: r.code, name: r.name, description: r.description, homeScreen: r.home },
        update: { name: r.name, description: r.description, homeScreen: r.home },
      });
      await db.rolePermission.deleteMany({ where: { roleId: role.id } });
      await db.rolePermission.createMany({
        data: rolePermissionKeys(p.code, r).map((permissionKey) => ({ roleId: role.id, permissionKey })),
      });
    }

    for (const tier of TIERS) {
      const existing = await db.plan.findUnique({ where: { productCode_tier: { productCode: p.code, tier } } });
      const plan =
        existing ??
        (await db.plan.create({
          data: {
            productCode: p.code,
            tier,
            name: tier === "BASIC" ? "Basic" : "Growth",
            description: tier === "BASIC" ? `Essential ${p.shortName} operations` : `Everything in Basic plus staff management, advanced inventory and analytics`,
            monthlyPrice: DEFAULT_PRICING[tier].monthly,
            annualPrice: DEFAULT_PRICING[tier].annual,
            setupFee: DEFAULT_PRICING[tier].setup,
            graceDays: DEFAULT_GRACE_DAYS,
          },
        }));
      const eligible = p.features.filter((f) => tier === "GROWTH" || f.tier === "BASIC");
      const toAdd = eligible.filter((f) => !existing || newFeatureKeys.has(f.key));
      if (toAdd.length)
        await db.planFeature.createMany({ data: toAdd.map((f) => ({ planId: plan.id, featureKey: f.key })), skipDuplicates: true });
      if (!existing) log(`  plan ${p.code}/${tier} created with ${eligible.length} features`);
    }
  }

  await db.platformSetting.upsert({
    where: { key: "general" },
    create: { key: "general", value: PLATFORM_DEFAULTS },
    update: {},
  });
}

/**
 * Platform RBAC sync from src/config/platform.ts. Permissions are always
 * upserted. A role gets its default grants only while no administrator has
 * edited it (customized = false); SUPER_ADMIN always holds every permission.
 */
export async function seedPlatformRbac(db: Tx, log = console.log) {
  for (const perm of PLATFORM_PERMISSIONS) {
    await db.platformPermission.upsert({
      where: { key: perm.key }, create: perm, update: { area: perm.area, description: perm.description },
    });
  }
  for (const [i, r] of PLATFORM_ROLES.entries()) {
    const existing = await db.platformRole.findUnique({ where: { code: r.code } });
    if (existing?.customized && r.code !== "SUPER_ADMIN") continue;
    await db.platformRole.upsert({
      where: { code: r.code },
      create: { code: r.code, name: r.name, description: r.description, allTenants: r.allTenants, isSystem: r.isSystem, sortOrder: i + 1 },
      update: { name: r.name, description: r.description, allTenants: r.allTenants, isSystem: r.isSystem, sortOrder: i + 1 },
    });
    await db.platformRolePermission.deleteMany({ where: { roleCode: r.code } });
    await db.platformRolePermission.createMany({ data: r.permissions.map((permissionKey) => ({ roleCode: r.code, permissionKey })) });
  }
  log(`  platform RBAC: ${PLATFORM_PERMISSIONS.length} permissions, ${PLATFORM_ROLES.length} roles`);
}

export async function seedSuperAdmin(db: Tx, log = console.log) {
  const exists = await db.user.findFirst({ where: { kind: "PLATFORM" } });
  if (exists) return null;
  const username = normalizeUsername(process.env.SAF_ADMIN_USERNAME || "saf@admin");
  const provided = process.env.SAF_ADMIN_PASSWORD;
  const password = provided || temporaryPassword();
  await db.user.create({
    data: {
      kind: "PLATFORM", username, passwordHash: await hashPassword(password), fullName: "SAF Super Admin",
      platformRole: "SUPER_ADMIN", mustChangePassword: !provided,
    },
  });
  log(`\n  Super Admin created: ${username}`);
  if (!provided) log(`  Temporary password (shown once): ${password}\n`);
  return { username, password };
}

async function main() {
  const demo = process.argv.includes("--demo");
  console.log("Seeding SAF Flow catalog...");
  await withPlatform(async (db) => {
    await seedCatalog(db);
    await seedPlatformRbac(db);
    await seedSuperAdmin(db);
  });
  if (demo) {
    const { seedDemo } = await import("./demo");
    await seedDemo();
  }
  console.log("Seed complete.");
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
