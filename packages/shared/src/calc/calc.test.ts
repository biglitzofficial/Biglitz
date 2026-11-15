import { describe, expect, it } from "vitest";
import { checkGps, haversineMeters } from "./geo.js";
import { formatEmployeeId, normalisePhone, validatePin } from "./employee.js";
import { isOnTime, presentValue, statusForPunchedDay } from "./attendance.js";
import { isLateApplication, leaveOutcome } from "./leave.js";
import { computeNet, computeSalary, eligibleDays } from "./salary.js";
import { DEFAULT_SLABS, computeIncentive } from "./incentive.js";
import {
  computeBadges,
  computeMonthStats,
  onTimeStreak,
  rankEmployees,
  type DayRecord,
} from "./discipline.js";
import { pickAssignee } from "./roundRobin.js";
import { projectedSalary, salarySoFar, todayEarned } from "./earnings.js";
import { roundToRupee, rupeesToPaise } from "./money.js";

const shift = { start: "09:30", end: "22:00" };
// helper: IST HH:mm:ss on 2026-11-16 -> Date
const ist = (hms: string): Date => {
  const [h = 0, m = 0, s = 0] = hms.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, 16, h, m, s) - 330 * 60_000);
};

describe("employee id (acceptance 1, 2)", () => {
  it("formats YY + code + NNN", () => {
    expect(formatEmployeeId("2026-03-01", "BM", 15)).toBe("26BM015");
    expect(formatEmployeeId("2025-03-01", "BM", 16)).toBe("25BM016");
    expect(formatEmployeeId("2026-01-01", "F6G1", 1)).toBe("26F6G1001");
    expect(formatEmployeeId("2026-01-01", "BM", 1000)).toBe("26BM1000");
  });
});

describe("pin and phone", () => {
  it("validates PIN rules", () => {
    expect(validatePin("4821", "9876543210").ok).toBe(true);
    expect(validatePin("0000", "9876543210").ok).toBe(false);
    expect(validatePin("1234", "9876543210").ok).toBe(false);
    expect(validatePin("3210", "9876543210").ok).toBe(false);
    expect(validatePin("12a4", "9876543210").ok).toBe(false);
    expect(validatePin("48210", "9876543210").ok).toBe(false);
  });
  it("normalises phones", () => {
    expect(normalisePhone("98765 43210")).toBe("+919876543210");
    expect(normalisePhone("+91 98765-43210")).toBe("+919876543210");
    expect(normalisePhone("09876543210")).toBe("+919876543210");
    expect(normalisePhone("12345")).toBeNull();
  });
});

describe("gps (acceptance 3)", () => {
  const unit = { lat: 11.1085, lng: 77.3411, radiusMeters: 100 };
  // 1 degree latitude ~ 111,195 m
  const at = (m: number) => ({ lat: unit.lat + m / 111_195, lng: unit.lng, accuracy: 20 });
  it("rejects 120 m with distance shown, accepts 80 m", () => {
    const far = checkGps(at(120), unit);
    expect(far.ok).toBe(false);
    if (!far.ok) {
      expect(far.code).toBe("OUT_OF_RANGE");
      expect(far.message).toMatch(/120 m/);
    }
    expect(checkGps(at(80), unit).ok).toBe(true);
  });
  it("rejects poor accuracy and missing location", () => {
    expect(checkGps({ ...at(10), accuracy: 150 }, unit).ok).toBe(false);
    expect(checkGps(at(10), null).ok).toBe(false);
  });
  it("haversine is ~0 for same point", () => {
    expect(haversineMeters(unit, unit)).toBe(0);
  });
});

