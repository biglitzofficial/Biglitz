import type { BusinessUnit, Role, SalesCategory, Slab } from "@biglitz/shared";

export type { BusinessUnit, Role, SalesCategory, Slab };

export interface Employee {
  employeeId: string;
  name: string;
  mobile: string;
  photoPath: string | null;
  businessId: string;
  roles: Role[];
  designation: string;
  managerId: string | null;
  joiningDate: string;
  exitDate: string | null;
  status: "pending" | "active" | "exited";
  shift: { start: string; end: string };
  requiresSalesEntry: boolean;
  adminBusinessIds: string[];
  canApprovePayrollFor: string[];
}

export interface Me {
  employee: Employee;
  mustChangePin: boolean;
  unit: { code: string; name: string; hasSales: boolean; location: { lat: number; lng: number; radiusMeters: number } | null };
}

export interface AttendanceSummary {
  state: "notPunchedIn" | "punchedIn" | "punchedOut";
  status?: string;
  punchInAt?: string | null;
  punchOutAt?: string | null;
  halfDay?: boolean;
}

export interface Home {
  dateIST: string;
  attendance: { punchedIn: boolean; punchedOut: boolean };
  tasks: { done: number; total: number; pending: number; overdue: number };
  followUps: { today: number; overdue: number };
  salesTodayPaise: number;
  salarySoFarPaise: number;
  projectedSalaryPaise: number;
  pendingDeductionPaise?: number;
  leave: { used: number; free: number; overFree: boolean };
  rank: { unit: number; all: number; score: number; gap: { toRank: number; points: number } | null } | null;
  streak: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  assigneeId: string;
  assignedBy: string;
  dueAt: string | null;
  priority: "low" | "normal" | "high";
  status: "todo" | "done";
  repeat: { kind: string; weekday?: number; day?: number };
  doneAt: string | null;
}

export type LeadStatus = "new" | "contacted" | "followUp" | "closedWon" | "lost";

export interface Lead {
  id: string;
  name: string;
  phone: string;
  notes: string;
  source: string;
  businessId: string;
  assigneeId: string | null;
  status: LeadStatus;
  temperature: "hot" | "warm" | "cold" | null;
  nextFollowUpDate: string | null;
  closedValuePaise: number | null;
  lostReason: string | null;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  employeeName?: string;
  dateIST: string;
  type: "full" | "half";
  reason: string;
  lateApplication: boolean;
  status: "pending" | "approved" | "rejected";
  appliedDateIST: string;
}

export interface TodayRow {
  employeeId: string;
  name: string;
  businessId: string;
  state: "present" | "onLeave" | "absent" | "notYet";
  punchedIn: boolean;
  punchedOut: boolean;
  punchInAt: string | null;
  late: boolean;
  requiresSales: boolean;
  salesReported: boolean;
}

export interface LeaderRow {
  employeeId: string;
  name: string;
  rank: number;
  score: number;
  streak: number;
  badges: string[];
}

export interface PayrollLine {
  employeeId: string;
  name: string;
  committedPaise: number;
  D: number;
  E: number;
  P: number;
  leaveDays: number;
  payableDays: number;
  salaryPaise: number;
  advanceRecoveredPaise: number;
  advanceCarriedPaise: number;
  adjustments: Array<{ kind: string; amountPaise: number; reason: string }>;
  adjustmentsTotalPaise: number;
  netSalaryPaise: number;
  incentive: { monthlySalesPaise: number; targetPaise: number | null; achievementPct: number; rateBps: number; incentivePaise: number };
  bank: { accountHolder: string; accountNumber: string; ifsc: string } | null;
}

export type PartStatus = "draft" | "submitted" | "approved" | "paid";

export interface PayrollRun {
  unit: string;
  month: string;
  salaryStatus: PartStatus;
  incentiveStatus: PartStatus;
  locked: boolean;
  totals: { salaryNetPaise: number; incentivePaise: number; employees: number };
}
