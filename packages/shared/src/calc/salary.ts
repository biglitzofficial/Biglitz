import { addDays, daysInMonth } from "./time.js";
import { roundToRupee } from "./money.js";

/** Days from max(1st, joining) to min(last, exit), inclusive (spec 8.3 `E`). */
export function eligibleDays(monthKey: string, joiningDate: string, exitDate: string | null): number {
  const D = daysInMonth(monthKey);
  const first = `${monthKey}-01`;
  const last = `${monthKey}-${String(D).padStart(2, "0")}`;
  const start = joiningDate > first ? joiningDate : first;
  const end = exitDate && exitDate < last ? exitDate : last;
  if (end < start) return 0;
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) n++;
  return n;
}

export interface SalaryInput {
  committedPaise: number;
  /** Days in month. */
  D: number;
  /** Eligible days. */
  E: number;
  /** Days present in the eligible days (half day = 0.5). */
  P: number;
}

export interface SalaryResult {
  perDayPaise: number;
  leaveDays: number;
  payableDays: number;
  /** Unrounded, floored at 0. */
  salaryPaise: number;
}

/** Spec 8.3: perDay = committed / 30; payableDays = P + (32 - D) * E / D; salary = perDay * payableDays. */
export function computeSalary({ committedPaise, D, E, P }: SalaryInput): SalaryResult {
  const perDayPaise = committedPaise / 30;
  const payableDays = P + ((32 - D) * E) / D;
  return {
    perDayPaise,
    leaveDays: E - P,
    payableDays,
    salaryPaise: Math.max(0, perDayPaise * payableDays),
  };
}

export interface NetInput {
  salaryPaise: number;
  /** Total outstanding advance. */
  advanceOutstandingPaise: number;
  /** Positive or negative adjustment lines (each already has a mandatory reason). */
  adjustmentsPaise: number;
}

export interface NetResult {
  netPaise: number;
  advanceRecoveredPaise: number;
  advanceCarriedPaise: number;
  /** rounded - unrounded, stored on the payslip line. */
  roundingDiffPaise: number;
}

/**
 * Net = salary - advance recovery ± adjustments, rounded to the nearest rupee (half up).
 * Advance recovery is capped so net never goes below 0; the rest carries forward (spec 8.3).
 */
export function computeNet({ salaryPaise, advanceOutstandingPaise, adjustmentsPaise }: NetInput): NetResult {
  const beforeAdvance = salaryPaise + adjustmentsPaise;
  const advanceRecoveredPaise = Math.min(advanceOutstandingPaise, Math.max(0, beforeAdvance));
  const raw = Math.max(0, beforeAdvance - advanceRecoveredPaise);
  const { paise, diffPaise } = roundToRupee(raw);
  return {
    netPaise: paise,
    advanceRecoveredPaise,
    advanceCarriedPaise: advanceOutstandingPaise - advanceRecoveredPaise,
    roundingDiffPaise: diffPaise,
  };
}
