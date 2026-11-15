import type { Transaction } from "firebase-admin/firestore";
import type { AppContext } from "../context.js";
import { monthLocked } from "../http.js";

export const payrollRunId = (unit: string, month: string): string => `${unit}_${month}`;

/**
 * Spec 3.7: once a month's payroll is approved (salary or incentive), attendance/leave/sales for it cannot change.
 * A correction after lock is recorded as an adjustment line in the next month's payroll.
 */
export async function assertMonthUnlocked(
  ctx: AppContext,
  unit: string,
  dateIST: string,
  tx?: Transaction,
): Promise<void> {
  const ref = ctx.db.collection("payrollRuns").doc(payrollRunId(unit, dateIST.slice(0, 7)));
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (snap.exists && snap.data()?.["locked"] === true) throw monthLocked();
}
