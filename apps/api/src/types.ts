import type { Timestamp } from "firebase-admin/firestore";
import type { Role, Slab } from "@biglitz/shared";

export interface EmployeeDoc {
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
  createdAt: Timestamp;
}

export interface EmployeePayDoc {
  committedPaise: number;
  bank: { accountHolder: string; accountNumber: string; ifsc: string } | null;
  aadhaarLast4: string | null;
}

export interface EmployeeTargetDoc {
  /** Total monthly target (sum of amount-category targets). Used for incentive % (spec 8.6). */
  targetPaise: number | null;
  /** Per sales-category targets in paise (amount categories). Optional for older docs. */
  categoryTargetsPaise?: Record<string, number>;
  slabs: Slab[];
}

export interface AuthPinDoc {
  pinHash: string;
  failedAttempts: number;
  lockedUntil: Timestamp | null;
  mustChangePin: boolean;
}

export interface PunchInfo {
  lat: number;
  lng: number;
  accuracy: number;
  distanceMeters: number;
  selfiePath: string;
}

export interface AttendanceDoc {
  employeeId: string;
  businessId: string;
  dateIST: string;
  punchInAt: Timestamp | null;
  punchOutAt: Timestamp | null;
  punchIn: PunchInfo | null;
  punchOut: PunchInfo | null;
  shift: { start: string; end: string };
  halfDay: boolean;
  absentOverride: boolean;
  corrections: Array<{
    by: string;
    at: Timestamp;
    reason: string;
    before: Record<string, unknown>;
  }>;
}

export interface LeaveDoc {
  employeeId: string;
  businessId: string;
  managerId: string | null;
  dateIST: string;
  type: "full" | "half";
  reason: string;
  appliedDateIST: string;
  appliedAt: Timestamp;
  lateApplication: boolean;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: Timestamp | null;
  decisionNote: string;
}

export interface DailySalesDoc {
  employeeId: string;
  businessId: string;
  dateIST: string;
  /** categoryId -> paise (amount) or count. */
  values: Record<string, number>;
  amountTotalPaise: number;
  noSales: boolean;
  submittedAt: Timestamp;
  corrections: Array<{ by: string; at: Timestamp; reason: string; before: Record<string, number> }>;
}
