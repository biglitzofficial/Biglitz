import { Timestamp, type DocumentReference } from "firebase-admin/firestore";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  computeIncentive,
  computeNet,
  computeSalary,
  eligibleDays,
  type Slab,
} from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { badRequest, conflict, notFound } from "../http.js";
import type { EmployeeDoc, EmployeePayDoc, EmployeeTargetDoc } from "../types.js";
import { payrollRunId } from "./lock.js";
import { monthAmountSales } from "./sales.js";
import { payrollAttendance } from "./stats.js";

export type Part = "salary" | "incentive";
export type PartStatus = "draft" | "submitted" | "approved" | "paid";

export interface Adjustment {
  /** Dedup key for system-generated lines (e.g. monthly reward). */
  key?: string;
  kind: "adjustment" | "bonus";
  amountPaise: number;
  reason: string;
  by: string;
  at: Timestamp;
}

export interface PayrollLine {
  employeeId: string;
  name: string;
  businessId: string;
  committedPaise: number;
  D: number;
  E: number;
  P: number;
  leaveDays: number;
  payableDays: number;
  perDayPaise: number;
  salaryPaise: number;
  advanceOutstandingPaise: number;
  advanceRecoveredPaise: number;
  advanceCarriedPaise: number;
  adjustments: Adjustment[];
  adjustmentsTotalPaise: number;
  netSalaryPaise: number;
  salaryRoundingDiffPaise: number;
  incentive: {
    monthlySalesPaise: number;
    targetPaise: number | null;
    achievementPct: number;
    rateBps: number;
    incentivePaise: number;
    roundingDiffPaise: number;
  };
  bank: EmployeePayDoc["bank"];
}

export interface PayrollRun {
  unit: string;
  month: string;
  salaryStatus: PartStatus;
  incentiveStatus: PartStatus;
  locked: boolean;
  createdAt: Timestamp;
  submittedBy: { salary: string | null; incentive: string | null };
  approvedBy: { salary: string | null; incentive: string | null };
  totals: { salaryNetPaise: number; incentivePaise: number; employees: number };
}

export const runRef = (ctx: AppContext, unit: string, month: string) => ctx.db.collection("payrollRuns").doc(payrollRunId(unit, month));
export const linesCol = (ctx: AppContext, unit: string, month: string) => runRef(ctx, unit, month).collection("lines");

async function outstandingAdvances(ctx: AppContext, empId: string, monthEnd: string) {
  const snaps = await ctx.db.collection("advances").where("employeeId", "==", empId).get();
  return snaps.docs
    .map((d) => ({ ref: d.ref, ...(d.data() as { amountPaise: number; recoveredPaise: number; date: string }) }))
    .filter((a) => a.date <= monthEnd && a.amountPaise - a.recoveredPaise > 0)
    .sort((x, y) => (x.date < y.date ? -1 : 1));
}

async function outstandingPenalties(ctx: AppContext, empId: string, monthEnd: string) {
  const snaps = await ctx.db.collection("penalties").where("employeeId", "==", empId).get();
  return snaps.docs
    .map((d) => ({ id: d.id, ref: d.ref, ...(d.data() as { amountPaise: number; recoveredPaise: number; date: string; reason: string }) }))
    .filter((p) => p.date <= monthEnd && p.amountPaise - p.recoveredPaise > 0)
    .sort((x, y) => (x.date < y.date ? -1 : 1));
}

const isPenaltyAdj = (a: Adjustment): boolean => !!a.key?.startsWith("penalty_");

