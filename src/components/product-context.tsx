"use client";

import { createContext, useContext } from "react";
import type { ProductCode } from "@/config/catalog";

export interface SubscriptionInfo {
  id: string;
  tier: "BASIC" | "GROWTH";
  planName: string;
  billingCycle: "MONTHLY" | "ANNUAL";
  status: string;
  state: "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "CANCELLED" | "PENDING";
  startDate: string;
  currentPeriodEnd: string;
  graceEndsAt: string;
  daysLeft: number;
  pendingTier: "BASIC" | "GROWTH" | null;
  pendingBillingCycle: "MONTHLY" | "ANNUAL" | null;
}

export interface ProductData {
  product: { code: ProductCode; name: string; shortName: string; tagline: string };
  tenant: {
    id: string; code: string; status: string; name: string; logoUrl: string | null; phone: string | null; email: string | null; address: string | null;
    upiId: string | null; upiPayeeName: string | null; upiQrUrl: string | null;
  };
  user: { id: string; username: string; fullName: string; isTenantOwner: boolean };
  role: { id: string; code: string; name: string; homeScreen: string } | null;
  subscription: SubscriptionInfo | null;
  features: string[];
  permissions: string[];
  branches: { id: string; name: string; code: string; isMain: boolean }[];
  multiBranch: boolean;
  settings: Record<string, any>;
}

export interface ProductCtx extends ProductData {
  code: ProductCode;
  /** URL prefix of this application, e.g. "/dine". */
  base: string;
  /** Any-of plan feature check (relative keys, e.g. "kds"). */
  has: (feature: string | readonly string[]) => boolean;
  /** Any-of role permission check (relative keys, e.g. "kitchen.update"). */
  can: (permission: string | readonly string[]) => boolean;
  branchId: string;
  reload: () => Promise<void>;
}

export const ProductContext = createContext<ProductCtx | null>(null);

export function useProduct(): ProductCtx {
  const ctx = useContext(ProductContext);
  if (!ctx) throw new Error("useProduct must be used inside a product application");
  return ctx;
}

export const asList = (v: string | readonly string[] | undefined): string[] => (v === undefined ? [] : typeof v === "string" ? [v] : [...v]);