describe("attendance (acceptance 4)", () => {
  it("09:30:45 is on time, 09:31:00 is late; 21:55 punch-out is not on time", () => {
    expect(isOnTime(ist("09:30:45"), ist("22:00:00"), shift)).toBe(true);
    expect(isOnTime(ist("09:31:00"), ist("22:00:00"), shift)).toBe(false);
    expect(isOnTime(ist("09:30:00"), ist("21:55:00"), shift)).toBe(false);
    expect(isOnTime(ist("09:30:00"), null, shift)).toBe(false);
  });
  it("derives statuses", () => {
    const base = { shift, halfDay: false, closed: true };
    expect(statusForPunchedDay({ ...base, punchIn: ist("09:00"), punchOut: ist("22:00") })).toBe("onTime");
    expect(statusForPunchedDay({ ...base, punchIn: ist("09:40"), punchOut: ist("22:00") })).toBe("late");
    expect(statusForPunchedDay({ ...base, punchIn: ist("09:00"), punchOut: ist("21:00") })).toBe("earlyLeave");
    expect(statusForPunchedDay({ ...base, punchIn: ist("09:00"), punchOut: null })).toBe("missingPunchOut");
    expect(statusForPunchedDay({ ...base, closed: false, punchIn: ist("09:00"), punchOut: null })).toBe("present");
    expect(statusForPunchedDay({ ...base, halfDay: true, punchIn: ist("09:00"), punchOut: ist("14:00") })).toBe("halfDay");
    expect(presentValue("halfDay")).toBe(0.5);
    expect(presentValue("missingPunchOut")).toBe(1);
    expect(presentValue("absent")).toBe(0);
  });
});

describe("leave two-day rule (acceptance 7)", () => {
  it("applied 10th for 12th is fine; 11th for 12th is late", () => {
    expect(isLateApplication("2026-11-10", "2026-11-12")).toBe(false);
    expect(isLateApplication("2026-11-11", "2026-11-12")).toBe(true);
    expect(isLateApplication("2026-11-12", "2026-11-12")).toBe(true);
    expect(leaveOutcome("2026-11-10", "2026-11-12", true).approvedForDiscipline).toBe(true);
    const late = leaveOutcome("2026-11-11", "2026-11-12", true);
    expect(late).toEqual({ approvedForDiscipline: false, lateApplication: true });
    expect(leaveOutcome("2026-11-10", "2026-11-12", false).approvedForDiscipline).toBe(false);
  });
});

describe("salary (acceptance 8)", () => {
  const committed = rupeesToPaise(15000);
  const salaryRupees = (D: number, E: number, P: number) =>
    roundToRupee(computeSalary({ committedPaise: committed, D, E, P }).salaryPaise).paise / 100;

  it.each([28, 30, 31])("full month of %i days", (D) => {
    expect(salaryRupees(D, D, D - 0)).toBe(16000); // L=0
    expect(salaryRupees(D, D, D - 1)).toBe(15500);
    expect(salaryRupees(D, D, D - 2)).toBe(15000);
    expect(salaryRupees(D, D, D - 4)).toBe(14000);
  });
  it("payable days", () => {
    expect(computeSalary({ committedPaise: committed, D: 30, E: 30, P: 30 }).payableDays).toBe(32);
    expect(computeSalary({ committedPaise: committed, D: 30, E: 15, P: 15 }).payableDays).toBe(16);
    expect(computeSalary({ committedPaise: committed, D: 31, E: 15, P: 15 }).payableDays).toBeCloseTo(15.484, 3);
  });
  it("partial months", () => {
    expect(salaryRupees(30, 15, 15)).toBe(8000);
    expect(salaryRupees(31, 15, 15)).toBe(7742);
  });
  it("floors at zero", () => {
    expect(computeSalary({ committedPaise: committed, D: 30, E: 30, P: 0 }).salaryPaise).toBeGreaterThanOrEqual(0);
  });
  it("eligible days", () => {
    expect(eligibleDays("2026-11", "2020-01-01", null)).toBe(30);
    expect(eligibleDays("2026-11", "2026-11-16", null)).toBe(15);
    expect(eligibleDays("2026-12", "2026-12-17", null)).toBe(15);
    expect(eligibleDays("2026-11", "2020-01-01", "2026-11-10")).toBe(10);
    expect(eligibleDays("2026-11", "2026-12-05", null)).toBe(0);
  });
});

