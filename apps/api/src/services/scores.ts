import { Timestamp } from "firebase-admin/firestore";
import { addDays, computeBadges, daysInMonth, rankEmployees, type BadgeId } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import type { EmployeeDoc } from "../types.js";
import { monthPeriod, streakAsOf } from "./stats.js";

export interface ScoreDoc {
  employeeId: string;
  businessId: string;
  month: string;
  upTo: string;
  score: number;
  attendancePct: number;
  punctualityPct: number;
  presentDays: number;
  onTimeDays: number;
  workingDays: number;
  streak: number;
  avgPunchInMinutes: number | null;
  badges: BadgeId[];
  rank: number;
  rankAll: number;
}

export interface LeaderboardEntry {
  employeeId: string;
  name: string;
  photoPath: string | null;
  score: number;
  rank: number;
  streak: number;
  badges: BadgeId[];
}

export const scoreId = (empId: string, month: string): string => `${empId}_${month}`;

/** All-day counter of consecutive days without an unapproved absence (spec 8.8 badge). */
export async function advanceNoUnapprovedRun(ctx: AppContext, emp: EmployeeDoc, date: string, wasUnapprovedAbsence: boolean): Promise<number> {
  const ref = ctx.db.collection("scoreState").doc(emp.employeeId);
  return ctx.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? (snap.data() as { run: number; lastDate: string }) : { run: 0, lastDate: "" };
    if (cur.lastDate >= date) return cur.run; // idempotent: already processed this day
    const run = wasUnapprovedAbsence ? 0 : cur.run + 1;
    tx.set(ref, { run, lastDate: date });
    return run;
  });
}

/**
 * Computes month-to-date (up to `upTo`) discipline scores for every employee, ranks them within each unit and
 * across all units, and writes `scores` + `leaderboards`. Safe to re-run: all docs are overwritten deterministically.
 */
export async function computeScores(ctx: AppContext, upTo: string, today: string): Promise<{ count: number }> {
  const month = upTo.slice(0, 7);
  const empSnaps = await ctx.db.collection("employees").get();
  const emps = empSnaps.docs.map((d) => d.data() as EmployeeDoc).filter((e) => e.status !== "pending" && !e.roles.includes("superAdmin"));

  interface Row {
    emp: EmployeeDoc;
    score: number;
    attendancePct: number;
    punctualityPct: number;
    presentDays: number;
    onTimeDays: number;
    workingDays: number;
    streak: number;
    avgPunchInMinutes: number | null;
    badges: BadgeId[];
  }
  const rows: Row[] = [];
  const monthComplete = upTo === `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  for (const emp of emps) {
    const period = await monthPeriod(ctx, emp, month, upTo, today);
    if (period.stats.eligibleDays === 0) continue;
    const streak = await streakAsOf(ctx, emp, upTo, today);
    const stateSnap = await ctx.db.collection("scoreState").doc(emp.employeeId).get();
    const run = stateSnap.exists ? (stateSnap.data() as { run: number }).run : 0;
    const lateDates = new Set(period.details.filter((d) => d.late).map((d) => d.date));
    const badges = computeBadges({ currentMonthDays: period.details, monthComplete, streak, daysWithoutUnapprovedLeave: run, lateDates });
    rows.push({ emp, score: period.stats.score, attendancePct: period.stats.attendancePct, punctualityPct: period.stats.punctualityPct, presentDays: period.stats.presentDays, onTimeDays: period.stats.onTimeDays, workingDays: period.stats.workingDays, streak, avgPunchInMinutes: period.stats.avgPunchInMinutes, badges });
  }

  const rankInput = (r: Row) => ({ id: r.emp.employeeId, score: r.score, streak: r.streak, avgPunchInMinutes: r.avgPunchInMinutes });
  const allRanked = rankEmployees(rows.map(rankInput));
  const rankAll = new Map(allRanked.map((r) => [r.id, r.rank]));
  const byUnit = new Map<string, Row[]>();
  for (const r of rows) byUnit.set(r.emp.businessId, [...(byUnit.get(r.emp.businessId) ?? []), r]);

  const batch = ctx.db.batch();
  const makeEntries = (list: Row[], rankMap: Map<string, number>): LeaderboardEntry[] =>
    list
      .map((r) => ({ employeeId: r.emp.employeeId, name: r.emp.name, photoPath: r.emp.photoPath, score: r.score, rank: rankMap.get(r.emp.employeeId) ?? 0, streak: r.streak, badges: r.badges }))
      .sort((x, y) => x.rank - y.rank);

  for (const [unit, list] of byUnit) {
    const ranked = rankEmployees(list.map(rankInput));
    const unitRank = new Map(ranked.map((r) => [r.id, r.rank]));
    for (const r of list) {
      const doc: ScoreDoc = { employeeId: r.emp.employeeId, businessId: unit, month, upTo, score: r.score, attendancePct: r.attendancePct, punctualityPct: r.punctualityPct, presentDays: r.presentDays, onTimeDays: r.onTimeDays, workingDays: r.workingDays, streak: r.streak, avgPunchInMinutes: r.avgPunchInMinutes, badges: r.badges, rank: unitRank.get(r.emp.employeeId) ?? 0, rankAll: rankAll.get(r.emp.employeeId) ?? 0 };
      batch.set(ctx.db.collection("scores").doc(scoreId(r.emp.employeeId, month)), doc);
    }
    batch.set(ctx.db.collection("leaderboards").doc(`${unit}_${month}`), { unit, month, upTo, entries: makeEntries(list, unitRank), updatedAt: Timestamp.fromDate(ctx.clock()) });
  }
  batch.set(ctx.db.collection("leaderboards").doc(`ALL_${month}`), { unit: "ALL", month, upTo, entries: makeEntries(rows, rankAll), updatedAt: Timestamp.fromDate(ctx.clock()) });
  await batch.commit();
  return { count: rows.length };
}

export const previousDay = (d: string): string => addDays(d, -1);
