import { describe, expect, it } from "vitest";
import {
  addDays,
  dateIST,
  daysInMonth,
  diffDays,
  minutesOfDayIST,
  parseTimeOfDay,
  previousMonthKey,
} from "./time.js";

describe("IST time helpers", () => {
  it("computes the IST business date across the UTC boundary", () => {
    // 18:29 UTC = 23:59 IST same day; 18:30 UTC = 00:00 IST next day
    expect(dateIST(new Date("2026-11-15T18:29:59Z"))).toBe("2026-11-15");
    expect(dateIST(new Date("2026-11-15T18:30:00Z"))).toBe("2026-11-16");
  });

  it("treats 09:30:59 as 09:30 and 09:31 as later (no grace)", () => {
    const shiftStart = parseTimeOfDay("09:30");
    const onTime = new Date("2026-11-16T04:00:59Z"); // 09:30:59 IST
    const late = new Date("2026-11-16T04:01:00Z"); // 09:31:00 IST
    expect(minutesOfDayIST(onTime)).toBeLessThanOrEqual(shiftStart);
    expect(minutesOfDayIST(late)).toBeGreaterThan(shiftStart);
  });

  it("does date arithmetic", () => {
    expect(addDays("2026-11-10", 2)).toBe("2026-11-12");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(diffDays("2026-11-10", "2026-11-12")).toBe(2);
    expect(diffDays("2026-11-11", "2026-11-12")).toBe(1);
  });

  it("knows month lengths", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    expect(daysInMonth("2026-11")).toBe(30);
    expect(daysInMonth("2026-12")).toBe(31);
    expect(previousMonthKey("2026-01")).toBe("2025-12");
  });

  it("rejects bad input", () => {
    expect(() => parseTimeOfDay("9:30")).toThrow();
    expect(() => addDays("2026-1-1", 1)).toThrow();
  });
});
