import { slabFor, type BusinessUnit, type Slab } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import type { DailySalesDoc, EmployeeTargetDoc } from "../types.js";
import { addDays } from "@biglitz/shared";

export const salesId = (empId: string, date: string): string => `${empId}_${date}`;

/** Sum of amount-type category values for a month, in paise. Count-type is excluded (spec 8.6). */
export async function monthAmountSales(ctx: AppContext, empId: string, month: string, upTo?: string): Promise<number> {
  const last = upTo ?? `${month}-31`;
  const refs = [];
  for (let d = `${month}-01`; d <= last && d.startsWith(month); d = addDays(d, 1)) {
    refs.push(ctx.db.collection("dailySales").doc(salesId(empId, d)));
  }
  if (refs.length === 0) return 0;
  const snaps = await ctx.db.getAll(...refs);
  return snaps.reduce((s, snap) => s + (snap.exists ? (snap.data() as DailySalesDoc).amountTotalPaise : 0), 0);
}

/** Computes amountTotalPaise from values using the unit's category types. */
export function amountTotal(unit: BusinessUnit, values: Record<string, number>): number {
  return unit.salesCategories.reduce((s, c) => (c.type === "amount" ? s + (values[c.id] ?? 0) : s), 0);
}

export async function getTarget(ctx: AppContext, empId: string): Promise<EmployeeTargetDoc> {
  const snap = await ctx.db.collection("employeeTargets").doc(empId).get();
  return snap.data() as EmployeeTargetDoc;
}

/** The incentive rate currently reached this month (bps). */
export function currentRateBps(monthSalesPaise: number, target: EmployeeTargetDoc): number {
  if (!target.targetPaise) return 0;
  const slabs: Slab[] = target.slabs;
  return slabFor((monthSalesPaise / target.targetPaise) * 100, slabs).rateBps;
}
