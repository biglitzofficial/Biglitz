import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dateIST, monthKeyIST } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { adminUnits, isAnyAdmin } from "../access.js";
import { forbidden } from "../http.js";
import type { DailySalesDoc, EmployeeDoc } from "../types.js";
import type { LeadDoc } from "../services/leads.js";
import type { LeaderboardEntry } from "../services/scores.js";
import type { PayrollRun } from "../services/payroll.js";
import { eligibleDates, loadDayDetails } from "../services/stats.js";
import { salesId } from "../services/sales.js";
import { guard } from "./guard.js";

/** Admin reports (spec 11.3): payroll cost per unit, attendance trend, discipline ranking, sales by category, leads funnel. */
export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/reports", { preHandler: guard(ctx) }, async (req) => {
    const a = req.actor;
    if (!isAnyAdmin(a)) throw forbidden("Reports are for Admins.");
    const q = z.object({ unit: z.string().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const now = ctx.clock();
    const today = dateIST(now);
    const month = q.month ?? monthKeyIST(now);

    const allUnits = (await ctx.db.collection("businessUnits").get()).docs.map((d) => d.id);
    const scope = adminUnits(a);
    const allowed = scope === null ? allUnits : scope.filter((u) => allUnits.includes(u));
    const units = q.unit ? allowed.filter((u) => u === q.unit) : allowed;
    if (q.unit && units.length === 0) throw forbidden("That business unit is not assigned to you.");

    const emps: EmployeeDoc[] = [];
    for (const u of units) {
      const snaps = await ctx.db.collection("employees").where("businessId", "==", u).get();
      snaps.docs.forEach((d) => emps.push(d.data() as EmployeeDoc));
    }
    const active = emps.filter((e) => e.status !== "pending" && !e.roles.includes("superAdmin"));

    // Payroll cost per unit (from payroll runs of the month).
    const payrollCost = [];
    for (const u of units) {
      const run = await ctx.db.collection("payrollRuns").doc(`${u}_${month}`).get();
      const r = run.exists ? (run.data() as PayrollRun) : null;
      payrollCost.push({ unit: u, salaryNetPaise: r?.totals.salaryNetPaise ?? 0, incentivePaise: r?.totals.incentivePaise ?? 0, status: r ? `${r.salaryStatus}/${r.incentiveStatus}` : "no run" });
    }

    // Attendance trend: per day counts for the month up to today.
    const trend = new Map<string, { present: number; late: number; absent: number; onLeave: number }>();
    for (const e of active) {
      const dates = eligibleDates(e, month, `${month}-31`).filter((d) => d <= today);
      for (const d of await loadDayDetails(ctx, e, dates, today)) {
        const row = trend.get(d.date) ?? { present: 0, late: 0, absent: 0, onLeave: 0 };
        if (d.present > 0) row.present++;
        if (d.late) row.late++;
        if (d.status === "absent") row.absent++;
        if (d.status === "approvedLeave") row.onLeave++;
        trend.set(d.date, row);
      }
    }
    const attendanceTrend = [...trend.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([date, v]) => ({ date, ...v }));

    // Discipline ranking (latest nightly leaderboard of each unit).
    const ranking: Array<LeaderboardEntry & { unit: string }> = [];
    for (const u of units) {
      const lb = await ctx.db.collection("leaderboards").doc(`${u}_${month}`).get();
      if (lb.exists) for (const e of (lb.data() as { entries: LeaderboardEntry[] }).entries) ranking.push({ ...e, unit: u });
    }

    // Sales by category per unit.
    const salesByCategory: Record<string, Record<string, number>> = {};
    for (const e of active) {
      const dates = eligibleDates(e, month, `${month}-31`);
      if (!dates.length) continue;
      const snaps = await ctx.db.getAll(...dates.map((d) => ctx.db.collection("dailySales").doc(salesId(e.employeeId, d))));
      for (const s of snaps) {
        if (!s.exists) continue;
        const bucket = (salesByCategory[e.businessId] ??= {});
        for (const [k, v] of Object.entries((s.data() as DailySalesDoc).values)) bucket[k] = (bucket[k] ?? 0) + v;
      }
    }

    // Leads funnel.
    const funnel = { new: 0, contacted: 0, followUp: 0, closedWon: 0, lost: 0 };
    for (const u of units) {
      const snaps = await ctx.db.collection("leads").where("businessId", "==", u).get();
      for (const d of snaps.docs) funnel[(d.data() as LeadDoc).status]++;
    }

    return { month, units, payrollCost, attendanceTrend, ranking, salesByCategory, funnel };
  });
}