/** Builds (or rebuilds) a payroll line from source data, preserving existing adjustments. */
export async function buildLine(ctx: AppContext, emp: EmployeeDoc, month: string, today: string, adjustments: Adjustment[] = []): Promise<PayrollLine> {
  const pay = (await ctx.db.collection("employeePay").doc(emp.employeeId).get()).data() as EmployeePayDoc;
  const target = (await ctx.db.collection("employeeTargets").doc(emp.employeeId).get()).data() as EmployeeTargetDoc;
  const { D, E, P } = await payrollAttendance(ctx, emp, month, today);
  const sal = computeSalary({ committedPaise: pay.committedPaise, D, E, P });
  const monthEnd = `${month}-${String(D).padStart(2, "0")}`;
  const advances = await outstandingAdvances(ctx, emp.employeeId, monthEnd);
  const advanceOutstandingPaise = advances.reduce((s, a) => s + (a.amountPaise - a.recoveredPaise), 0);
  const penalties = await outstandingPenalties(ctx, emp.employeeId, monthEnd);
  const penaltyAdjs: Adjustment[] = penalties.map((p) => ({
    kind: "adjustment",
    amountPaise: -(p.amountPaise - p.recoveredPaise),
    reason: `Salary deduction: ${p.reason}`,
    by: "system",
    at: Timestamp.fromDate(ctx.clock()),
    key: `penalty_${p.id}`,
  }));
  const merged = [...adjustments.filter((a) => !isPenaltyAdj(a)), ...penaltyAdjs];
  const adjustmentsTotalPaise = merged.reduce((s, a) => s + a.amountPaise, 0);
  const net = computeNet({ salaryPaise: sal.salaryPaise, advanceOutstandingPaise, adjustmentsPaise: adjustmentsTotalPaise });
  const monthlySalesPaise = await monthAmountSales(ctx, emp.employeeId, month);
  const inc = computeIncentive({ monthlySalesPaise, targetPaise: target.targetPaise, slabs: target.slabs as Slab[] });
  return {
    employeeId: emp.employeeId,
    name: emp.name,
    businessId: emp.businessId,
    committedPaise: pay.committedPaise,
    D,
    E,
    P,
    leaveDays: sal.leaveDays,
    payableDays: sal.payableDays,
    perDayPaise: sal.perDayPaise,
    salaryPaise: sal.salaryPaise,
    advanceOutstandingPaise,
    advanceRecoveredPaise: net.advanceRecoveredPaise,
    advanceCarriedPaise: net.advanceCarriedPaise,
    adjustments: merged,
    adjustmentsTotalPaise,
    netSalaryPaise: net.netPaise,
    salaryRoundingDiffPaise: net.roundingDiffPaise,
    incentive: {
      monthlySalesPaise,
      targetPaise: target.targetPaise,
      achievementPct: inc.achievementPct,
      rateBps: inc.rateBps,
      incentivePaise: inc.incentivePaise,
      roundingDiffPaise: inc.roundingDiffPaise,
    },
    bank: pay.bank,
  };
}

const totalsOf = (lines: PayrollLine[]): PayrollRun["totals"] => ({
  salaryNetPaise: lines.reduce((s, l) => s + l.netSalaryPaise, 0),
  incentivePaise: lines.reduce((s, l) => s + l.incentive.incentivePaise, 0),
  employees: lines.length,
});

/** Employees who have eligible days in `month` for a unit. */
export async function payrollEmployees(ctx: AppContext, unit: string, month: string): Promise<EmployeeDoc[]> {
  const snaps = await ctx.db.collection("employees").where("businessId", "==", unit).get();
  return snaps.docs
    .map((d) => d.data() as EmployeeDoc)
    .filter((e) => e.status !== "pending" && !e.roles.includes("superAdmin") && eligibleDays(month, e.joiningDate, e.exitDate) > 0);
}

/** Creates the draft for a unit-month. Idempotent: does nothing if the run already exists. */
export async function createDraft(ctx: AppContext, unit: string, month: string, today: string): Promise<{ created: boolean }> {
  const ref = runRef(ctx, unit, month);
  if ((await ref.get()).exists) return { created: false };
  const emps = await payrollEmployees(ctx, unit, month);
  const lines: PayrollLine[] = [];
  for (const e of emps) lines.push(await buildLine(ctx, e, month, today));
  const run: PayrollRun = {
    unit,
    month,
    salaryStatus: "draft",
    incentiveStatus: "draft",
    locked: false,
    createdAt: Timestamp.fromDate(ctx.clock()),
    submittedBy: { salary: null, incentive: null },
    approvedBy: { salary: null, incentive: null },
    totals: totalsOf(lines),
  };
  const batch = ctx.db.batch();
  batch.create(ref, run); // fails atomically if another process created it first
  for (const l of lines) batch.set(linesCol(ctx, unit, month).doc(l.employeeId), l);
  try {
    await batch.commit();
  } catch (err) {
    const code = (err as { code?: number | string }).code;
    if (code === 6 || code === "already-exists") return { created: false };
    throw err;
  }
  return { created: true };
}