describe("advance and net (acceptance 9)", () => {
  it("advance 3000 vs salary 15000 -> net 12000", () => {
    const r = computeNet({ salaryPaise: 1_500_000, advanceOutstandingPaise: 300_000, adjustmentsPaise: 0 });
    expect(r.netPaise).toBe(1_200_000);
    expect(r.advanceCarriedPaise).toBe(0);
  });
  it("advance 20000 vs salary 15000 -> net 0, carry 5000", () => {
    const r = computeNet({ salaryPaise: 1_500_000, advanceOutstandingPaise: 2_000_000, adjustmentsPaise: 0 });
    expect(r.netPaise).toBe(0);
    expect(r.advanceRecoveredPaise).toBe(1_500_000);
    expect(r.advanceCarriedPaise).toBe(500_000);
  });
  it("applies adjustments and records rounding", () => {
    const r = computeNet({ salaryPaise: 774_193.5, advanceOutstandingPaise: 0, adjustmentsPaise: 10_000 });
    expect(r.netPaise).toBe(784_200);
    expect(r.roundingDiffPaise).toBeCloseTo(6.5);
    expect(computeNet({ salaryPaise: 100, advanceOutstandingPaise: 0, adjustmentsPaise: -50_000 }).netPaise).toBe(0);
  });
});

describe("incentive (acceptance 10)", () => {
  const target = rupeesToPaise(300_000);
  const inc = (sales: number) =>
    computeIncentive({ monthlySalesPaise: rupeesToPaise(sales), targetPaise: target, slabs: DEFAULT_SLABS });
  it("matches spec examples", () => {
    expect(inc(320_000).incentivePaise).toBe(rupeesToPaise(4800));
    expect(inc(250_000).incentivePaise).toBe(rupeesToPaise(2500));
    expect(inc(200_000).incentivePaise).toBe(0);
    expect(inc(240_000).incentivePaise).toBe(rupeesToPaise(2400)); // exactly 80%
    expect(inc(320_000).achievementPct).toBeCloseTo(106.67, 2);
  });
  it("no target means no incentive; custom slabs apply to whole sales", () => {
    expect(computeIncentive({ monthlySalesPaise: 100, targetPaise: null, slabs: DEFAULT_SLABS }).incentivePaise).toBe(0);
    const r = computeIncentive({
      monthlySalesPaise: rupeesToPaise(100_000),
      targetPaise: rupeesToPaise(100_000),
      slabs: [{ fromAchievementPct: 50, rateBps: 200 }],
    });
    expect(r.incentivePaise).toBe(rupeesToPaise(2000));
  });
});

