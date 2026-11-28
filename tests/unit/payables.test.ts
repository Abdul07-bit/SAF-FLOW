import { describe, expect, it } from "vitest";
import {
  billStatus, changePct, defaultDueDate, formatQuantity, lineAmount, parseQuantity, periodRange, planAllocations, previousRange, weekStart,
} from "@/lib/payables";

describe("supplier credit arithmetic", () => {
  it("quantities: up to 3 decimals, positive, as exact thousandths", () => {
    expect(parseQuantity("20")).toBe(20_000);
    expect(parseQuantity(2.5)).toBe(2_500);
    expect(parseQuantity("0.125")).toBe(125);
    expect(parseQuantity(" 7.000 ")).toBe(7_000);
    for (const bad of ["0", "-1", "1.2345", "abc", "1e3", "", "2,5", "10000000"]) expect(parseQuantity(bad), bad).toBeNull();
    expect(parseQuantity(Number.NaN)).toBeNull();
    expect(formatQuantity(2_500)).toBe("2.5");
    expect(formatQuantity(20_000)).toBe("20");
    expect(formatQuantity(125)).toBe("0.125");
  });

  it("line amount = quantity x rate, rounded half up once, exact for large values", () => {
    expect(lineAmount(20_000, 22_000)).toBe(440_000); // 20 kg x Rs 220 = Rs 4,400
    expect(lineAmount(2_500, 13_333)).toBe(33_333); // 33,332.5 paise rounds up
    expect(lineAmount(1, 1)).toBe(0); // 0.001 x 1 paisa
    expect(lineAmount(500, 1)).toBe(1); // half rounds up
    // 1,000,000 units x Rs 10,000,000: beyond floating-point integer precision, still exact
    expect(lineAmount(1_000_000_000, 1_000_000_000)).toBe(1_000_000_000_000_000);
    // 0.1 + 0.2 style errors cannot happen: 0.3 kg x Rs 10 is exactly Rs 3
    expect(lineAmount(300, 1_000)).toBe(300);
    expect(() => lineAmount(-1, 100)).toThrow();
    expect(() => lineAmount(1.5, 100)).toThrow();
  });

  it("bill status", () => {
    const today = "2026-11-28";
    expect(billStatus({ status: "ACTIVE", total: 440_000, due: 440_000, dueDate: null }, today)).toBe("UNPAID");
    expect(billStatus({ status: "ACTIVE", total: 440_000, due: 340_000, dueDate: "2026-11-28" }, today)).toBe("PARTIALLY_PAID");
    expect(billStatus({ status: "ACTIVE", total: 440_000, due: 340_000, dueDate: "2026-11-27" }, today)).toBe("OVERDUE");
    expect(billStatus({ status: "ACTIVE", total: 440_000, due: 0, dueDate: "2026-11-01" }, today)).toBe("PAID");
    expect(billStatus({ status: "CANCELLED", total: 440_000, due: 440_000, dueDate: "2026-11-01" }, today)).toBe("CANCELLED");
    expect(defaultDueDate("2026-11-28", 7)).toBe("2026-12-05");
    expect(defaultDueDate("2026-11-28", null)).toBeNull();
    expect(defaultDueDate("2026-11-28", 0)).toBe("2026-11-28");
  });

  it("FIFO allocation: oldest credit to oldest bill, never more than either", () => {
    const plan = planAllocations(
      [{ id: "b1", due: 4_400 }, { id: "b2", due: 2_000 }, { id: "b3", due: 0 }, { id: "b4", due: 500 }],
      [{ id: "p1", source: "payment", unallocated: 1_000 }, { id: "a1", source: "adjustment", unallocated: 0 }, { id: "p2", source: "payment", unallocated: 5_000 }],
    );
    expect(plan).toEqual([
      { purchaseId: "b1", source: "payment", sourceId: "p1", amount: 1_000 },
      { purchaseId: "b1", source: "payment", sourceId: "p2", amount: 3_400 },
      { purchaseId: "b2", source: "payment", sourceId: "p2", amount: 1_600 },
    ]);
    // Credit left over (none here) or bills left open, never both.
    const leftover = planAllocations([{ id: "b1", due: 100 }], [{ id: "p1", source: "payment", unallocated: 250 }]);
    expect(leftover).toEqual([{ purchaseId: "b1", source: "payment", sourceId: "p1", amount: 100 }]);
    expect(planAllocations([], [{ id: "p1", source: "payment", unallocated: 1 }])).toEqual([]);
  });

  it("report periods: Monday-Sunday weeks, calendar months, the period before", () => {
    expect(weekStart("2026-11-28")).toBe("2026-11-23"); // Saturday -> Monday
    expect(weekStart("2026-11-29")).toBe("2026-11-23"); // Sunday belongs to the week before
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
    expect(periodRange("day", "2026-11-28")).toEqual({ from: "2026-11-28", to: "2026-11-28" });
    expect(periodRange("week", "2026-11-28")).toEqual({ from: "2026-11-23", to: "2026-11-29" });
    expect(periodRange("month", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("day", "2026-11-28", "2026-11-28")).toEqual({ from: "2026-11-27", to: "2026-11-27" });
    expect(previousRange("week", "2026-11-23", "2026-11-29")).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    expect(previousRange("month", "2026-03-01", "2026-03-31")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousRange("custom", "2026-11-10", "2026-11-19")).toEqual({ from: "2026-10-31", to: "2026-11-09" });
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(0, 0)).toBe(0);
    expect(changePct(10, 0)).toBeNull();
  });
});