/** Recalculates one line while the run is still editable (draft). No-op for other states. */
export async function recalcLine(ctx: AppContext, unit: string, month: string, empId: string, today: string): Promise<void> {
  const run = await runRef(ctx, unit, month).get();
  if (!run.exists) return;
  const r = run.data() as PayrollRun;
  if (r.salaryStatus !== "draft" || r.locked) return;
  const lineRef = linesCol(ctx, unit, month).doc(empId);
  const existing = await lineRef.get();
  const empSnap = await ctx.db.collection("employees").doc(empId).get();
  if (!empSnap.exists) return;
  const line = await buildLine(ctx, empSnap.data() as EmployeeDoc, month, today, existing.exists ? (existing.data() as PayrollLine).adjustments : []);
  await lineRef.set(line);
  await refreshTotals(ctx, unit, month);
}

/** After a correction to a past month: refresh that employee's draft payroll line (no-op if no draft). */
export async function recalcIfPastMonth(ctx: AppContext, emp: EmployeeDoc, dateIST: string, today: string): Promise<void> {
  const month = dateIST.slice(0, 7);
  if (month >= today.slice(0, 7)) return;
  await recalcLine(ctx, emp.businessId, month, emp.employeeId, today);
}

export async function refreshTotals(ctx: AppContext, unit: string, month: string): Promise<void> {
  const snaps = await linesCol(ctx, unit, month).get();
  await runRef(ctx, unit, month).update({ totals: totalsOf(snaps.docs.map((d) => d.data() as PayrollLine)) });
}

export async function recalcAll(ctx: AppContext, unit: string, month: string, today: string): Promise<void> {
  const run = await runRef(ctx, unit, month).get();
  if (!run.exists) throw notFound("Payroll run");
  const r = run.data() as PayrollRun;
  if (r.salaryStatus !== "draft" || r.locked) throw conflict("NOT_DRAFT", "Only a draft payroll can be recalculated.");
  const emps = await payrollEmployees(ctx, unit, month);
  for (const e of emps) await recalcLine(ctx, unit, month, e.employeeId, today);
}

export async function addAdjustment(ctx: AppContext, unit: string, month: string, empId: string, adj: Adjustment, today: string): Promise<void> {
  const run = await runRef(ctx, unit, month).get();
  if (!run.exists) throw notFound("Payroll run");
  const r = run.data() as PayrollRun;
  if (r.salaryStatus !== "draft" || r.locked) throw conflict("NOT_DRAFT", "Adjustments can only be added while the payroll is a draft.");
  const lineRef = linesCol(ctx, unit, month).doc(empId);
  const existing = await lineRef.get();
  if (!existing.exists) throw notFound("Payroll line");
  const cur = existing.data() as PayrollLine;
  if (adj.key && cur.adjustments.some((a) => a.key === adj.key)) return; // idempotent system lines
  const empSnap = await ctx.db.collection("employees").doc(empId).get();
  const line = await buildLine(ctx, empSnap.data() as EmployeeDoc, month, today, [...cur.adjustments, adj]);
  await lineRef.set(line);
  await refreshTotals(ctx, unit, month);
}

const partField = (p: Part) => (p === "salary" ? "salaryStatus" : "incentiveStatus");

export async function submitPart(ctx: AppContext, unit: string, month: string, part: Part, by: string): Promise<void> {
  const ref = runRef(ctx, unit, month);
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Payroll run");
    const r = snap.data() as PayrollRun;
    if (r[partField(part)] !== "draft") throw conflict("NOT_DRAFT", `The ${part} part is already ${r[partField(part)]}.`);
    tx.update(ref, { [partField(part)]: "submitted", [`submittedBy.${part}`]: by });
  });
}

