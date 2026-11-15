import { applyBps } from "./money.js";
import { computeSalary } from "./salary.js";

/** Spec 8.8 "Today you earned": perDay (half day = perDay/2) + estimated incentive on today's amount sales. */
export function todayEarned(args: {
  committedPaise: number;
  halfDay: boolean;
  todayAmountSalesPaise: number;
  currentRateBps: number;
}): { salaryPaise: number; incentiveEstimatePaise: number; totalPaise: number } {
  const perDay = args.committedPaise / 30;
  const salaryPaise = Math.round(args.halfDay ? perDay / 2 : perDay);
  const incentiveEstimatePaise = Math.round(applyBps(args.todayAmountSalesPaise, args.currentRateBps));
  return { salaryPaise, incentiveEstimatePaise, totalPaise: salaryPaise + incentiveEstimatePaise };
}

/** Salary so far: perDay x days present to date. */
export function salarySoFar(committedPaise: number, presentDays: number): number {
  return Math.round((committedPaise / 30) * presentDays);
}

/** Projected: 8.3 formula assuming present every remaining day of the month. */
export function projectedSalary(args: {
  committedPaise: number;
  D: number;
  E: number;
  presentSoFar: number;
  remainingEligibleDays: number;
}): number {
  const P = args.presentSoFar + args.remainingEligibleDays;
  return Math.round(computeSalary({ committedPaise: args.committedPaise, D: args.D, E: args.E, P }).salaryPaise);
}
