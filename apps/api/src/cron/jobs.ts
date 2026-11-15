import { Timestamp } from "firebase-admin/firestore";
import { addDays, dateIST, minutesOfDayIST, parseTimeOfDay, previousMonthKey, monthKeyIST, type BusinessUnit } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import type { AttendanceDoc, EmployeeDoc, LeaveDoc } from "../types.js";
import type { LeadDoc } from "../services/leads.js";
import { generateRecurringFor } from "../services/recurring.js";
import { addAdjustment, createDraft, linesCol, runRef, type PayrollRun } from "../services/payroll.js";
import { advanceNoUnapprovedRun, computeScores, type LeaderboardEntry } from "../services/scores.js";
import { attendanceId, loadDayDetails } from "../services/stats.js";
import { counts } from "../routes/leads.js";
import { todayRow } from "../routes/dashboard.js";

export type JobHandler = (job: { slot: string; now: Date }) => Promise<void>;

const REWARD_PAISE = [500_000, 300_000, 100_000];

async function activeEmployees(ctx: AppContext): Promise<EmployeeDoc[]> {
  const snaps = await ctx.db.collection("employees").get();
  return snaps.docs.map((d) => d.data() as EmployeeDoc).filter((e) => e.status === "active");
}

/** Every body is idempotent: alerts use dedup keys, scores/drafts overwrite deterministically. */
export function buildHandlers(ctx: AppContext): Record<string, JobHandler> {
  return {
    // Late punch-in: shift start + 15 min passed, not punched in, not on approved leave -> WhatsApp the Manager once a day.
    async lateAlerts({ now }) {
      const today = dateIST(now);
      const nowMin = minutesOfDayIST(now);
      for (const e of await activeEmployees(ctx)) {
        if (e.roles.includes("superAdmin") || e.joiningDate > today || (e.exitDate && e.exitDate < today)) continue;
        if (nowMin < parseTimeOfDay(e.shift.start) + 15) continue;
        const att = (await ctx.db.collection("attendance").doc(attendanceId(e.employeeId, today)).get()).data() as AttendanceDoc | undefined;
        if (att?.punchInAt) continue;
        const leave = (await ctx.db.collection("leaveRequests").doc(attendanceId(e.employeeId, today)).get()).data() as LeaveDoc | undefined;
        if (leave?.status === "approved") continue;
        if (!e.managerId) continue;
        await ctx.notifier.send({ template: "late_punch_in", toEmployeeId: e.managerId, params: { name: e.name, shift: e.shift.start }, dedupKey: `late_${e.employeeId}_${today}` });
      }
    },

    async morningSummary({ now }) {
      const today = dateIST(now);
      const nowMin = minutesOfDayIST(now);
      const emps = await activeEmployees(ctx);
      const units = (await ctx.db.collection("businessUnits").get()).docs.map((d) => d.data() as BusinessUnit);
      const lines: Record<string, string> = {};
      for (const u of units) {
        const staff = emps.filter((e) => e.businessId === u.code && !e.roles.includes("superAdmin") && e.joiningDate <= today);
        const rows = [];
        for (const e of staff) rows.push(await todayRow(ctx, e, today, nowMin));
        lines[u.code] = `${u.code}: present ${rows.filter((r) => r.punchedIn).length}, late ${rows.filter((r) => r.late).length}, absent ${rows.filter((r) => r.state === "absent" || r.state === "notYet").length}, on leave ${rows.filter((r) => r.state === "onLeave").length}`;
      }
      for (const e of emps) {
        const isSuper = e.roles.includes("superAdmin");
        if (!isSuper && !e.roles.includes("admin")) continue;
        const mine = isSuper ? Object.values(lines) : e.adminBusinessIds.map((c) => lines[c]).filter((l): l is string => !!l);
        if (!mine.length) continue;
        await ctx.notifier.send({ template: "morning_summary", toEmployeeId: e.employeeId, params: { summary: mine.join(" | ") }, dedupKey: `morning_${e.employeeId}_${today}` });
      }
    },

    async followUpReminder({ now }) {
      const today = dateIST(now);
      const month = monthKeyIST(now);
      for (const e of await activeEmployees(ctx)) {
        const leads = (await ctx.db.collection("leads").where("assigneeId", "==", e.employeeId).get()).docs.map((d) => d.data() as LeadDoc);
        const c = counts(leads, today, month);
        if (c.todayFollowUps + c.overdue === 0) continue;
        await ctx.notifier.send({ template: "follow_up_reminder", toEmployeeId: e.employeeId, params: { today: c.todayFollowUps, overdue: c.overdue }, dedupKey: `followup_${e.employeeId}_${today}` });
      }
    },

    async recurringTasks({ now }) {
      await generateRecurringFor(ctx, dateIST(now));
    },

    // Finalise yesterday: exits, unapproved-absence counters, discipline scores, ranks, streaks, badges, leaderboards.
    async dayClose({ now }) {
      const today = dateIST(now);
      const yesterday = addDays(today, -1);
      for (const e of await activeEmployees(ctx)) {
        if (e.exitDate && e.exitDate < today) await ctx.db.collection("employees").doc(e.employeeId).update({ status: "exited" });
        if (e.roles.includes("superAdmin") || e.joiningDate > yesterday || (e.exitDate && e.exitDate < yesterday)) continue;
        const [d] = await loadDayDetails(ctx, e, [yesterday], today);
        if (d) await advanceNoUnapprovedRun(ctx, e, yesterday, d.status === "absent" || d.lateApplication);
      }
      await computeScores(ctx, yesterday, today);
    },

    async payrollDraft({ now }) {
      const today = dateIST(now);
      const month = previousMonthKey(today.slice(0, 7));
      const units = (await ctx.db.collection("businessUnits").get()).docs.map((d) => d.data() as BusinessUnit).filter((u) => u.active);
      for (const u of units) await createDraft(ctx, u.code, month, today);
    },

    // Top 3 Discipline Scores of the month just ended (one ranking across all units - default, see QUESTIONS.md).
    async monthlyRewards({ now }) {
      const today = dateIST(now);
      const month = previousMonthKey(today.slice(0, 7));
      const lb = await ctx.db.collection("leaderboards").doc(`ALL_${month}`).get();
      if (!lb.exists) return;
      const top = ((lb.data() as { entries: LeaderboardEntry[] }).entries).slice(0, 3);
      const winners = top.map((w, i) => ({ employeeId: w.employeeId, name: w.name, rank: i + 1, score: w.score, amountPaise: REWARD_PAISE[i] ?? 0 }));
      await ctx.db.collection("rewards").doc(month).set({ month, winners, createdAt: Timestamp.fromDate(ctx.clock()) });
      for (const w of winners) {
        const emp = (await ctx.db.collection("employees").doc(w.employeeId).get()).data() as EmployeeDoc;
        const run = await runRef(ctx, emp.businessId, month).get();
        if (!run.exists || (run.data() as PayrollRun).salaryStatus !== "draft") continue;
        if (!(await linesCol(ctx, emp.businessId, month).doc(w.employeeId).get()).exists) continue;
        await addAdjustment(ctx, emp.businessId, month, w.employeeId, { key: `reward_${month}`, kind: "bonus", amountPaise: w.amountPaise, reason: `Monthly discipline reward #${w.rank} (${month})`, by: "system", at: Timestamp.fromDate(ctx.clock()) }, today);
      }
    },
  };
}
