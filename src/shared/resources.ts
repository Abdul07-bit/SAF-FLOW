import { f, type ResourceDef } from "./fields";

const TENDERS = ["CASH", "UPI", "CARD", "WALLET", "CREDIT", "OTHER"] as const;
export const ID_TYPES = ["AADHAAR", "PASSPORT", "DRIVING_LICENSE", "VOTER_ID", "PAN", "OTHER"] as const;
export const EXPENSE_CATEGORIES = ["UTILITIES", "SUPPLIES", "MAINTENANCE", "SALARY", "LAUNDRY", "FOOD", "MARKETING", "RENT", "OTHER"] as const;
export const UNITS = ["pcs", "kg", "g", "l", "ml", "box", "pack", "dozen", "bottle", "plate"] as const;

// ---------------------------------------------------------------------------
// Dine Flow
// ---------------------------------------------------------------------------

export const dineTables: ResourceDef = {
  key: "dine.tables", product: "dine", api: "/dine/tables", title: "Tables", singular: "Table",
  fields: {
    name: f.text("Table name / number", { required: true, max: 40, placeholder: "T1" }),
    seats: f.int("Seats", { min: 1, max: 50, default: 4 }),
    area: f.text("Area / section", { max: 40, placeholder: "Indoor, Terrace..." }),
    sortOrder: f.int("Display order", { default: 0, min: 0, max: 9999 }),
  },
  columns: [
    { key: "name", label: "Table" }, { key: "seats", label: "Seats" }, { key: "area", label: "Area" },
    { key: "status", label: "Status", type: "status" },
  ],
  read: { feature: ["tables", "waiter", "pos", "cashier", "orders"], permission: ["tables.view", "pos.use", "orders.view"] },
  write: { feature: "tables", permission: "tables.manage" },
  branchScoped: true, softDelete: true, search: ["name", "area"],
};

export const dineCategories: ResourceDef = {
  key: "dine.categories", product: "dine", api: "/dine/menu-categories", title: "Menu categories", singular: "Category",
  fields: {
    name: f.text("Category name", { required: true, max: 60 }),
    sortOrder: f.int("Display order", { default: 0, min: 0, max: 9999 }),
  },
  columns: [{ key: "name", label: "Category" }, { key: "sortOrder", label: "Order" }],
  read: { feature: ["menu", "pos", "waiter", "products"], permission: ["menu.view", "pos.use"] },
  write: { feature: "menu", permission: "menu.manage" },
  softDelete: true, search: ["name"],
};

export const dineMenuItems: ResourceDef = {
  key: "dine.menu_items", product: "dine", api: "/dine/menu-items", title: "Menu items", singular: "Menu item",
  fields: {
    name: f.text("Item name", { required: true, max: 80 }),
    categoryId: f.ref("Category", "/dine/menu-categories", "name", { required: true }),
    price: f.money("Price (before tax)", { required: true }),
    taxRate: f.percent("GST %", { default: 500 }),
    isVeg: f.bool("Vegetarian", { default: true }),
    isAvailable: f.bool("Available now", { default: true }),
    prepMinutes: f.int("Prep time (min)", { default: 15, min: 0, max: 240 }),
    description: f.textarea("Description", { max: 300 }),
    stockItemId: f.ref("Linked stock product", "/dine/stock-items", "name", {
      feature: "products", help: "Packaged product: 1 unit of this stock item is deducted per sale.",
    }),
    sortOrder: f.int("Display order", { default: 0, min: 0, max: 9999 }),
  },
  columns: [
    { key: "name", label: "Item" }, { key: "category.name", label: "Category" },
    { key: "price", label: "Price", type: "money" }, { key: "taxRate", label: "GST", type: "percent" },
    { key: "isVeg", label: "Veg", type: "bool" }, { key: "isAvailable", label: "Available", type: "bool" },
  ],
  read: { feature: ["menu", "pos", "waiter", "cashier", "kds", "products"], permission: ["menu.view", "pos.use"] },
  write: { feature: ["menu", "products"], permission: "menu.manage" },
  softDelete: true, search: ["name", "description"],
};

