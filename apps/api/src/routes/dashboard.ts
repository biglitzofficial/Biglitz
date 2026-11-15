import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  daysInMonth,
  dateIST,
  eligibleDays,
  monthKeyIST,
  projectedSalary,
  addDays,
  minutesOfDayIST,
  parseTimeOfDay,
  salarySoFar,
  type BusinessUnit,
} from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { isAdminOf, isAnyAdmin, isManager, isSuperAdmin } from "../access.js";
import { forbidden } from "../http.js";
import type { AttendanceDoc, DailySalesDoc, EmployeeDoc, EmployeePayDoc, LeaveDoc } from "../types.js";
import { attendanceId, eligibleDates, loadDayDetails, streakAsOf } from "../services/stats.js";
import { salesId } from "../services/sales.js";
import type { LeadDoc } from "../services/leads.js";
import type { TaskDoc } from "../services/recurring.js";
import type { ScoreDoc, LeaderboardEntry } from "../services/scores.js";
import type { PayrollRun } from "../services/payroll.js";
import { summarizeTasks } from "./tasks.js";
import { counts } from "./leads.js";
import { listScopedEmployees } from "./employees.js";
import { guard } from "./guard.js";

export function registerDashboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  // Staff Home (spec 11.1.1).
  app.get("/api/me/home", pre, async (req) => {
    const emp = req.actor.emp;
    const now = ctx.clock();
    const today = dateIST(now);
    const month = monthKeyIST(now);
    const yesterday = addDays(today, -1);

    const attSnap = await ctx.db.collection("attendance").doc(attendanceId(emp.employeeId, today)).get();
    const att = attSnap.exists ? (attSnap.data() as AttendanceDoc) : null;

    const taskSnaps = await ctx.db.collection("tasks").where("assigneeId", "==", emp.employeeId).get();
    const tasks = summarizeTasks(taskSnaps.docs.map((d) => d.data() as TaskDoc).filter((t) => !t.isTemplate), now);

    const leadSnaps = await ctx.db.collection("leads").where("assigneeId", "==", emp.employeeId).get();
    const leadCounts = counts(leadSnaps.docs.map((d) => d.data() as LeadDoc), today, month);

    const salesSnap = await ctx.db.collection("dailySales").doc(salesId(emp.employeeId, today)).get();
    const salesToday = salesSnap.exists ? (salesSnap.data() as DailySalesDoc).amountTotalPaise : 0;

    // Salary so far / projected / leave used.
    const pay = (await ctx.db.collection("employeePay").doc(emp.employeeId).get()).data() as EmployeePayDoc;
    const D = daysInMonth(month);
    const E = eligibleDays(month, emp.joiningDate, emp.exitDate);
    const throughToday = await loadDayDetails(ctx, emp, eligibleDates(emp, month, today), today);
    const presentSoFar = throughToday.reduce((s, d) => s + d.present, 0);
    const prior = eligibleDates(emp, month, yesterday);
    const todayCounted = att?.punchInAt ? 1 : 0;
    const remaining = Math.max(0, E - prior.length - todayCounted);
    const priorPresent = throughToday.filter((d) => d.date <= yesterday).reduce((s, d) => s + d.present, 0);
    const leaveUsed = Math.max(0, prior.length - priorPresent);

    const scoreSnap = await ctx.db.collection("scores").doc(`${emp.employeeId}_${month}`).get();
    const score = scoreSnap.exists ? (scoreSnap.data() as ScoreDoc) : null;
    let gap: { toRank: number; points: number } | null = null;
    if (score && score.rank > 1) {
      const lb = await ctx.db.collection("leaderboards").doc(`${emp.businessId}_${month}`).get();
      const entries = lb.exists ? ((lb.data() as { entries: LeaderboardEntry[] }).entries) : [];
      const above = entries.find((e) => e.rank === score.rank - 1);
      if (above) gap = { toRank: above.rank, points: Math.round((above.score - score.score) * 10) / 10 };
    }
    const streak = score ? score.streak : await streakAsOf(ctx, emp, yesterday, today);

    return {
      dateIST: today,
      attendance: att ? { punchedIn: !!att.punchInAt, punchedOut: !!att.punchOutAt } : { punchedIn: false, punchedOut: false },
      tasks: { done: tasks.todayDone, total: tasks.todayTotal, pending: tasks.pending, overdue: tasks.overdue },
      followUps: { today: leadCounts.todayFollowUps, overdue: leadCounts.overdue },
      salesTodayPaise: salesToday,
      salarySoFarPaise: salarySoFar(pay.committedPaise, presentSoFar),
      projectedSalaryPaise: projectedSalary({ committedPaise: pay.committedPaise, D, E, presentSoFar, remainingEligibleDays: remaining }),
      leave: { used: leaveUsed, free: 2, overFree: leaveUsed > 2 },
      rank: score ? { unit: score.rank, all: score.rankAll, score: score.score, gap } : null,
      streak,
    };
  });

  app.get("/api/me/scores", pre, async (req) => {
    const month = monthKeyIST(ctx.clock());
    const snap = await ctx.db.collection("scores").doc(`${req.actor.id}_${month}`).get();
    return { score: snap.exists ? snap.data() : null };
  });

  // Leaderboard: rank + name + score only. Own unit, or all units.
  app.get("/api/leaderboard", pre, async (req) => {
    const q = z.object({ scope: z.enum(["unit", "all"]).default("unit"), unit: z.string().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional() }).parse(req.query);
    const month = q.month ?? monthKeyIST(ctx.clock());
    const unit = q.unit ?? req.actor.emp.businessId;
    if (unit !== req.actor.emp.businessId && !isAdminOf(req.actor, unit)) throw forbidden("You can only see your own unit's ranking.");
    const id = q.scope === "all" ? `ALL_${month}` : `${unit}_${month}`;
    const snap = await ctx.db.collection("leaderboards").doc(id).get();
    const entries = snap.exists ? ((snap.data() as { entries: LeaderboardEntry[] }).entries) : [];
    return {
      month,
      entries: entries.map((e) => ({ employeeId: e.employeeId, name: e.name, photoPath: e.photoPath, rank: e.rank, score: e.score, streak: e.streak, badges: e.badges })),
    };
  });

  app.get("/api/rewards", pre, async (req) => {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.query);
    const snap = await ctx.db.collection("rewards").doc(month).get();
    return { rewards: snap.exists ? snap.data() : null };
  });

  // Team Today (Manager / Admin): who is in, late, absent, on leave, sales reported.
  app.get("/api/dashboard/today", pre, async (req) => {
    const a = req.actor;
    if (!isManager(a) && !isAnyAdmin(a)) throw forbidden("Only Managers and Admins can see the team view.");
    const q = z.object({ unit: z.string().optional() }).parse(req.query);
    const now = ctx.clock();
    const today = dateIST(now);
    const nowMin = minutesOfDayIST(now);
    const team = (await listScopedEmployees(ctx, a, q.unit)).filter((e) => e.employeeId !== a.id && e.status === "active" && e.joiningDate <= today);
    const rows = [];
    for (const e of team) rows.push(await todayRow(ctx, e, today, nowMin));
    const summary = {
      total: rows.length,
      present: rows.filter((r) => r.punchedIn).length,
      late: rows.filter((r) => r.late).length,
      absent: rows.filter((r) => r.state === "absent").length,
      onLeave: rows.filter((r) => r.state === "onLeave").length,
      salesNotReported: rows.filter((r) => r.requiresSales && !r.salesReported).length,
    };
    return { dateIST: today, summary, team: rows };
  });

  // Super Admin overview: all units on one screen (spec 11.4).
  app.get("/api/dashboard/overview", pre, async (req) => {
    const a = req.actor;
    if (!isSuperAdmin(a)) throw forbidden("Only the Super Admin can see the overview.");
    const now = ctx.clock();
    const today = dateIST(now);
    const nowMin = minutesOfDayIST(now);
    const month = monthKeyIST(now);
    const units = (await ctx.db.collection("businessUnits").get()).docs.map((d) => d.data() as BusinessUnit);
    const emps = (await ctx.db.collection("employees").get()).docs.map((d) => d.data() as EmployeeDoc).filter((e) => e.status === "active" && !e.roles.includes("superAdmin") && e.joiningDate <= today);
    const prevMonthKey = monthKeyIST(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 2, 15)));
    const out = [];
    for (const u of units) {
      const list = emps.filter((e) => e.businessId === u.code);
      const rows = [];
      for (const e of list) rows.push(await todayRow(ctx, e, today, nowMin));
      let assigned = 0;
      let done = 0;
      let followUps = 0;
      const salesByCategory: Record<string, number> = {};
      for (const e of list) {
        const ts = (await ctx.db.collection("tasks").where("assigneeId", "==", e.employeeId).get()).docs.map((d) => d.data() as TaskDoc).filter((t) => !t.isTemplate);
        const s = summarizeTasks(ts, now);
        assigned += s.todayTotal;
        done += s.todayDone;
        const ls = (await ctx.db.collection("leads").where("assigneeId", "==", e.employeeId).get()).docs.map((d) => d.data() as LeadDoc);
        const c = counts(ls, today, month);
        followUps += c.todayFollowUps + c.overdue;
        const sale = await ctx.db.collection("dailySales").doc(salesId(e.employeeId, today)).get();
        if (sale.exists) for (const [k, v] of Object.entries((sale.data() as DailySalesDoc).values)) salesByCategory[k] = (salesByCategory[k] ?? 0) + v;
      }
      const run = await ctx.db.collection("payrollRuns").doc(`${u.code}_${prevMonthKey}`).get();
      out.push({
        unit: u.code,
        name: u.name,
        present: rows.filter((r) => r.punchedIn).length,
        late: rows.filter((r) => r.late).length,
        absent: rows.filter((r) => r.state === "absent").length,
        onLeave: rows.filter((r) => r.state === "onLeave").length,
        tasks: { assigned, done },
        followUpsDue: followUps,
        salesByCategory,
        payroll: run.exists ? { month: prevMonthKey, salary: (run.data() as PayrollRun).salaryStatus, incentive: (run.data() as PayrollRun).incentiveStatus } : null,
      });
    }
    return { dateIST: today, units: out };
  });

}