/** Send a submitted part back to draft (approver found a problem). */
export async function reopenPart(ctx: AppContext, unit: string, month: string, part: Part): Promise<void> {
  const ref = runRef(ctx, unit, month);
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Payroll run");
    const r = snap.data() as PayrollRun;
    if (r[partField(part)] !== "submitted") throw conflict("NOT_SUBMITTED", "Only a submitted part can be sent back.");
    tx.update(ref, { [partField(part)]: "draft" });
  });
}

/** Approves a submitted part and LOCKS the month. Salary approval applies advance recoveries atomically. */
export async function approvePart(ctx: AppContext, unit: string, month: string, part: Part, by: string): Promise<void> {
  const ref = runRef(ctx, unit, month);
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Payroll run");
    const r = snap.data() as PayrollRun;
    if (r[partField(part)] !== "submitted") throw conflict("NOT_SUBMITTED", `The ${part} part must be submitted before it can be approved.`);

    // ---- all reads first ----
    const plan: Array<{ ref: DocumentReference; recovered: number }> = [];
    if (part === "salary") {
      const lines = (await tx.get(linesCol(ctx, unit, month))).docs.map((d) => d.data() as PayrollLine);
      const monthEnd = `${month}-31`;
      for (const l of lines) {
        if (l.advanceRecoveredPaise > 0) {
          const advSnap = await tx.get(ctx.db.collection("advances").where("employeeId", "==", l.employeeId));
          const advs = advSnap.docs
            .map((d) => ({ ref: d.ref, ...(d.data() as { amountPaise: number; recoveredPaise: number; date: string }) }))
            .filter((a) => a.date <= monthEnd && a.amountPaise - a.recoveredPaise > 0)
            .sort((x, y) => (x.date < y.date ? -1 : 1));
          let left = l.advanceRecoveredPaise;
          for (const a of advs) {
            if (left <= 0) break;
            const take = Math.min(left, a.amountPaise - a.recoveredPaise);
            plan.push({ ref: a.ref, recovered: a.recoveredPaise + take });
            left -= take;
          }
        }
        // Penalties on the line (system adjustments) are marked fully recovered on salary approval.
        const penKeys = new Set(l.adjustments.filter(isPenaltyAdj).map((a) => a.key!.slice("penalty_".length)));
        if (penKeys.size) {
          const penSnap = await tx.get(ctx.db.collection("penalties").where("employeeId", "==", l.employeeId));
          for (const d of penSnap.docs) {
            if (!penKeys.has(d.id)) continue;
            const p = d.data() as { amountPaise: number; recoveredPaise: number };
            if (p.amountPaise - p.recoveredPaise > 0) plan.push({ ref: d.ref, recovered: p.amountPaise });
          }
        }
      }
    }
    // ---- writes ----
    for (const p of plan) tx.update(p.ref, { recoveredPaise: p.recovered });
    tx.update(ref, { [partField(part)]: "approved", [`approvedBy.${part}`]: by, locked: true });
  });
}

export async function markPaid(ctx: AppContext, unit: string, month: string, part: Part): Promise<void> {
  const ref = runRef(ctx, unit, month);
  await ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("Payroll run");
    const r = snap.data() as PayrollRun;
    if (r[partField(part)] !== "approved") throw conflict("NOT_APPROVED", `The ${part} part must be approved before it is marked paid.`);
    tx.update(ref, { [partField(part)]: "paid" });
  });
}

const csvCell = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;

/** Salary bank transfer list (paid 5th) or incentive list (paid 10th). Only for approved/paid parts. */
export async function transferCsv(ctx: AppContext, unit: string, month: string, part: Part): Promise<string> {
  const run = await runRef(ctx, unit, month).get();
  if (!run.exists) throw notFound("Payroll run");
  const r = run.data() as PayrollRun;
  if (r[partField(part)] !== "approved" && r[partField(part)] !== "paid") throw badRequest("NOT_APPROVED", `The ${part} part is not approved yet.`);
  const lines = (await linesCol(ctx, unit, month).get()).docs.map((d) => d.data() as PayrollLine);
  const rows = lines.map((l) => ({ l, amount: part === "salary" ? l.netSalaryPaise : l.incentive.incentivePaise })).filter((x) => x.amount > 0);
  const missing = rows.filter((x) => !x.l.bank).map((x) => x.l.employeeId);
  if (missing.length) throw badRequest("BANK_MISSING", `Bank details are missing for: ${missing.join(", ")}.`);
  const out = ["Name,Account Number,IFSC,Amount"];
  for (const { l, amount } of rows) out.push([csvCell(l.bank?.accountHolder ?? l.name), csvCell(l.bank?.accountNumber ?? ""), csvCell(l.bank?.ifsc ?? ""), amount / 100].join(","));
  return out.join("\n") + "\n";
}