describe("discipline (acceptance 11)", () => {
  const makeDays = (working: number, present: number, onTime: number): DayRecord[] =>
    Array.from({ length: working }, (_, i) => ({
      date: `2026-11-${String(i + 1).padStart(2, "0")}`,
      present: i < present ? 1 : 0,
      onTime: i < onTime,
      approvedLeave: 0,
    }));
  it("96.1 and 87.7", () => {
    const a = computeMonthStats(makeDays(26, 25, 24));
    expect(a.attendancePct).toBeCloseTo(96.2, 1);
    expect(a.punctualityPct).toBeCloseTo(96.0, 1);
    expect(a.score).toBe(96.1);
    const b = computeMonthStats(makeDays(26, 23, 20));
    expect(b.attendancePct).toBeCloseTo(88.5, 1);
    expect(b.punctualityPct).toBeCloseTo(87.0, 1);
    expect(b.score).toBe(87.7);
  });
  it("approved leave leaves working days; zero present gives 0 punctuality", () => {
    const days: DayRecord[] = [
      { date: "2026-11-01", present: 1, onTime: true, approvedLeave: 0 },
      { date: "2026-11-02", present: 0, onTime: false, approvedLeave: 1 },
    ];
    const s = computeMonthStats(days);
    expect(s.workingDays).toBe(1);
    expect(s.score).toBe(100);
    expect(computeMonthStats([{ date: "2026-11-01", present: 0, onTime: false, approvedLeave: 0 }]).score).toBe(0);
  });
  it("tie broken by streak, then earlier average punch-in", () => {
    const ranked = rankEmployees([
      { id: "a", score: 90, streak: 3, avgPunchInMinutes: 560 },
      { id: "b", score: 90, streak: 7, avgPunchInMinutes: 570 },
      { id: "c", score: 90, streak: 7, avgPunchInMinutes: 550 },
      { id: "d", score: 95, streak: 0, avgPunchInMinutes: null },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });
  it("streak: approved leave skipped, late/absent breaks", () => {
    const d = (date: string, onTime: boolean, present: number, approvedLeave = 0): DayRecord => ({
      date,
      onTime,
      present,
      approvedLeave,
    });
    expect(
      onTimeStreak([
        d("2026-11-01", true, 1),
        d("2026-11-02", false, 1), // late breaks
        d("2026-11-03", true, 1),
        d("2026-11-04", false, 0, 1), // approved leave: skipped
        d("2026-11-05", true, 1),
      ]),
    ).toBe(2);
    expect(onTimeStreak([d("2026-11-01", true, 1), d("2026-11-02", false, 0)])).toBe(0);
  });
  it("badges", () => {
    const days: DayRecord[] = [1, 2, 3].map((n) => ({ date: `2026-11-0${n}`, present: 1, onTime: true, approvedLeave: 0 }));
    const b = computeBadges({
      currentMonthDays: days,
      monthComplete: true,
      streak: 30,
      daysWithoutUnapprovedLeave: 100,
      lateDates: new Set(),
    });
    expect(b).toEqual(["neverLate", "fullAttendance", "streak30", "noUnapprovedLeave100"]);
    expect(
      computeBadges({ currentMonthDays: days, monthComplete: false, streak: 2, daysWithoutUnapprovedLeave: 3, lateDates: new Set(["2026-11-02"]) }),
    ).toEqual([]);
  });
});

describe("round robin (acceptance 12)", () => {
  it("A -> B -> C with B on leave gives A, C, A, C", () => {
    const order = ["A", "B", "C"];
    const eligible = (id: string) => id !== "B";
    let pointer = 0;
    const got: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = pickAssignee(order, pointer, eligible, true);
      got.push(r.assignee ?? "?");
      pointer = r.nextPointer;
    }
    expect(got).toEqual(["A", "C", "A", "C"]);
  });
  it("nobody eligible falls back to normal order and flags it", () => {
    const r = pickAssignee(["A", "B"], 1, () => false, true);
    expect(r).toEqual({ assignee: "B", nextPointer: 0, noneEligible: true });
  });
  it("skipAbsent off ignores eligibility; empty pool", () => {
    expect(pickAssignee(["A", "B"], 0, () => false, false).assignee).toBe("A");
    expect(pickAssignee([], 0, () => true, true).assignee).toBeNull();
  });
});

describe("earnings", () => {
  const committed = rupeesToPaise(15000);
  it("today you earned", () => {
    const r = todayEarned({ committedPaise: committed, halfDay: false, todayAmountSalesPaise: rupeesToPaise(10000), currentRateBps: 150 });
    expect(r.salaryPaise).toBe(50_000);
    expect(r.incentiveEstimatePaise).toBe(15_000);
    expect(todayEarned({ committedPaise: committed, halfDay: true, todayAmountSalesPaise: 0, currentRateBps: 0 }).salaryPaise).toBe(25_000);
  });
  it("salary so far and projection", () => {
    expect(salarySoFar(committed, 10)).toBe(500_000);
    // present all 30 days of a 30-day month => 32 payable days
    expect(projectedSalary({ committedPaise: committed, D: 30, E: 30, presentSoFar: 10, remainingEligibleDays: 20 })).toBe(1_600_000);
  });
});
