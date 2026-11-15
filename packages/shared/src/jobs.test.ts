import { describe, expect, it } from "vitest";
import { JOB_DEFS, dueSlot } from "./jobs.js";
import { SEED_BUSINESS_UNITS } from "./seed.js";
import { businessUnitSchema } from "./schemas/businessUnit.js";

const job = (name: string) => {
  const j = JOB_DEFS.find((d) => d.name === name);
  if (!j) throw new Error(`no job ${name}`);
  return j;
};

describe("dueSlot", () => {
  it("day close runs at 00:15 IST (18:45 UTC) and not before", () => {
    expect(dueSlot(job("dayClose"), new Date("2026-11-15T18:40:00Z"))).toBeNull(); // 00:10 IST
    expect(dueSlot(job("dayClose"), new Date("2026-11-15T18:45:00Z"))).toBe("2026-11-16");
  });

  it("gives the same slot for repeated runs on the same day", () => {
    const a = dueSlot(job("morningSummary"), new Date("2026-11-16T04:15:00Z"));
    const b = dueSlot(job("morningSummary"), new Date("2026-11-16T09:00:00Z"));
    expect(a).toBe("2026-11-16");
    expect(b).toBe(a);
  });

  it("payroll draft only runs on the 1st", () => {
    expect(dueSlot(job("payrollDraft"), new Date("2026-12-01T00:30:00Z"))).toBe("2026-12-01"); // 06:00 IST
    expect(dueSlot(job("payrollDraft"), new Date("2026-12-01T00:29:00Z"))).toBeNull();
    expect(dueSlot(job("payrollDraft"), new Date("2026-12-02T05:00:00Z"))).toBeNull();
  });

  it("late alerts run in 5-minute slots inside the 05:30-14:00 IST window", () => {
    expect(dueSlot(job("lateAlerts"), new Date("2026-11-16T04:07:00Z"))).toBe("2026-11-16T0935");
    expect(dueSlot(job("lateAlerts"), new Date("2026-11-16T00:00:00Z"))).toBe("2026-11-16T0530"); // window start
    expect(dueSlot(job("lateAlerts"), new Date("2026-11-15T23:59:00Z"))).toBeNull(); // 05:29
    expect(dueSlot(job("lateAlerts"), new Date("2026-11-16T09:00:00Z"))).toBeNull(); // 14:30
  });
});

describe("seed data", () => {
  it("has the 5 first-release units with valid shape", () => {
    expect(SEED_BUSINESS_UNITS.map((u) => u.code)).toEqual(["BM", "F6G1", "F6G2", "GZ", "FB"]);
    for (const u of SEED_BUSINESS_UNITS) expect(() => businessUnitSchema.parse(u)).not.toThrow();
  });

  it("has the specified categories", () => {
    const by = Object.fromEntries(SEED_BUSINESS_UNITS.map((u) => [u.code, u.salesCategories]));
    expect(by["BM"]?.map((c) => c.name)).toEqual([
      "New mobiles",
      "Second-hand mobiles",
      "Accessories",
      "Service",
    ]);
    expect(by["F6G1"]).toEqual(by["F6G2"]);
    expect(by["F6G1"]?.filter((c) => c.type === "count").map((c) => c.name)).toEqual([
      "InBody tests",
      "Ice bath",
      "Steam",
    ]);
    expect(by["GZ"]).toHaveLength(3);
    expect(by["FB"]).toHaveLength(2);
  });
});
