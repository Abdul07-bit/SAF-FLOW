import {
  BadgeCheck, BarChart3, BedDouble, Boxes, Building2, CalendarClock, CalendarDays, CalendarRange, ChefHat, ClipboardList, ConciergeBell,
  CreditCard, FileText, Fingerprint, Gauge, History, IdCard, Landmark, LayoutDashboard, LifeBuoy, LineChart, ListChecks, MonitorSmartphone,
  Package, PackagePlus, PlusCircle, QrCode, Receipt, ScanBarcode, ScrollText, Settings, ShieldCheck, ShoppingCart, SlidersHorizontal, Sparkles, Store,
  Tags, Trash2, Truck, UserCog, Users, UsersRound, UtensilsCrossed, Wallet, Wrench, type LucideIcon,
} from "lucide-react";
import type { ProductCode } from "./catalog";

export interface NavItem {
  /** Screen slug under the application ("" = dashboard). */
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Any-of plan features (relative keys). Mirrors the API policy. */
  feature?: string | string[];
  /** Any-of role permissions (relative keys). */
  permission?: string | string[];
  /** Admin panel only: platform permission needed to see the item. */
  platform?: string;
}
export interface NavSection {
  title: string;
  items: NavItem[];
}

const TEAM: NavSection = {
  title: "Team",
  items: [
    { slug: "team", label: "Staff logins", icon: UserCog, feature: "staff_logins", permission: "staff.manage" },
    { slug: "employees", label: "Employees", icon: UsersRound, feature: "staff_management", permission: "employees.manage" },
    { slug: "attendance", label: "Attendance", icon: CalendarClock, feature: "attendance", permission: "attendance.manage" },
    { slug: "attendance-qr", label: "Attendance QR", icon: QrCode, feature: "staff_checkin", permission: "attendance.manage" },
    { slug: "my-attendance", label: "My attendance", icon: Fingerprint, feature: "staff_checkin", permission: "attendance.self" },
    { slug: "shifts", label: "Shifts & roster", icon: CalendarRange, feature: "shifts", permission: "shifts.manage" },
    { slug: "id-cards", label: "ID cards", icon: IdCard, feature: "id_cards", permission: "employees.manage" },
    { slug: "verify", label: "Verify staff ID", icon: BadgeCheck, feature: "qr_verification", permission: ["staff.verify", "attendance.manage"] },
  ],
};

const ACCOUNT: NavSection = {
  title: "Account",
  items: [
    { slug: "branches", label: "Branches", icon: Building2, feature: "multi_branch", permission: "settings.manage" },
    { slug: "settings", label: "Settings", icon: Settings, permission: "settings.manage" },
    { slug: "security", label: "Security Center", icon: ShieldCheck, permission: "staff.manage" },
    { slug: "subscription", label: "Subscription", icon: CreditCard, permission: "subscription.view" },
    { slug: "support", label: "Support", icon: LifeBuoy, permission: "support.use" },
  ],
};