export const dineStockItems: ResourceDef = {
  key: "dine.stock", product: "dine", api: "/dine/stock-items", title: "Stock items", singular: "Stock item",
  description: "Ingredients and packaged products. Opening quantity is set on creation; later changes use Adjust stock.",
  fields: {
    name: f.text("Name", { required: true, max: 80 }),
    kind: f.select("Type", ["INGREDIENT", "PRODUCT"], { default: "INGREDIENT" }),
    unit: f.select("Unit", UNITS, { default: "pcs" }),
    quantity: f.number("Opening quantity", { min: 0, default: 0, createOnly: true, help: "Later changes go through Adjust stock." }),
    reorderLevel: f.number("Low-stock alert at", { min: 0, default: 0 }),
    costPerUnit: f.money("Cost per unit"),
    supplierId: f.ref("Preferred supplier", "/dine/suppliers", "name", { feature: "suppliers" }),
  },
  columns: [
    { key: "name", label: "Item" }, { key: "kind", label: "Type", type: "badge" },
    { key: "quantity", label: "In stock", type: "number" }, { key: "unit", label: "Unit" },
    { key: "reorderLevel", label: "Alert at", type: "number" }, { key: "costPerUnit", label: "Cost/unit", type: "money" },
  ],
  read: { feature: ["inventory_basic", "products", "ingredients"], permission: ["inventory.view", "menu.manage"] },
  write: { feature: "inventory_basic", permission: "inventory.manage" },
  softDelete: true, search: ["name"],
};

export const dineSuppliers: ResourceDef = {
  key: "dine.suppliers", product: "dine", api: "/dine/suppliers", title: "Suppliers", singular: "Supplier",
  fields: {
    name: f.text("Supplier name", { required: true, max: 100 }),
    contactPerson: f.text("Contact person", { max: 80 }),
    phone: f.phone("Phone"),
    email: f.email("Email"),
    gstin: f.text("GSTIN", { max: 20 }),
    address: f.textarea("Address", { max: 300 }),
  },
  columns: [
    { key: "name", label: "Supplier" }, { key: "contactPerson", label: "Contact" }, { key: "phone", label: "Phone" },
    { key: "gstin", label: "GSTIN" },
  ],
  read: { feature: ["suppliers", "purchases"], permission: "purchases.manage" },
  write: { feature: "suppliers", permission: "purchases.manage" },
  softDelete: true, search: ["name", "contactPerson", "phone"],
};

// ---------------------------------------------------------------------------
// Stay Flow
// ---------------------------------------------------------------------------

export const stayRoomTypes: ResourceDef = {
  key: "stay.room_types", product: "stay", api: "/stay/room-types", title: "Room categories", singular: "Room category",
  fields: {
    name: f.text("Category name", { required: true, max: 60, placeholder: "Deluxe Double" }),
    baseRate: f.money("Rate per night", { required: true }),
    maxAdults: f.int("Max adults", { min: 1, max: 20, default: 2 }),
    maxChildren: f.int("Max children", { min: 0, max: 20, default: 1 }),
    amenities: f.tags("Amenities", { placeholder: "AC, WiFi, TV" }),
    description: f.textarea("Description", { max: 500 }),
  },
  columns: [
    { key: "name", label: "Category" }, { key: "baseRate", label: "Rate / night", type: "money" },
    { key: "maxAdults", label: "Adults" }, { key: "maxChildren", label: "Children" }, { key: "amenities", label: "Amenities", type: "tags" },
  ],
  read: {
    feature: ["room_types", "rooms", "reservations", "availability", "front_desk"],
    permission: ["rooms.view", "reservations.view", "frontdesk.view"],
  },
  write: { feature: "room_types", permission: "rooms.manage" },
  softDelete: true, search: ["name"],
};

export const stayRooms: ResourceDef = {
  key: "stay.rooms", product: "stay", api: "/stay/rooms", title: "Rooms", singular: "Room",
  fields: {
    number: f.text("Room number", { required: true, max: 20 }),
    roomTypeId: f.ref("Room category", "/stay/room-types", "name", { required: true }),
    floor: f.text("Floor", { max: 20 }),
    notes: f.textarea("Notes", { max: 300 }),
  },
  columns: [
    { key: "number", label: "Room" }, { key: "roomType.name", label: "Category" }, { key: "floor", label: "Floor" },
    { key: "status", label: "Status", type: "status" }, { key: "hkStatus", label: "Housekeeping", type: "status" },
  ],
  read: {
    feature: ["rooms", "housekeeping_status", "front_desk", "availability", "reservations", "maintenance"],
    permission: ["rooms.view", "housekeeping.view", "frontdesk.view"],
  },
  write: { feature: "rooms", permission: "rooms.manage" },
  branchScoped: true, softDelete: true, search: ["number", "floor"],
};

