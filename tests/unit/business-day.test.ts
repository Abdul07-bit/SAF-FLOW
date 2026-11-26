import { describe, expect, it } from "vitest";
import {
  businessDate, businessDayEnd, businessDayStart, closesAfterMidnight, closingInstant, formatDailyNo, lastClosedBusinessDate,
} from "@/lib/business-day";

/** Instant for an IST wall-clock time. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe("business day", () => {
  const lateNight = { openingTime: "10:00", closingTime: "02:00" };
  const dayShop = { openingTime: "09:00", closingTime: "21:00" };

  it("a shop closing at 02:00 books 01:30 on 18 Nov as 17 Nov", () => {
    expect(closesAfterMidnight(lateNight)).toBe(true);
    expect(businessDate(ist("2026-11-18T01:30:00"), lateNight)).toBe("2026-11-17");
    expect(businessDate(ist("2026-11-18T01:59:59"), lateNight)).toBe("2026-11-17");
    expect(businessDate(ist("2026-11-18T02:00:00"), lateNight)).toBe("2026-11-18");
    expect(businessDate(ist("2026-11-17T23:00:00"), lateNight)).toBe("2026-11-17");
    expect(businessDate(ist("2026-11-17T10:00:00"), lateNight)).toBe("2026-11-17");
  });

  it("a shop closing before midnight rolls over at midnight", () => {
    expect(closesAfterMidnight(dayShop)).toBe(false);
    expect(businessDate(ist("2026-11-17T23:59:00"), dayShop)).toBe("2026-11-17");
    expect(businessDate(ist("2026-11-18T00:05:00"), dayShop)).toBe("2026-11-18");
  });

  it("day window and closing instant", () => {
    expect(businessDayStart("2026-11-17", lateNight).toISOString()).toBe(ist("2026-11-17T02:00:00").toISOString());
    expect(businessDayEnd("2026-11-17", lateNight).getTime()).toBe(ist("2026-11-18T02:00:00").getTime() - 1);
    expect(closingInstant("2026-11-17", lateNight).toISOString()).toBe(ist("2026-11-18T02:00:00").toISOString());
    expect(closingInstant("2026-11-17", dayShop).toISOString()).toBe(ist("2026-11-17T21:00:00").toISOString());
  });

  it("last closed day: the report for 17 Nov is due at 02:00 on 18 Nov", () => {
    expect(lastClosedBusinessDate(lateNight, ist("2026-11-18T01:50:00"))).toBe("2026-11-16");
    expect(lastClosedBusinessDate(lateNight, ist("2026-11-18T02:10:00"))).toBe("2026-11-17");
    expect(lastClosedBusinessDate(dayShop, ist("2026-11-17T20:59:00"))).toBe("2026-11-16");
    expect(lastClosedBusinessDate(dayShop, ist("2026-11-17T21:01:00"))).toBe("2026-11-17");
  });

  it("daily numbers print with three digits", () => {
    expect(formatDailyNo(1)).toBe("001");
    expect(formatDailyNo(9)).toBe("009");
    expect(formatDailyNo(1234)).toBe("1234");
  });
});
