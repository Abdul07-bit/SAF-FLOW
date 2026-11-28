/**
 * SAF Flow product catalog - the single source of truth for
 *   products -> features (per tier) -> permissions -> system roles -> default plans.
 *
 * The seed writes this into the database (feature_catalog, permissions, roles,
 * role_permissions, plans, plan_features). At runtime, entitlements are always
 * read from the DATABASE, so the Super Admin can change plan features and
 * pricing without a deploy. This file only provides the defaults.
 *
 * Basic / Growth are NOT universal packages: every product defines its own
 * feature list for each tier.
 */

export const PRODUCT_CODES = ["dine", "stay", "bill"] as const;
export type ProductCode = (typeof PRODUCT_CODES)[number];
export type Tier = "BASIC" | "GROWTH";
export const TIERS: Tier[] = ["BASIC", "GROWTH"];

export function isProductCode(v: unknown): v is ProductCode {
  return typeof v === "string" && (PRODUCT_CODES as readonly string[]).includes(v);
}

export interface FeatureDef {
  /** Fully-qualified key, e.g. "dine.kds" */
  key: string;
  name: string;
  group: string;
  tier: Tier;
}

export interface PermissionDef {
  /** Fully-qualified key, e.g. "dine.kitchen.update" */
  key: string;
  name: string;
}

export interface RoleDef {
  code: string;
  name: string;
  description: string;
  /** Screen key the role lands on after opening the product ("" = dashboard). */
  home: string;
  /** Relative permission keys (without product prefix) or "*" for all. */
  permissions: string[] | "*";
}

export interface ProductTheme {
  brand: string;
  brandInk: string;
  brandSoft: string;
  accent: string;
  sidebar: string;
  sidebarInk: string;
  sidebarMuted: string;
}

/**
 * SAF brand palette, taken from the SAF logo (navy #031527 + teal #019a97).
 * Primary actions use a deeper teal so white text on buttons stays readable (4.85:1).
 * Every product and the platform admin share it.
 */
export const SAF_THEME: ProductTheme = {
  brand: "#017f7c",
  brandInk: "#ffffff",
  brandSoft: "#e3f4f3",
  accent: "#14c4bd",
  sidebar: "#031527",
  sidebarInk: "#e3edf2",
  sidebarMuted: "#8fa8ba",
};

