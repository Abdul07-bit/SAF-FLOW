"use client";

/**
 * Screen registry: maps "<product>/<slug>" to its component. Screens shared
 * by every product use a star as the product (see the first block below).
 * The slugs match src/config/nav.tsx.
 * Access is decided by ProductApp from the nav item's feature / permission and,
 * independently, by every API route the screen calls.
 */
import type { ScreenComponent } from "@/components/product-app";
import { BillCashier, BillCustomers, BillDashboard, BillPos, BillSales } from "./bill-sales";
import { BillAdjustments, BillAnalytics, BillCounters, BillInventory, BillProducts, BillPurchases, BillReports, BillSuppliers, BillValuation } from "./bill-stock";
import { DineAnalytics, DineInventory, DineMenu, DinePurchases, DineRecipes, DineReports, DineStockLedger, DineSuppliers, DineTables, DineWastage } from "./dine-manage";
import { DineCashier, DineDashboard, DineKds, DineOrders, DinePos, DineWaiter } from "./dine-service";
import { BranchesScreen, SettingsScreen, SubscriptionScreen, SupportScreen } from "./shared-account";
import { AttendanceScreen, AttendanceStationScreen, EmployeesScreen, IdCardsScreen, MyAttendanceScreen, ShiftsScreen, TeamScreen, VerifyScreen } from "./shared-team";
import { StayAvailability, StayCashier, StayDashboard, StayFrontDesk, StayInvoices, StayReservations } from "./stay-front";
import { SecurityScreen } from "./security-center";
import { DayBookScreen, ExpensesScreen } from "./shared-daybook";
import { StayAnalytics, StayExpenses, StayGuests, StayHousekeeping, StayMaintenance, StayOperations, StayReports, StayRevenue, StayRooms } from "./stay-ops";

export const SCREENS: Record<string, ScreenComponent> = {
  // Shared by all three applications
  "*/team": TeamScreen,
  "*/employees": EmployeesScreen,
  "*/attendance": AttendanceScreen,
  "*/my-attendance": MyAttendanceScreen,
  "*/attendance-qr": AttendanceStationScreen,
  "*/shifts": ShiftsScreen,
  "*/id-cards": IdCardsScreen,
  "*/verify": VerifyScreen,
  "*/branches": BranchesScreen,
  "*/settings": SettingsScreen,
  "*/subscription": SubscriptionScreen,
  "*/support": SupportScreen,
  "*/security": SecurityScreen,
  "*/day-book": DayBookScreen,
  "dine/expenses": ExpensesScreen,
  "bill/expenses": ExpensesScreen,

  // SAF Dine Flow
  "dine/": DineDashboard,
  "dine/pos": DinePos,
  "dine/waiter": DineWaiter,
  "dine/kds": DineKds,
  "dine/cashier": DineCashier,
  "dine/orders": DineOrders,
  "dine/tables": DineTables,
  "dine/menu": DineMenu,
  "dine/inventory": DineInventory,
  "dine/recipes": DineRecipes,
  "dine/suppliers": DineSuppliers,
  "dine/purchases": DinePurchases,
  "dine/wastage": DineWastage,
  "dine/stock-ledger": DineStockLedger,
  "dine/reports": DineReports,
  "dine/analytics": DineAnalytics,

  // SAF Stay Flow
  "stay/": StayDashboard,
  "stay/front-desk": StayFrontDesk,
  "stay/reservations": StayReservations,
  "stay/availability": StayAvailability,
  "stay/guests": StayGuests,
  "stay/cashier": StayCashier,
  "stay/invoices": StayInvoices,
  "stay/expenses": StayExpenses,
  "stay/rooms": StayRooms,
  "stay/housekeeping": StayHousekeeping,
  "stay/maintenance": StayMaintenance,
  "stay/reports": StayReports,
  "stay/analytics": StayAnalytics,
  "stay/revenue": StayRevenue,
  "stay/operations": StayOperations,

  // SAF Bill Flow
  "bill/": BillDashboard,
  "bill/pos": BillPos,
  "bill/cashier": BillCashier,
  "bill/sales": BillSales,
  "bill/customers": BillCustomers,
  "bill/products": BillProducts,
  "bill/inventory": BillInventory,
  "bill/purchases": BillPurchases,
  "bill/suppliers": BillSuppliers,
  "bill/adjustments": BillAdjustments,
  "bill/valuation": BillValuation,
  "bill/counters": BillCounters,
  "bill/reports": BillReports,
  "bill/analytics": BillAnalytics,
};
