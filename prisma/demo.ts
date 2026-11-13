/**
 * Demo data (`npm run db:seed:demo`). For local evaluation only - do not run
 * against a production database.
 *
 * Creates three businesses through the same onboarding service the Super Admin
 * uses, so subscriptions, invoices, manager accounts and RLS behave exactly as
 * in production. Idempotent: a business whose code already exists is skipped.
 * Manager passwords are random and printed once.
 */
import { withPlatform, withTenant } from "../src/server/db";
import { token } from "../src/server/core/ids";
import type { z } from "zod";
import { createBusiness, newBusinessSchema } from "../src/server/core/tenancy";

type Demo = z.input<typeof newBusinessSchema>;

const paid = { markSetupPaid: true, markSubscriptionPaid: true } as const;

const BUSINESSES: Demo[] = [
  {
    // The example from the product brief: one hotel, two products, two plans.
    code: "SGV", name: "SGV Hotel", category: "HOTEL", ownerName: "S. G. Varma", phone: "+91 98450 00001", email: "owner@sgvhotel.example",
    address: "12 Lake Road", city: "Mysuru", state: "Karnataka", pincode: "570001",
    products: [
      { productCode: "stay", tier: "GROWTH", billingCycle: "ANNUAL", ...paid },
      { productCode: "dine", tier: "BASIC", billingCycle: "MONTHLY", ...paid },
    ],
    paymentMethod: "UPI", paymentReference: "DEMO-SGV",
  },
  {
    code: "SPICE", name: "Spice Route Restaurant", category: "RESTAURANT", ownerName: "Anita Rao", phone: "+91 98450 00002",
    address: "4 Market Street", city: "Bengaluru", state: "Karnataka", pincode: "560001",
    products: [{ productCode: "dine", tier: "GROWTH", billingCycle: "MONTHLY", ...paid }],
    paymentMethod: "CASH",
  },
  {
    code: "MART", name: "City Mart", category: "SUPERMARKET", ownerName: "Imran Khan", phone: "+91 98450 00003",
    address: "88 Main Road", city: "Hubballi", state: "Karnataka", pincode: "580020",
    // Setup fee left unpaid on purpose, so the billing screens have an open invoice.
    products: [{ productCode: "bill", tier: "BASIC", billingCycle: "ANNUAL", markSubscriptionPaid: true }],
    paymentMethod: "BANK_TRANSFER", paymentReference: "DEMO-MART",
  },
];

const MENU: Record<string, [name: string, rupees: number, veg: boolean][]> = {
  Starters: [["Paneer Tikka", 240, true], ["Gobi Manchurian", 180, true], ["Chicken 65", 260, false]],
  "Main Course": [["Dal Tadka", 190, true], ["Paneer Butter Masala", 270, true], ["Butter Chicken", 320, false], ["Veg Biryani", 220, true], ["Chicken Biryani", 290, false]],
  Breads: [["Butter Naan", 50, true], ["Tandoori Roti", 30, true]],
  Beverages: [["Fresh Lime Soda", 80, true], ["Masala Chai", 40, true], ["Filter Coffee", 50, true]],
};

async function seedDine(tenantId: string) {
  await withTenant(tenantId, async (db) => {
    if (await db.dineTable.count()) return;
    const branch = await db.branch.findFirstOrThrow({ where: { isMain: true } });
    await db.dineTable.createMany({
      data: Array.from({ length: 8 }, (_, i) => ({
        tenantId, branchId: branch.id, name: `T${i + 1}`, seats: i < 6 ? 4 : 6, area: i < 6 ? "Main hall" : "Family section", qrToken: token(18), sortOrder: i,
      })),
    });
    for (const [ci, [category, items]] of Object.entries(MENU).entries()) {
      const cat = await db.dineMenuCategory.create({ data: { tenantId, name: category, sortOrder: ci } });
      await db.dineMenuItem.createMany({
        data: items.map(([name, rupees, isVeg], i) => ({ tenantId, categoryId: cat.id, name, price: rupees * 100, taxRate: 500, isVeg, sortOrder: i })),
      });
    }
  });
}

async function seedStay(tenantId: string) {
  await withTenant(tenantId, async (db) => {
    if (await db.stayRoomType.count()) return;
    const branch = await db.branch.findFirstOrThrow({ where: { isMain: true } });
    const types: [name: string, rupees: number, rooms: string[]][] = [
      ["Standard", 2200, ["101", "102", "103", "104"]],
      ["Deluxe", 3500, ["201", "202", "203"]],
      ["Suite", 6000, ["301"]],
    ];
    for (const [name, rupees, rooms] of types) {
      const type = await db.stayRoomType.create({ data: { tenantId, name, baseRate: rupees * 100, maxAdults: name === "Suite" ? 3 : 2 } });
      await db.stayRoom.createMany({ data: rooms.map((number) => ({ tenantId, branchId: branch.id, roomTypeId: type.id, number, floor: number[0] })) });
    }
  });
}

async function seedBill(tenantId: string) {
  await withTenant(tenantId, async (db) => {
    if (await db.billProduct.count()) return;
    const branch = await db.branch.findFirstOrThrow({ where: { isMain: true } });
    const catalog: Record<string, [name: string, barcode: string, price: number, cost: number, gstPct: number, stock: number][]> = {
      Groceries: [["Basmati Rice 5 kg", "8901000000011", 650, 560, 5, 40], ["Toor Dal 1 kg", "8901000000028", 165, 140, 5, 60], ["Sunflower Oil 1 L", "8901000000035", 155, 138, 5, 48]],
      Beverages: [["Tea 500 g", "8901000000042", 270, 228, 5, 30], ["Instant Coffee 100 g", "8901000000059", 310, 262, 18, 4]],
      "Personal Care": [["Bath Soap (pack of 4)", "8901000000066", 150, 118, 18, 55], ["Toothpaste 150 g", "8901000000073", 110, 86, 18, 70]],
    };
    let n = 1;
    for (const [category, products] of Object.entries(catalog)) {
      const cat = await db.billCategory.create({ data: { tenantId, name: category } });
      for (const [name, barcode, price, cost, gstPct, stock] of products) {
        const p = await db.billProduct.create({
          data: { tenantId, categoryId: cat.id, sku: `SKU-${String(n++).padStart(4, "0")}`, barcode, name, price: price * 100, mrp: price * 100, costPrice: cost * 100, taxRate: gstPct * 100, reorderLevel: 10 },
        });
        await db.billStockLevel.create({ data: { tenantId, productId: p.id, branchId: branch.id, quantity: stock } });
      }
    }
  });
}

export async function seedDemo(log = console.log) {
  log("Seeding demo businesses...");
  for (const input of BUSINESSES) {
    const existing = await withPlatform((db) => db.tenant.findUnique({ where: { code: input.code } }));
    let tenantId = existing?.id;
    if (existing) {
      log(`  ${input.code}: already exists, skipped`);
    } else {
      const created = await withPlatform((db) => createBusiness(db, newBusinessSchema.parse(input), null));
      tenantId = created.tenantId;
      log(`  ${input.code}: ${input.name} - login ${created.managerUsername} / temporary password ${created.temporaryPassword}`);
    }
    for (const p of input.products) {
      if (p.productCode === "dine") await seedDine(tenantId!);
      if (p.productCode === "stay") await seedStay(tenantId!);
      if (p.productCode === "bill") await seedBill(tenantId!);
    }
  }
  log("Demo data ready. Passwords above are shown once; each manager sets a new one at first sign-in.");
}