const rs = (paise: number): string => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

export async function renderPayslipPdf(line: PayrollLine, unit: string, month: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const text = (s: string, opts: { x?: number; size?: number; b?: boolean } = {}) => {
    page.drawText(s, { x: opts.x ?? 50, y, size: opts.size ?? 11, font: opts.b ? bold : font, color: rgb(0.1, 0.1, 0.1) });
  };
  const row = (label: string, value: string, b = false) => {
    text(label, { b });
    text(value, { x: 400, b });
    y -= 18;
  };
  text("Biglitz Team - Payslip", { size: 18, b: true });
  y -= 28;
  text(`${line.name} (${line.employeeId})   Unit: ${unit}   Month: ${month}`);
  y -= 30;
  text("SALARY (paid on the 5th)", { b: true });
  y -= 20;
  row("Committed monthly salary", rs(line.committedPaise));
  row("Days in month / eligible / present", `${line.D} / ${line.E} / ${line.P}`);
  row("Leave days", String(line.leaveDays));
  row("Payable days", line.payableDays.toFixed(3));
  row("Salary", rs(Math.round(line.salaryPaise)));
  row("Advance recovery", `- ${rs(line.advanceRecoveredPaise)}`);
  for (const a of line.adjustments) row(`${a.kind === "bonus" ? "Bonus" : "Adjustment"}: ${a.reason}`.slice(0, 60), `${a.amountPaise < 0 ? "-" : "+"} ${rs(Math.abs(a.amountPaise))}`);
  row("Rounding", rs(Math.round(line.salaryRoundingDiffPaise)));
  row("NET SALARY", rs(line.netSalaryPaise), true);
  if (line.advanceCarriedPaise > 0) row("Advance carried to next month", rs(line.advanceCarriedPaise));
  y -= 20;
  text("INCENTIVE (paid on the 10th)", { b: true });
  y -= 20;
  row("Monthly sales", rs(line.incentive.monthlySalesPaise));
  row("Target", line.incentive.targetPaise ? rs(line.incentive.targetPaise) : "-");
  row("Achievement", `${line.incentive.achievementPct.toFixed(2)}%`);
  row("Rate", `${(line.incentive.rateBps / 100).toFixed(2)}%`);
  row("INCENTIVE", rs(line.incentive.incentivePaise), true);
  return pdf.save();
}

/** Generates payslips once BOTH parts are approved (spec 8.6). Idempotent: overwrites the same files. */
export async function maybeGeneratePayslips(ctx: AppContext, unit: string, month: string): Promise<number> {
  const run = await runRef(ctx, unit, month).get();
  if (!run.exists) return 0;
  const r = run.data() as PayrollRun;
  const ok = (s: PartStatus) => s === "approved" || s === "paid";
  if (!ok(r.salaryStatus) || !ok(r.incentiveStatus)) return 0;
  const lines = (await linesCol(ctx, unit, month).get()).docs.map((d) => d.data() as PayrollLine);
  for (const l of lines) {
    const path = `payslips/${l.employeeId}_${month}.pdf`;
    await ctx.files.save(path, await renderPayslipPdf(l, unit, month), "application/pdf");
    await ctx.db.collection("payslips").doc(`${l.employeeId}_${month}`).set({ employeeId: l.employeeId, businessId: unit, month, path, netSalaryPaise: l.netSalaryPaise, incentivePaise: l.incentive.incentivePaise, generatedAt: Timestamp.fromDate(ctx.clock()) });
  }
  return lines.length;
}