export const PRODUCT_NAV: Record<ProductCode, NavSection[]> = {
  dine: [
    {
      title: "Service",
      items: [
        { slug: "", label: "Dashboard", icon: LayoutDashboard, feature: "dashboard", permission: "dashboard.view" },
        { slug: "pos", label: "POS billing", icon: MonitorSmartphone, feature: "pos", permission: "pos.use" },
        { slug: "waiter", label: "Waiter", icon: ConciergeBell, feature: "waiter", permission: "orders.manage" },
        { slug: "kds", label: "Kitchen display", icon: ChefHat, feature: "kds", permission: "kitchen.view" },
        { slug: "cashier", label: "Cashier", icon: Wallet, feature: "cashier", permission: "billing.settle" },
        { slug: "orders", label: "Orders", icon: ClipboardList, feature: "orders", permission: "orders.view" },
      ],
    },
    {
      title: "Menu & floor",
      items: [
        { slug: "tables", label: "Tables & QR", icon: UtensilsCrossed, feature: "tables", permission: "tables.manage" },
        { slug: "menu", label: "Menu", icon: ScrollText, feature: ["menu", "products"], permission: "menu.manage" },
      ],
    },
    {
      title: "Inventory",
      items: [
        { slug: "inventory", label: "Stock", icon: Boxes, feature: "inventory_basic", permission: "inventory.view" },
        { slug: "recipes", label: "Ingredients & recipes", icon: ListChecks, feature: "ingredients", permission: ["inventory.manage", "menu.manage"] },
        { slug: "suppliers", label: "Suppliers", icon: Truck, feature: "suppliers", permission: "purchases.manage" },
        { slug: "purchases", label: "Purchases", icon: PackagePlus, feature: "purchases", permission: "purchases.manage" },
        { slug: "wastage", label: "Wastage", icon: Trash2, feature: "wastage", permission: "inventory.manage" },
        { slug: "stock-ledger", label: "Stock ledger", icon: History, feature: "inventory_advanced", permission: "inventory.view" },
      ],
    },
    {
      title: "Insights",
      items: [
        { slug: "reports", label: "Sales reports", icon: BarChart3, feature: "reports_basic", permission: "reports.view" },
        { slug: "analytics", label: "Analytics", icon: LineChart, feature: "analytics_advanced", permission: "analytics.view" },
      ],
    },
    TEAM,
    ACCOUNT,
  ],
  stay: [
    {
      title: "Front office",
      items: [
        { slug: "", label: "Dashboard", icon: LayoutDashboard, feature: "dashboard", permission: "dashboard.view" },
        { slug: "front-desk", label: "Front desk", icon: ConciergeBell, feature: "front_desk", permission: "frontdesk.view" },
        { slug: "reservations", label: "Reservations", icon: CalendarDays, feature: "reservations", permission: "reservations.view" },
        { slug: "availability", label: "Availability", icon: CalendarRange, feature: "availability", permission: ["rooms.view", "reservations.view"] },
        { slug: "guests", label: "Guests", icon: Users, feature: ["guest_profiles", "guest_registration"], permission: "guests.view" },
      ],
    },
    {
      title: "Billing",
      items: [
        { slug: "cashier", label: "Cashier", icon: Wallet, feature: "room_billing", permission: "billing.view" },
        { slug: "invoices", label: "Invoices", icon: FileText, feature: "invoices", permission: "invoices.view" },
        { slug: "expenses", label: "Expenses", icon: Receipt, feature: "expenses", permission: "expenses.manage" },
      ],
    },
    {
      title: "Rooms",
      items: [
        { slug: "rooms", label: "Rooms & categories", icon: BedDouble, feature: ["rooms", "room_types"], permission: "rooms.manage" },
        { slug: "housekeeping", label: "Housekeeping", icon: Sparkles, feature: "housekeeping_status", permission: "housekeeping.view" },
        { slug: "maintenance", label: "Maintenance", icon: Wrench, feature: "maintenance", permission: ["maintenance.view", "maintenance.report"] },
      ],
    },
    {
      title: "Insights",
      items: [
        { slug: "reports", label: "Occupancy report", icon: BarChart3, feature: "occupancy_reports", permission: "reports.view" },
        { slug: "analytics", label: "Occupancy analytics", icon: LineChart, feature: "analytics_advanced", permission: "analytics.view" },
        { slug: "revenue", label: "Revenue report", icon: Landmark, feature: "revenue_reports", permission: "analytics.view" },
        { slug: "operations", label: "Operations report", icon: Gauge, feature: "ops_reports", permission: "analytics.view" },
      ],
    },
    TEAM,
    ACCOUNT,
  ],
  bill: [
    {
      title: "Sales",
      items: [
        { slug: "", label: "Dashboard", icon: LayoutDashboard, feature: "dashboard", permission: "dashboard.view" },
        { slug: "pos", label: "POS billing", icon: ScanBarcode, feature: "pos", permission: "pos.use" },
        { slug: "cashier", label: "My counter", icon: Wallet, feature: "cashier", permission: "pos.use" },
        { slug: "sales", label: "Invoices", icon: FileText, feature: "invoices", permission: "sales.view" },
        { slug: "customers", label: "Customers", icon: Users, feature: "customers", permission: "customers.view" },
      ],
    },
    {
      title: "Catalog & stock",
      items: [
        { slug: "products", label: "Products", icon: Tags, feature: "catalog", permission: "products.view" },
        { slug: "inventory", label: "Stock", icon: Boxes, feature: "inventory", permission: "inventory.view" },
        { slug: "purchases", label: "Purchases", icon: ShoppingCart, feature: ["purchase_records", "purchase_management"], permission: ["purchases.view", "purchases.manage"] },
        { slug: "suppliers", label: "Suppliers", icon: Truck, feature: "suppliers", permission: "suppliers.manage" },
        { slug: "adjustments", label: "Stock adjustments", icon: SlidersHorizontal, feature: "stock_adjustments", permission: "inventory.view" },
        { slug: "valuation", label: "Advanced inventory", icon: Package, feature: "inventory_advanced", permission: "inventory.view" },
        { slug: "counters", label: "POS counters", icon: Store, feature: "multi_counter", permission: "counters.manage" },
      ],
    },
    {
      title: "Insights",
      items: [
        { slug: "reports", label: "Sales reports", icon: BarChart3, feature: "reports_basic", permission: "reports.view" },
        { slug: "analytics", label: "Analytics", icon: LineChart, feature: "analytics_advanced", permission: "analytics.view" },
      ],
    },
    TEAM,
    ACCOUNT,
  ],
};