export interface ProductDef {
  code: ProductCode;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  theme: ProductTheme;
  features: FeatureDef[];
  permissions: PermissionDef[];
  roles: RoleDef[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type F = [suffix: string, name: string, group: string];

function features(product: ProductCode, basic: F[], growth: F[]): FeatureDef[] {
  return [
    ...basic.map(([s, name, group]) => ({ key: `${product}.${s}`, name, group, tier: "BASIC" as Tier })),
    ...growth.map(([s, name, group]) => ({ key: `${product}.${s}`, name, group, tier: "GROWTH" as Tier })),
  ];
}

function perms(product: ProductCode, list: [string, string][]): PermissionDef[] {
  return list.map(([k, name]) => ({ key: `${product}.${k}`, name }));
}

/** Staff features shared by every product (each product gates them independently). */
const STAFF_BASIC: F[] = [["staff_logins", "Staff login management", "Team"]];

/** Day book (daily sales, expenses and order counts by business day) - every product, Basic. */
const DAYBOOK_BASIC: F[] = [["day_book", "Day book: daily sales, expenses and orders", "Reports"]];
/** Automatic end-of-day PDF report to the owner's WhatsApp - every product, Growth. */
const DAYBOOK_GROWTH: F[] = [["daily_report_whatsapp", "Daily closing report on WhatsApp (PDF)", "Reports"]];
const STAFF_GROWTH: F[] = [
  ["staff_management", "Staff management & employee database", "Team"],
  ["attendance", "Employee attendance", "Team"],
  ["staff_checkin", "Staff check-in / check-out", "Team"],
  ["shifts", "Shift scheduling", "Team"],
  ["id_cards", "Staff ID card generator", "Team"],
  ["qr_verification", "QR ID verification", "Team"],
];

/** Permissions every product has (relative keys). */
const SHARED_PERMS: [string, string][] = [
  ["dashboard.view", "View manager dashboard"],
  ["staff.manage", "Manage staff logins and roles"],
  ["employees.manage", "Manage employee records and ID cards"],
  ["attendance.self", "Check in / check out (own attendance)"],
  ["attendance.manage", "Manage attendance of all staff"],
  ["shifts.manage", "Manage shift schedules"],
  ["staff.verify", "Verify staff QR ID cards"],
  ["settings.manage", "Manage product settings and branches"],
  ["subscription.view", "View SAF subscription and billing"],
  ["support.use", "Raise and follow support tickets"],
];

// ---------------------------------------------------------------------------
// SAF DINE FLOW
// ---------------------------------------------------------------------------

const dine: ProductDef = {
  code: "dine",
  name: "SAF Dine Flow",
  shortName: "Dine Flow",
  tagline: "Restaurant & food-service management",
  description: "POS, QR ordering, tables, waiter app, kitchen display, cashier, menu and inventory for restaurants.",
  theme: SAF_THEME,
  features: features(
    "dine",
    [
      ["dashboard", "Restaurant dashboard", "Overview"],
      ["pos", "POS billing", "Sales"],
      ["qr_menu", "QR menu", "Ordering"],
      ["qr_ordering", "QR table ordering", "Ordering"],
      ["tables", "Table management", "Floor"],
      ["orders", "Order management", "Ordering"],
      ["waiter", "Waiter dashboard", "Floor"],
      ["kds", "Kitchen Display System", "Kitchen"],
      ["cashier", "Cashier dashboard", "Sales"],
      ["menu", "Menu management", "Menu"],
      ["products", "Product management", "Menu"],
      ["inventory_basic", "Basic inventory", "Inventory"],
      ["low_stock_alerts", "Low-stock alerts", "Inventory"],
      ["whatsapp_invoice", "WhatsApp invoice sharing", "Sales"],
      ["reports_basic", "Basic sales reports", "Reports"],
      ["expenses", "Daily expense management", "Accounts"],
      ...DAYBOOK_BASIC,
      ...STAFF_BASIC,
    ],
    [
      ...STAFF_GROWTH,
      ...DAYBOOK_GROWTH,
      ["inventory_advanced", "Advanced stock management", "Inventory"],
      ["ingredients", "Ingredient management", "Inventory"],
      ["auto_deduction", "Automatic ingredient deduction", "Inventory"],
      ["suppliers", "Supplier management", "Purchasing"],
      ["purchases", "Purchase management", "Purchasing"],
      ["supplier_credit", "Supplier credit & payables", "Purchasing"],
      ["wastage", "Wastage tracking", "Inventory"],
      ["analytics_advanced", "Advanced sales analytics", "Reports"],
    ],
  ),
  permissions: perms("dine", [
    ...SHARED_PERMS,
    ["pos.use", "Use POS billing"],
    ["orders.view", "View orders"],
    ["orders.manage", "Create and update orders, send KOTs"],
    ["tables.view", "View tables"],
    ["tables.manage", "Create and edit tables and QR codes"],
    ["kitchen.view", "View kitchen display"],
    ["kitchen.update", "Update kitchen ticket status"],
    ["billing.settle", "Settle bills and take payments"],
    ["billing.discount", "Apply discounts"],
    ["menu.view", "View menu"],
    ["menu.manage", "Manage menu, categories and products"],
    ["menu.availability", "Mark menu items available / sold out"],
    ["inventory.view", "View stock"],
    ["inventory.manage", "Manage stock, ingredients, recipes and wastage"],
    ["purchases.manage", "Manage suppliers and purchases"],
    ["payables.view", "View supplier balances, ledgers and credit reports"],
    ["payables.manage", "Record suppliers, credit purchases and supplier payments"],
    ["payables.adjust", "Cancel, reverse and adjust supplier transactions; supplier credit settings"],
    ["reports.view", "View sales reports"],
    ["analytics.view", "View advanced analytics"],
    ["expenses.manage", "Record shop expenses"],
  ]),
  roles: [
    { code: "manager", name: "Manager", description: "Full access to Dine Flow", home: "", permissions: "*" },
    {
      code: "waiter",
      name: "Waiter",
      description: "Takes table orders, sends KOTs, serves food",
      home: "waiter",
      permissions: ["orders.view", "orders.manage", "tables.view", "menu.view", "attendance.self"],
    },
    {
      code: "cashier",
      name: "Cashier",
      description: "POS billing, settles bills, collects payments",
      home: "cashier",
      permissions: [
        "pos.use", "orders.view", "orders.manage", "billing.settle", "billing.discount",
        "tables.view", "menu.view", "reports.view", "attendance.self",
      ],
    },
    {
      code: "kitchen",
      name: "Kitchen",
      description: "Kitchen display, ticket status, item availability",
      home: "kds",
      permissions: ["kitchen.view", "kitchen.update", "menu.view", "menu.availability", "inventory.view", "attendance.self"],
    },
  ],
};

// ---------------------------------------------------------------------------
// SAF STAY FLOW
// ---------------------------------------------------------------------------

const stay: ProductDef = {
  code: "stay",
  name: "SAF Stay Flow",
  shortName: "Stay Flow",
  tagline: "Hotel & accommodation management",
  description: "Rooms, reservations, front desk, guest profiles, housekeeping, room billing and occupancy reporting.",
  theme: SAF_THEME,
  features: features(
    "stay",
    [
      ["dashboard", "Hotel dashboard", "Overview"],
      ["room_types", "Room categories", "Rooms"],
      ["rooms", "Room management", "Rooms"],
      ["availability", "Room availability", "Rooms"],
      ["reservations", "Reservations", "Front office"],
      ["guest_registration", "Guest registration", "Guests"],
      ["guest_profiles", "Guest profiles", "Guests"],
      ["checkin_checkout", "Check-in / check-out", "Front office"],
      ["front_desk", "Front desk management", "Front office"],
      ["room_billing", "Room billing", "Billing"],
      ["invoices", "Invoice generation", "Billing"],
      ["expenses", "Basic expense management", "Billing"],
      ["occupancy_reports", "Occupancy reports", "Reports"],
      ["housekeeping_status", "Housekeeping status management", "Housekeeping"],
      ...DAYBOOK_BASIC,
      ...STAFF_BASIC,
    ],
    [
      ...STAFF_GROWTH,
      ...DAYBOOK_GROWTH,
      ["housekeeping_tasks", "Housekeeping task assignments", "Housekeeping"],
      ["maintenance", "Room maintenance management", "Housekeeping"],
      ["analytics_advanced", "Advanced occupancy analytics", "Reports"],
      ["revenue_reports", "Revenue reports", "Reports"],
      ["multi_branch", "Multiple branches", "Administration"],
      ["ops_reports", "Advanced operational reporting", "Reports"],
    ],
  ),
  permissions: perms("stay", [
    ...SHARED_PERMS,
    ["frontdesk.view", "Use the front desk"],
    ["reservations.view", "View reservations"],
    ["reservations.manage", "Create and modify reservations"],
    ["guests.view", "View guest profiles"],
    ["guests.manage", "Register and edit guests"],
    ["checkin.perform", "Check guests in and out"],
    ["rooms.view", "View rooms and availability"],
    ["rooms.manage", "Manage rooms and room categories"],
    ["billing.view", "View guest folios"],
    ["billing.manage", "Post charges and take payments"],
    ["invoices.view", "View and print invoices"],
    ["expenses.manage", "Record expenses"],
    ["housekeeping.view", "View housekeeping board"],
    ["housekeeping.update", "Update room cleaning status and own tasks"],
    ["housekeeping.assign", "Assign housekeeping tasks"],
    ["maintenance.view", "View maintenance records"],
    ["maintenance.report", "Report maintenance issues"],
    ["maintenance.update", "Work on maintenance jobs"],
    ["maintenance.manage", "Assign and close maintenance jobs"],
    ["reports.view", "View occupancy reports"],
    ["analytics.view", "View advanced analytics and revenue reports"],
  ]),
  roles: [
    { code: "manager", name: "Hotel Manager", description: "Full access to Stay Flow", home: "", permissions: "*" },
    {
      code: "receptionist",
      name: "Receptionist",
      description: "Front desk, reservations, guest registration, check-in/out",
      home: "front-desk",
      permissions: [
        "frontdesk.view", "reservations.view", "reservations.manage", "guests.view", "guests.manage",
        "checkin.perform", "rooms.view", "billing.view", "billing.manage", "invoices.view",
        "housekeeping.view", "maintenance.view", "maintenance.report", "attendance.self", "staff.verify",
      ],
    },
    {
      code: "housekeeping",
      name: "Housekeeping",
      description: "Room cleaning status and assigned tasks",
      home: "housekeeping",
      permissions: ["housekeeping.view", "housekeeping.update", "rooms.view", "maintenance.report", "attendance.self"],
    },
    {
      code: "cashier",
      name: "Cashier",
      description: "Guest folios, payments, invoices and expenses",
      home: "cashier",
      permissions: [
        "billing.view", "billing.manage", "invoices.view", "reservations.view", "guests.view",
        "expenses.manage", "reports.view", "attendance.self",
      ],
    },
    {
      code: "maintenance",
      name: "Maintenance Staff",
      description: "Room maintenance jobs",
      home: "maintenance",
      permissions: ["maintenance.view", "maintenance.report", "maintenance.update", "rooms.view", "housekeeping.view", "attendance.self"],
    },
  ],
};

// ---------------------------------------------------------------------------
// SAF BILL FLOW
// ---------------------------------------------------------------------------

const bill: ProductDef = {
  code: "bill",
  name: "SAF Bill Flow",
  shortName: "Bill Flow",
  tagline: "Retail billing & inventory",
  description: "Barcode POS billing, product catalog, stock, customers, purchases and sales reporting for shops.",
  theme: SAF_THEME,
  features: features(
    "bill",
    [
      ["dashboard", "Retail dashboard", "Overview"],
      ["pos", "POS billing", "Sales"],
      ["barcode", "Barcode scanning", "Sales"],
      ["catalog", "Product catalog", "Catalog"],
      ["categories", "Category management", "Catalog"],
      ["inventory", "Inventory management", "Inventory"],
      ["stock", "Stock management", "Inventory"],
      ["low_stock_alerts", "Low-stock alerts", "Inventory"],
      ["invoices", "Invoice generation", "Sales"],
      ["customers", "Customer records", "Customers"],
      ["purchase_records", "Purchase records", "Purchasing"],
      ["cashier", "Cashier dashboard", "Sales"],
      ["reports_basic", "Basic sales reports", "Reports"],
      ["expenses", "Daily expense management", "Accounts"],
      ...DAYBOOK_BASIC,
      ...STAFF_BASIC,
    ],
    [
      ...STAFF_GROWTH,
      ...DAYBOOK_GROWTH,
      ["inventory_advanced", "Advanced inventory", "Inventory"],
      ["suppliers", "Supplier management", "Purchasing"],
      ["purchase_management", "Purchase management", "Purchasing"],
      ["stock_adjustments", "Stock adjustment records", "Inventory"],
      ["analytics_advanced", "Advanced analytics", "Reports"],
      ["multi_counter", "Multiple POS counters", "Sales"],
      ["multi_branch", "Multi-branch management", "Administration"],
    ],
  ),
  permissions: perms("bill", [
    ...SHARED_PERMS,
    ["pos.use", "Use POS billing"],
    ["sales.view", "View sales and invoices"],
    ["sales.void", "Void sales"],
    ["products.view", "View products"],
    ["products.manage", "Manage products and categories"],
    ["inventory.view", "View stock"],
    ["inventory.manage", "Update stock and record adjustments"],
    ["customers.view", "View customers"],
    ["customers.manage", "Add and edit customers"],
    ["purchases.view", "View purchases"],
    ["purchases.manage", "Record purchases and receive stock"],
    ["suppliers.manage", "Manage suppliers"],
    ["counters.manage", "Manage POS counters"],
    ["reports.view", "View sales reports"],
    ["analytics.view", "View advanced analytics"],
    ["expenses.manage", "Record shop expenses"],
  ]),
  roles: [
    { code: "manager", name: "Store Manager", description: "Full access to Bill Flow", home: "", permissions: "*" },
    {
      code: "cashier",
      name: "Cashier",
      description: "POS billing and customer records",
      home: "pos",
      permissions: ["pos.use", "sales.view", "customers.view", "customers.manage", "products.view", "inventory.view", "attendance.self"],
    },
    {
      code: "inventory_staff",
      name: "Inventory Staff",
      description: "Products, stock levels and adjustments",
      home: "inventory",
      permissions: ["products.view", "products.manage", "inventory.view", "inventory.manage", "purchases.view", "attendance.self"],
    },
    {
      code: "storekeeper",
      name: "Storekeeper",
      description: "Receives stock, purchases and suppliers",
      home: "purchases",
      permissions: [
        "products.view", "inventory.view", "inventory.manage", "purchases.view", "purchases.manage",
        "suppliers.manage", "attendance.self",
      ],
    },
  ],
};

export const PRODUCTS: Record<ProductCode, ProductDef> = { dine, stay, bill };
export const PRODUCT_LIST: ProductDef[] = PRODUCT_CODES.map((c) => PRODUCTS[c]);

export const ALL_FEATURES: FeatureDef[] = PRODUCT_LIST.flatMap((p) => p.features);
export const ALL_PERMISSIONS: PermissionDef[] = PRODUCT_LIST.flatMap((p) => p.permissions);

export function roleDef(product: ProductCode, code: string): RoleDef | undefined {
  return PRODUCTS[product].roles.find((r) => r.code === code);
}

export function rolePermissionKeys(product: ProductCode, role: RoleDef): string[] {
  if (role.permissions === "*") return PRODUCTS[product].permissions.map((p) => p.key);
  return role.permissions.map((p) => `${product}.${p}`);
}

// ---------------------------------------------------------------------------
// Default pricing (paise). Configurable per product from Super Admin.
// ---------------------------------------------------------------------------

export const DEFAULT_PRICING: Record<Tier, { monthly: number; annual: number; setup: number }> = {
  BASIC: { monthly: 599_00, annual: 6_000_00, setup: 5_000_00 },
  GROWTH: { monthly: 1_799_00, annual: 18_000_00, setup: 10_000_00 },
};

export const DEFAULT_GRACE_DAYS = 7;

export const BUSINESS_CATEGORIES = [
  "RESTAURANT", "CAFE", "CLOUD_KITCHEN", "BAKERY", "HOTEL", "RESORT", "LODGE", "HOMESTAY",
  "RETAIL", "SUPERMARKET", "PHARMACY", "ELECTRONICS", "APPAREL", "OTHER",
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export interface BusinessTypeDef {
  label: string;
  group: "Food & beverage" | "Hospitality" | "Retail" | "Other";
  /** Products the onboarding wizard pre-selects for this type. */
  recommended: ProductCode[];
  /** What this type calls a branch ("outlet", "property", "store"). */
  branchNoun: string;
}

/**
 * Business-type registry. Drives onboarding defaults (recommended products,
 * branch wording) and grouping in the admin panel. Adding a type here and to
 * BUSINESS_CATEGORIES is enough: the column is free text, no migration needed.
 */
export const BUSINESS_TYPES: Record<BusinessCategory, BusinessTypeDef> = {
  RESTAURANT: { label: "Restaurant", group: "Food & beverage", recommended: ["dine", "bill"], branchNoun: "outlet" },
  CAFE: { label: "Cafe", group: "Food & beverage", recommended: ["dine", "bill"], branchNoun: "outlet" },
  CLOUD_KITCHEN: { label: "Cloud kitchen", group: "Food & beverage", recommended: ["dine"], branchNoun: "kitchen" },
  BAKERY: { label: "Bakery", group: "Food & beverage", recommended: ["bill", "dine"], branchNoun: "outlet" },
  HOTEL: { label: "Hotel", group: "Hospitality", recommended: ["stay", "dine"], branchNoun: "property" },
  RESORT: { label: "Resort", group: "Hospitality", recommended: ["stay", "dine"], branchNoun: "property" },
  LODGE: { label: "Lodge", group: "Hospitality", recommended: ["stay"], branchNoun: "property" },
  HOMESTAY: { label: "Homestay", group: "Hospitality", recommended: ["stay"], branchNoun: "property" },
  RETAIL: { label: "Retail store", group: "Retail", recommended: ["bill"], branchNoun: "store" },
  SUPERMARKET: { label: "Supermarket", group: "Retail", recommended: ["bill"], branchNoun: "store" },
  PHARMACY: { label: "Pharmacy", group: "Retail", recommended: ["bill"], branchNoun: "store" },
  ELECTRONICS: { label: "Electronics store", group: "Retail", recommended: ["bill"], branchNoun: "store" },
  APPAREL: { label: "Apparel store", group: "Retail", recommended: ["bill"], branchNoun: "store" },
  OTHER: { label: "Other", group: "Other", recommended: [], branchNoun: "branch" },
};

export function businessType(category: string | null | undefined): BusinessTypeDef {
  return BUSINESS_TYPES[(category ?? "OTHER") as BusinessCategory] ?? BUSINESS_TYPES.OTHER;
}

export const PLATFORM_THEME: ProductTheme = SAF_THEME;
