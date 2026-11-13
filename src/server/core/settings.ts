import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ProductCode } from "@/config/catalog";
import type { Tx } from "../db";

// ---------------------------------------------------------------------------
// Platform (Super Admin) global settings
// ---------------------------------------------------------------------------

export const platformSettingsSchema = z.object({
  platformName: z.string().min(2).max(80),
  supportPhone: z.string().max(30),
  supportEmail: z.string().max(120),
  supportWhatsApp: z.string().max(30),
  companyAddress: z.string().max(300),
  companyGstin: z.string().max(20),
  invoicePrefix: z.string().min(1).max(10),
  /** GST charged on SAF subscription invoices, basis points. */
  gstRateBp: z.number().int().min(0).max(5000),
  /** Days before expiry on which renewal reminders are raised. */
  reminderDays: z.array(z.number().int().min(0).max(60)).max(6),
  /** Invoice payment terms in days. */
  invoiceDueDays: z.number().int().min(0).max(60),
  /** Allow tenants to pay renewal invoices online (needs Cashfree keys). */
  onlinePayments: z.boolean(),
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const PLATFORM_DEFAULTS: PlatformSettings = {
  platformName: "SAF Flow",
  supportPhone: "",
  supportEmail: "",
  supportWhatsApp: "",
  companyAddress: "",
  companyGstin: "",
  invoicePrefix: "SAF",
  gstRateBp: 1800,
  reminderDays: [15, 7, 3, 1],
  invoiceDueDays: 7,
  onlinePayments: true,
};

export async function getPlatformSettings(db: Tx): Promise<PlatformSettings> {
  const row = await db.platformSetting.findUnique({ where: { key: "general" } });
  return { ...PLATFORM_DEFAULTS, ...((row?.value as Partial<PlatformSettings>) ?? {}) };
}

export async function savePlatformSettings(db: Tx, patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const merged = platformSettingsSchema.parse({ ...(await getPlatformSettings(db)), ...patch });
  await db.platformSetting.upsert({
    where: { key: "general" },
    create: { key: "general", value: merged as Prisma.InputJsonValue },
    update: { value: merged as Prisma.InputJsonValue },
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Product-specific tenant settings
// ---------------------------------------------------------------------------

export const productSettingsSchemas = {
  dine: z.object({
    restaurantName: z.string().max(100).default(""),
    invoicePrefix: z.string().min(1).max(8).default("DF"),
    gstin: z.string().max(20).default(""),
    qrOrderingAutoAccept: z.boolean().default(false),
    receiptFooter: z.string().max(200).default("Thank you! Please visit again."),
  }),
  stay: z.object({
    hotelName: z.string().max(100).default(""),
    invoicePrefix: z.string().min(1).max(8).default("SF"),
    gstin: z.string().max(20).default(""),
    checkInTime: z.string().regex(/^\d{2}:\d{2}$/).default("12:00"),
    checkOutTime: z.string().regex(/^\d{2}:\d{2}$/).default("11:00"),
    /** GST on room tariff (12% for rooms under Rs 7,500 / night). */
    roomTaxBp: z.number().int().min(0).max(2800).default(1200),
    invoiceFooter: z.string().max(200).default("Thank you for staying with us."),
  }),
  bill: z.object({
    storeName: z.string().max(100).default(""),
    invoicePrefix: z.string().min(1).max(8).default("BF"),
    gstin: z.string().max(20).default(""),
    allowNegativeStock: z.boolean().default(false),
    receiptFooter: z.string().max(200).default("Thank you for shopping with us!"),
  }),
} as const;

export type ProductSettings<P extends ProductCode> = z.infer<(typeof productSettingsSchemas)[P]>;

export async function getProductSettings<P extends ProductCode>(db: Tx, tenantId: string, product: P): Promise<ProductSettings<P>> {
  const row = await db.tenantProductSetting.findUnique({ where: { tenantId_productCode: { tenantId, productCode: product } } });
  const schema = productSettingsSchemas[product];
  const parsed = schema.safeParse(row?.settings ?? {});
  return (parsed.success ? parsed.data : schema.parse({})) as ProductSettings<P>;
}

export async function saveProductSettings(db: Tx, tenantId: string, product: ProductCode, patch: Record<string, unknown>) {
  const current = await getProductSettings(db, tenantId, product);
  const merged = productSettingsSchemas[product].parse({ ...current, ...patch });
  await db.tenantProductSetting.upsert({
    where: { tenantId_productCode: { tenantId, productCode: product } },
    create: { tenantId, productCode: product, settings: merged as Prisma.InputJsonValue },
    update: { settings: merged as Prisma.InputJsonValue },
  });
  return merged;
}
