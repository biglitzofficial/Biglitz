import { dateIST, dayOfMonth, minutesOfDayIST, parseTimeOfDay } from "./calc/time.js";

/**
 * Scheduled jobs (spec Section 13). Times are IST. One dispatcher runs every 5 minutes and
 * runs every job that is due and has no `jobRuns/{jobName}_{slot}` record yet.
 */
export type JobSchedule =
  | { kind: "daily"; at: string }
  | { kind: "monthly"; day: number; at: string }
  | { kind: "every5min"; from: string; to: string };

export interface JobDef {
  name: string;
  schedule: JobSchedule;
}

export const JOB_DEFS: readonly JobDef[] = [
  { name: "lateAlerts", schedule: { kind: "every5min", from: "05:30", to: "14:00" } },
  { name: "morningSummary", schedule: { kind: "daily", at: "09:45" } },
  { name: "followUpReminder", schedule: { kind: "daily", at: "10:00" } },
  { name: "recurringTasks", schedule: { kind: "daily", at: "00:05" } },
  { name: "dayClose", schedule: { kind: "daily", at: "00:15" } },
  { name: "payrollDraft", schedule: { kind: "monthly", day: 1, at: "06:00" } },
  { name: "monthlyRewards", schedule: { kind: "monthly", day: 1, at: "06:30" } },
];

const SLOT_MINUTES = 5;

/**
 * The slot key for a job if it is due at `now`, otherwise null. A daily/monthly job stays due
 * for the rest of its day once its time has passed (catch-up if one dispatcher run is missed);
 * the `jobRuns` record guarantees it still runs only once per slot.
 */
export function dueSlot(job: JobDef, now: Date): string | null {
  const s = job.schedule;
  const today = dateIST(now);
  const minutes = minutesOfDayIST(now);
  switch (s.kind) {
    case "daily":
      return minutes >= parseTimeOfDay(s.at) ? today : null;
    case "monthly":
      return dayOfMonth(today) === s.day && minutes >= parseTimeOfDay(s.at) ? today : null;
    case "every5min": {
      if (minutes < parseTimeOfDay(s.from) || minutes > parseTimeOfDay(s.to)) return null;
      const floored = minutes - (minutes % SLOT_MINUTES);
      const hh = String(Math.floor(floored / 60)).padStart(2, "0");
      const mm = String(floored % 60).padStart(2, "0");
      return `${today}T${hh}${mm}`;
    }
  }
}

export function jobRunId(jobName: string, slot: string): string {
  return `${jobName}_${slot}`;
}
