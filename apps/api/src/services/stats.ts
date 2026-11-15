import type { DocumentReference, DocumentSnapshot } from "firebase-admin/firestore";
import {
  addDays,
  computeMonthStats,
  daysInMonth,
  eligibleDays,
  onTimeStreak,
  presentValue,
  statusForPunchedDay,
  minutesOfDayIST,
  type AttendanceStatus,
  type DayRecord,
  type MonthStats,
} from "@biglitz/shared";
import type { AppContext } from "../context.js";
import type { AttendanceDoc, EmployeeDoc, LeaveDoc } from "../types.js";

export const attendanceId = (empId: string, date: string): string => `${empId}_${date}`;

async function getAll(ctx: AppContext, refs: DocumentReference[]): Promise<DocumentSnapshot[]> {
  if (refs.length === 0) return [];
  const out: DocumentSnapshot[] = [];
  for (let i = 0; i < refs.length; i += 300) out.push(...(await ctx.db.getAll(...refs.slice(i, i + 300))));
  return out;
}

/** Dates `from..to` inclusive (YYYY-MM-DD). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The effective status of an attendance doc (corrections included). `today` decides if the day is closed. */
export function effectiveStatus(att: AttendanceDoc, today: string): AttendanceStatus {
  if (att.absentOverride) return "absent";
  if (!att.punchInAt) return att.halfDay ? "halfDay" : "absent";
  return statusForPunchedDay({
    punchIn: att.punchInAt.toDate(),
    punchOut: att.punchOutAt ? att.punchOutAt.toDate() : null,
    shift: att.shift,
    halfDay: att.halfDay,
    closed: att.dateIST < today,
  });
}

export interface DayDetail extends DayRecord {
  status: AttendanceStatus;
  lateApplication: boolean;
  late: boolean;
}

/**
 * Per-day result for an employee (spec 8.1, 8.2). Leave rules:
 * - approved half-day leave => 0.5 present (never on time);
 * - approved full-day leave => leave day (present 0); on-time application => removed from working days;
 * - late application => counts as absent for discipline even if approved.
 */
export function dayDetail(date: string, att: AttendanceDoc | undefined, leave: LeaveDoc | undefined, today: string): DayDetail {
  const approved = leave?.status === "approved";
  const lateApplication = approved && !!leave?.lateApplication;
  if (att && att.absentOverride) {
    return { date, status: "absent", present: 0, onTime: false, approvedLeave: 0, lateApplication: false, late: false };
  }
  if (approved && leave?.type === "half") {
    return { date, status: "halfDay", present: 0.5, onTime: false, approvedLeave: lateApplication ? 0 : 0.5, lateApplication, late: false, punchInMinutes: att?.punchInAt ? minutesOfDayIST(att.punchInAt.toDate()) : null };
  }
  if (att && (att.punchInAt || att.halfDay)) {
    const status = effectiveStatus(att, today);
    const punchInMinutes = att.punchInAt ? minutesOfDayIST(att.punchInAt.toDate()) : null;
    const late = !!att.punchInAt && punchInMinutes !== null && punchInMinutes > Number(att.shift.start.slice(0, 2)) * 60 + Number(att.shift.start.slice(3));
    return { date, status, present: presentValue(status), onTime: status === "onTime", approvedLeave: 0, lateApplication: false, late, punchInMinutes };
  }
  if (approved) {
    return { date, status: "approvedLeave", present: 0, onTime: false, approvedLeave: lateApplication ? 0 : 1, lateApplication, late: false };
  }
  return { date, status: "absent", present: 0, onTime: false, approvedLeave: 0, lateApplication: false, late: false };
}

export interface EmployeePeriod {
  details: DayDetail[];
  stats: MonthStats;
}

/** Loads attendance/leave for `dates` and builds day details. */
export async function loadDayDetails(ctx: AppContext, emp: EmployeeDoc, dates: string[], today: string): Promise<DayDetail[]> {
  const [attSnaps, leaveSnaps] = await Promise.all([
    getAll(ctx, dates.map((d) => ctx.db.collection("attendance").doc(attendanceId(emp.employeeId, d)))),
    getAll(ctx, dates.map((d) => ctx.db.collection("leaveRequests").doc(attendanceId(emp.employeeId, d)))),
  ]);
  return dates.map((date, i) =>
    dayDetail(date, attSnaps[i]?.exists ? (attSnaps[i]?.data() as AttendanceDoc) : undefined, leaveSnaps[i]?.exists ? (leaveSnaps[i]?.data() as LeaveDoc) : undefined, today),
  );
}

/** Eligible dates of `month` up to `upTo` (inclusive), honouring joining and exit dates. */
export function eligibleDates(emp: EmployeeDoc, month: string, upTo: string): string[] {
  const D = daysInMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(D).padStart(2, "0")}`;
  const start = emp.joiningDate > first ? emp.joiningDate : first;
  let end = upTo < last ? upTo : last;
  if (emp.exitDate && emp.exitDate < end) end = emp.exitDate;
  return end < start ? [] : dateRange(start, end);
}

export async function monthPeriod(ctx: AppContext, emp: EmployeeDoc, month: string, upTo: string, today: string): Promise<EmployeePeriod> {
  const details = await loadDayDetails(ctx, emp, eligibleDates(emp, month, upTo), today);
  return { details, stats: computeMonthStats(details) };
}

/** On-time streak ending at `upTo`, looking back at most ~62 days. */
export async function streakAsOf(ctx: AppContext, emp: EmployeeDoc, upTo: string, today: string): Promise<number> {
  const from = addDays(upTo, -62);
  const start = emp.joiningDate > from ? emp.joiningDate : from;
  if (upTo < start) return 0;
  const end = emp.exitDate && emp.exitDate < upTo ? emp.exitDate : upTo;
  const details = await loadDayDetails(ctx, emp, dateRange(start, end), today);
  return onTimeStreak(details);
}

/** Payroll inputs for a completed month. */
export async function payrollAttendance(ctx: AppContext, emp: EmployeeDoc, month: string, today: string): Promise<{ D: number; E: number; P: number; details: DayDetail[] }> {
  const D = daysInMonth(month);
  const E = eligibleDays(month, emp.joiningDate, emp.exitDate);
  const last = `${month}-${String(D).padStart(2, "0")}`;
  const details = await loadDayDetails(ctx, emp, eligibleDates(emp, month, last), today);
  const P = details.reduce((s, d) => s + d.present, 0);
  return { D, E, P, details };
}