export const stayGuests: ResourceDef = {
  key: "stay.guests", product: "stay", api: "/stay/guests", title: "Guests", singular: "Guest",
  fields: {
    fullName: f.text("Full name", { required: true, max: 100 }),
    phone: f.phone("Phone", { required: true }),
    email: f.email("Email"),
    idType: f.select("ID proof type", ID_TYPES),
    idNumber: f.text("ID number", { max: 40 }),
    nationality: f.text("Nationality", { max: 40, default: "Indian" }),
    city: f.text("City", { max: 60 }),
    address: f.textarea("Address", { max: 300 }),
    company: f.text("Company", { max: 100 }),
    gstin: f.text("Company GSTIN", { max: 20 }),
    isVip: f.bool("VIP guest"),
    notes: f.textarea("Preferences / notes", { max: 500 }),
  },
  columns: [
    { key: "fullName", label: "Guest" }, { key: "phone", label: "Phone" }, { key: "city", label: "City" },
    { key: "idType", label: "ID", type: "badge" }, { key: "isVip", label: "VIP", type: "bool" },
  ],
  read: {
    feature: ["guest_profiles", "guest_registration", "reservations", "front_desk"],
    permission: ["guests.view", "reservations.view"],
  },
  write: { feature: ["guest_registration", "guest_profiles"], permission: "guests.manage" },
  search: ["fullName", "phone", "email", "idNumber"],
};

export const stayExpenses: ResourceDef = {
  key: "stay.expenses", product: "stay", api: "/stay/expenses", title: "Expenses", singular: "Expense",
  fields: {
    expenseDate: f.date("Date", { required: true }),
    category: f.select("Category", EXPENSE_CATEGORIES, { required: true }),
    description: f.text("Description", { required: true, max: 200 }),
    amount: f.money("Amount", { required: true }),
    method: f.select("Paid by", TENDERS, { default: "CASH" }),
    paidTo: f.text("Paid to", { max: 100 }),
  },
  columns: [
    { key: "expenseDate", label: "Date", type: "date" }, { key: "category", label: "Category", type: "badge" },
    { key: "description", label: "Description" }, { key: "amount", label: "Amount", type: "money" },
    { key: "method", label: "Method" }, { key: "paidTo", label: "Paid to" },
  ],
  read: { feature: "expenses", permission: "expenses.manage" },
  write: { feature: "expenses", permission: "expenses.manage" },
  branchScoped: true, search: ["description", "paidTo"],
};

// ---------------------------------------------------------------------------
// Bill Flow
// ---------------------------------------------------------------------------

export const billCategories: ResourceDef = {
  key: "bill.categories", product: "bill", api: "/bill/categories", title: "Categories", singular: "Category",
  fields: { name: f.text("Category name", { required: true, max: 60 }) },
  columns: [{ key: "name", label: "Category" }],
  read: { feature: ["catalog", "categories", "pos"], permission: ["products.view", "pos.use"] },
  write: { feature: "categories", permission: "products.manage" },
  softDelete: true, search: ["name"],
};

export const billProducts: ResourceDef = {
  key: "bill.products", product: "bill", api: "/bill/products", title: "Products", singular: "Product",
  fields: {
    name: f.text("Product name", { required: true, max: 120 }),
    sku: f.text("SKU / item code", { required: true, max: 40 }),
    barcode: f.text("Barcode", { max: 40, help: "Scan with a barcode reader into this box." }),
    categoryId: f.ref("Category", "/bill/categories", "name"),
    unit: f.select("Unit", UNITS, { default: "pcs" }),
    price: f.money("Selling price (before tax)", { required: true }),
    mrp: f.money("MRP"),
    costPrice: f.money("Cost price"),
    taxRate: f.percent("GST %", { default: 0 }),
    hsn: f.text("HSN code", { max: 12 }),
    reorderLevel: f.number("Low-stock alert at", { min: 0, default: 0 }),
    openingStock: f.number("Opening stock", { min: 0, default: 0, createOnly: true, help: "Later changes go through Stock in or adjustments." }),
  },
  columns: [
    { key: "name", label: "Product" }, { key: "sku", label: "SKU" }, { key: "barcode", label: "Barcode" },
    { key: "category.name", label: "Category" }, { key: "price", label: "Price", type: "money" },
    { key: "taxRate", label: "GST", type: "percent" }, { key: "stock", label: "Stock", type: "number" },
  ],
  read: { feature: ["catalog", "pos", "inventory"], permission: ["products.view", "pos.use", "inventory.view"] },
  write: { feature: "catalog", permission: "products.manage" },
  softDelete: true, search: ["name", "sku", "barcode"],
};