export const ADMIN_NAV: NavSection[] = [
  {
    title: "Platform",
    items: [
      { slug: "", label: "Overview", icon: LayoutDashboard, platform: "platform.dashboard.read" },
      { slug: "businesses", label: "Businesses", icon: Building2, platform: "platform.business.read" },
      { slug: "businesses/new", label: "Add business", icon: PlusCircle, platform: "platform.business.create" },
      { slug: "products", label: "Products & modules", icon: Package, platform: "platform.catalog.read" },
    ],
  },
  {
    title: "Commercial",
    items: [
      { slug: "subscriptions", label: "Subscriptions", icon: CalendarClock, platform: "platform.subscription.read" },
      { slug: "plans", label: "Plans and pricing", icon: Tags, platform: "platform.catalog.read" },
      { slug: "features", label: "Feature management", icon: SlidersHorizontal, platform: "platform.catalog.read" },
      { slug: "payments", label: "Payments", icon: CreditCard, platform: "platform.billing.read" },
      { slug: "revenue", label: "Revenue analytics", icon: LineChart, platform: "platform.revenue.read" },
    ],
  },
  {
    title: "SAF Team",
    items: [
      { slug: "team", label: "Team members", icon: UsersRound, platform: "platform.staff.read" },
      { slug: "roles", label: "Roles & permissions", icon: ShieldCheck, platform: "platform.staff.read" },
    ],
  },
  {
    title: "Client accounts",
    items: [
      { slug: "managers", label: "Owner accounts", icon: UserCog, platform: "platform.users.read" },
      { slug: "employees", label: "Client employees", icon: Users, platform: "platform.users.read" },
    ],
  },
  {
    title: "Operations",
    items: [
      { slug: "support", label: "Support center", icon: LifeBuoy, platform: "platform.support.read" },
      { slug: "security", label: "Security Center", icon: ShieldCheck, platform: "platform.security.read" },
      { slug: "audit", label: "Audit logs", icon: ScrollText, platform: "platform.audit.read" },
      { slug: "system", label: "System health", icon: Gauge, platform: "platform.settings.read" },
      { slug: "settings", label: "Settings", icon: Settings, platform: "platform.settings.read" },
    ],
  },
];
