/** Business-day logic. All business dates are computed in Asia/Kolkata (UTC+5:30, no DST). */

export const IST_OFFSET_MINUTES = 330;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** A Date whose UTC fields hold the IST wall-clock time. */
function toIstWallClock(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MINUTES * MS_PER_MINUTE);
}

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

/** Business date `YYYY-MM-DD` in IST. */
export function dateIST(date: Date): string {
  const d = toIstWallClock(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Minutes since IST midnight, truncated (seconds ignored: 09:30:59 -> 570). */
export function minutesOfDayIST(date: Date): number {
  const d = toIstWallClock(date);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** `HH:mm` -> minutes since midnight. */
export function parseTimeOfDay(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`Invalid time "${hhmm}", expected HH:mm`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function monthKeyIST(date: Date): string {
  return dateIST(date).slice(0, 7);
}

/** Day of month (1-31) of a `YYYY-MM-DD` string. */
export function dayOfMonth(dateStr: string): number {
  return Number(dateStr.slice(8, 10));
}

/** 0 = Sunday ... 6 = Saturday, for a `YYYY-MM-DD` string. */
export function weekdayOf(dateStr: string): number {
  return parseDate(dateStr).getUTCDay();
}

function parseDate(dateStr: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error(`Invalid date "${dateStr}", expected YYYY-MM-DD`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function formatDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(dateStr: string, days: number): string {
  return formatDate(new Date(parseDate(dateStr).getTime() + days * MS_PER_DAY));
}

/** Whole calendar days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / MS_PER_DAY);
}

/** Days in month for `YYYY-MM`. */
export function daysInMonth(monthKey: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`Invalid month "${monthKey}", expected YYYY-MM`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

export function previousMonthKey(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`Invalid month "${monthKey}", expected YYYY-MM`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 2, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