export const billCustomers: ResourceDef = {
  key: "bill.customers", product: "bill", api: "/bill/customers", title: "Customers", singular: "Customer",
  fields: {
    name: f.text("Name", { required: true, max: 100 }),
    phone: f.phone("Phone", { required: true }),
    email: f.email("Email"),
    gstin: f.text("GSTIN", { max: 20 }),
    address: f.textarea("Address", { max: 300 }),
    notes: f.textarea("Notes", { max: 300 }),
  },
  columns: [
    { key: "name", label: "Customer" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
    { key: "gstin", label: "GSTIN" },
  ],
  read: { feature: ["customers", "pos"], permission: ["customers.view", "pos.use"] },
  write: { feature: "customers", permission: "customers.manage" },
  search: ["name", "phone", "email"],
};

export const billSuppliers: ResourceDef = {
  ...dineSuppliers,
  key: "bill.suppliers", product: "bill", api: "/bill/suppliers",
  read: { feature: ["suppliers", "purchase_management"], permission: ["suppliers.manage", "purchases.manage"] },
  write: { feature: "suppliers", permission: "suppliers.manage" },
};

export const billCounters: ResourceDef = {
  key: "bill.counters", product: "bill", api: "/bill/counters", title: "POS counters", singular: "Counter",
  fields: { name: f.text("Counter name", { required: true, max: 40 }) },
  columns: [{ key: "name", label: "Counter" }],
  read: { feature: ["pos", "multi_counter"], permission: ["pos.use", "counters.manage"] },
  write: { feature: "multi_counter", permission: "counters.manage" },
  branchScoped: true, softDelete: true,
};

// ---------------------------------------------------------------------------
// Shared, mounted under every product (/:product/...)
// ---------------------------------------------------------------------------

export const branches: ResourceDef = {
  key: "core.branches", product: ":product", api: "/:product/branches", title: "Branches", singular: "Branch",
  fields: {
    name: f.text("Branch name", { required: true, max: 80 }),
    code: f.text("Branch code", { required: true, max: 12, placeholder: "BLR2" }),
    phone: f.phone("Phone"),
    address: f.textarea("Address", { max: 300 }),
  },
  columns: [{ key: "name", label: "Branch" }, { key: "code", label: "Code" }, { key: "phone", label: "Phone" }, { key: "isMain", label: "Main", type: "bool" }],
  read: { feature: "multi_branch", permission: "settings.manage" },
  write: { feature: "multi_branch", permission: "settings.manage" },
  softDelete: true, search: ["name", "code"],
};

export const shifts: ResourceDef = {
  key: "core.shifts", product: ":product", api: "/:product/staff/shifts", title: "Shifts", singular: "Shift",
  fields: {
    name: f.text("Shift name", { required: true, max: 40, placeholder: "Morning" }),
    startTime: f.time("Starts", { required: true, default: "09:00" }),
    endTime: f.time("Ends", { required: true, default: "17:00" }),
    graceMinutes: f.int("Late after (grace min)", { default: 10, min: 0, max: 120 }),
  },
  columns: [
    { key: "name", label: "Shift" }, { key: "startTime", label: "Starts" }, { key: "endTime", label: "Ends" },
    { key: "graceMinutes", label: "Grace (min)" },
  ],
  read: { feature: ["shifts", "attendance", "staff_checkin"], permission: ["shifts.manage", "attendance.manage", "attendance.self"] },
  write: { feature: "shifts", permission: "shifts.manage" },
  softDelete: true,
};

export const RESOURCES: ResourceDef[] = [
  dineTables, dineCategories, dineMenuItems, dineStockItems, dineSuppliers,
  stayRoomTypes, stayRooms, stayGuests, stayExpenses,
  billCategories, billProducts, billCustomers, billSuppliers, billCounters,
  branches, shifts,
];