export type TodayState = "present" | "onLeave" | "absent" | "notYet";

/** `notYet` = hasn't punched in but the shift start has not passed yet; `absent` = shift started, no punch, no leave. */
export async function todayRow(ctx: AppContext, e: EmployeeDoc, today: string, nowMin: number) {
  const att = (await ctx.db.collection("attendance").doc(attendanceId(e.employeeId, today)).get()).data() as AttendanceDoc | undefined;
  const leave = (await ctx.db.collection("leaveRequests").doc(attendanceId(e.employeeId, today)).get()).data() as LeaveDoc | undefined;
  const sales = await ctx.db.collection("dailySales").doc(salesId(e.employeeId, today)).get();
  const punchedIn = !!att?.punchInAt;
  const shiftStart = parseTimeOfDay(e.shift.start);
  const late = punchedIn && att?.punchInAt ? minutesOfDayIST(att.punchInAt.toDate()) > shiftStart : false;
  let state: TodayState = "notYet";
  if (punchedIn) state = "present";
  else if (leave?.status === "approved") state = "onLeave";
  else if (nowMin > shiftStart) state = "absent";
  return {
    employeeId: e.employeeId,
    name: e.name,
    businessId: e.businessId,
    state,
    punchedIn,
    punchedOut: !!att?.punchOutAt,
    punchInAt: att?.punchInAt?.toDate().toISOString() ?? null,
    late,
    requiresSales: e.requiresSalesEntry,
    salesReported: sales.exists,
  };
}
