export interface DayRecord {
  date: string;
  /** 0, 0.5 or 1. */
  present: number;
  onTime: boolean;
  /** Approved leave for discipline (on-time application, approved): 0, 0.5 or 1. */
  approvedLeave: number;
  /** Minutes since IST midnight of the punch-in, if any. */
  punchInMinutes?: number | null;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export interface MonthStats {
  eligibleDays: number;
  workingDays: number;
  presentDays: number;
  onTimeDays: number;
  approvedLeaveDays: number;
  attendancePct: number;
  punctualityPct: number;
  /** One decimal place. */
  score: number;
  avgPunchInMinutes: number | null;
}

/** Spec 8.7. `days` are all eligible days so far (month-to-date up to yesterday). */
export function computeMonthStats(days: readonly DayRecord[]): MonthStats {
  const eligibleDays = days.length;
  const approvedLeaveDays = days.reduce((s, d) => s + d.approvedLeave, 0);
  const presentDays = days.reduce((s, d) => s + d.present, 0);
  const onTimeDays = days.filter((d) => d.onTime).length;
  const workingDays = eligibleDays - approvedLeaveDays;
  const attendancePct = workingDays > 0 ? (presentDays / workingDays) * 100 : 0;
  const punctualityPct = presentDays > 0 ? (onTimeDays / presentDays) * 100 : 0;
  const score = round1((attendancePct + punctualityPct) / 2);
  const punches = days.map((d) => d.punchInMinutes).filter((m): m is number => typeof m === "number");
  return {
    eligibleDays,
    workingDays,
    presentDays,
    onTimeDays,
    approvedLeaveDays,
    attendancePct,
    punctualityPct,
    score,
    avgPunchInMinutes: punches.length ? punches.reduce((a, b) => a + b, 0) / punches.length : null,
  };
}

/**
 * Current on-time streak: walk back from the latest day. On time = +1; approved leave is skipped
 * (does not break); anything else (late, early leave, half day, missing punch-out, absent) breaks.
 */
export function onTimeStreak(days: readonly DayRecord[]): number {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : 1));
  let streak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const d = sorted[i];
    if (!d) break;
    if (d.onTime) streak++;
    else if (d.approvedLeave > 0 && d.present === 0) continue;
    else break;
  }
  return streak;
}

export interface RankInput {
  id: string;
  score: number;
  streak: number;
  avgPunchInMinutes: number | null;
}

/** Rank by score desc; ties: longer streak, then earlier average punch-in. Equal on all = same rank. */
export function rankEmployees<T extends RankInput>(items: readonly T[]): Array<T & { rank: number }> {
  const sorted = [...items].sort(
    (a, b) =>
      b.score - a.score ||
      b.streak - a.streak ||
      (a.avgPunchInMinutes ?? Infinity) - (b.avgPunchInMinutes ?? Infinity) ||
      (a.id < b.id ? -1 : 1),
  );
  return sorted.map((item, i) => ({ ...item, rank: i + 1 }));
}

export type BadgeId = "neverLate" | "fullAttendance" | "streak30" | "noUnapprovedLeave100";

export interface BadgeInput {
  /** All eligible days of the current month so far, plus days before for the 100-day badge. */
  currentMonthDays: readonly DayRecord[];
  monthComplete: boolean;
  /** Streak in on-time days. */
  streak: number;
  /** Consecutive days (ending yesterday) with no unapproved absence. */
  daysWithoutUnapprovedLeave: number;
  /** Set of dates where punch-in was after shift start. */
  lateDates: ReadonlySet<string>;
}

/**
 * Badge definitions (spec 8.8 names; exact criteria logged in QUESTIONS.md):
 * - neverLate: punched in on time (<= shift start) on every present day this month, >= 1 present day.
 * - fullAttendance: month complete, present every eligible day, no leave of any kind.
 * - streak30: on-time streak >= 30.
 * - noUnapprovedLeave100: >= 100 consecutive days with no unapproved absence.
 */
export function computeBadges(input: BadgeInput): BadgeId[] {
  const badges: BadgeId[] = [];
  const { currentMonthDays: days } = input;
  const presentDays = days.filter((d) => d.present > 0);
  if (presentDays.length > 0 && !presentDays.some((d) => input.lateDates.has(d.date))) badges.push("neverLate");
  if (input.monthComplete && days.length > 0 && days.every((d) => d.present === 1)) badges.push("fullAttendance");
  if (input.streak >= 30) badges.push("streak30");
  if (input.daysWithoutUnapprovedLeave >= 100) badges.push("noUnapprovedLeave100");
  return badges;
}
