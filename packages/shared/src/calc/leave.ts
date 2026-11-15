import { diffDays } from "./time.js";

/**
 * Spec 8.2 two-day rule: applied at least 2 calendar days before the leave date (IST dates)
 * => normal; otherwise `lateApplication` (counts as absent for discipline even if approved).
 */
export function isLateApplication(applyDateIST: string, leaveDateIST: string): boolean {
  return diffDays(applyDateIST, leaveDateIST) < 2;
}

export interface LeaveDayOutcome {
  /** True if the day is an approved leave for discipline (removed from working days). */
  approvedForDiscipline: boolean;
  lateApplication: boolean;
}

export function leaveOutcome(applyDateIST: string, leaveDateIST: string, approved: boolean): LeaveDayOutcome {
  const lateApplication = isLateApplication(applyDateIST, leaveDateIST);
  return { approvedForDiscipline: approved && !lateApplication, lateApplication };
}
