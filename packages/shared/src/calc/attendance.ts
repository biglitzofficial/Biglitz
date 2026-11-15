import { minutesOfDayIST, parseTimeOfDay } from "./time.js";

export type AttendanceStatus =
  | "onTime"
  | "late"
  | "earlyLeave"
  | "halfDay"
  | "missingPunchOut"
  | "present" // punched in, not yet punched out today
  | "approvedLeave"
  | "absent";

/** Spec 8.1: on time = punch-in <= shift start (to the minute, no grace) AND punch-out >= shift end. */
export function isOnTime(
  punchIn: Date,
  punchOut: Date | null,
  shift: { start: string; end: string },
): boolean {
  if (!punchOut) return false;
  return (
    minutesOfDayIST(punchIn) <= parseTimeOfDay(shift.start) &&
    minutesOfDayIST(punchOut) >= parseTimeOfDay(shift.end)
  );
}

export function isLatePunchIn(punchIn: Date, shiftStart: string): boolean {
  return minutesOfDayIST(punchIn) > parseTimeOfDay(shiftStart);
}

/** Status of a day that has a punch-in. `closed` = the day is over (past 23:59 IST). */
export function statusForPunchedDay(args: {
  punchIn: Date;
  punchOut: Date | null;
  shift: { start: string; end: string };
  halfDay: boolean;
  closed: boolean;
}): AttendanceStatus {
  const { punchIn, punchOut, shift, halfDay, closed } = args;
  if (halfDay) return "halfDay";
  if (!punchOut) return closed ? "missingPunchOut" : "present";
  if (minutesOfDayIST(punchOut) < parseTimeOfDay(shift.end)) return "earlyLeave";
  if (isLatePunchIn(punchIn, shift.start)) return "late";
  return "onTime";
}

/** How much of a day counts as present for each status. */
export function presentValue(status: AttendanceStatus): number {
  switch (status) {
    case "absent":
    case "approvedLeave":
      return 0;
    case "halfDay":
      return 0.5;
    default:
      return 1;
  }
}
