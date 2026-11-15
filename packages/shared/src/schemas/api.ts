import { z } from "zod";
import { businessCodeSchema, salesCategorySchema, timeOfDaySchema } from "./businessUnit.js";
import { slabSchema } from "../calc/incentive.js";
import { MOBILE_REGEX } from "../calc/employee.js";

export const ROLES = ["staff", "manager", "admin", "superAdmin"] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");
const monthStr = z.string().regex(/^\d{4}-\d{2}$/, "Month must be YYYY-MM");
export const mobileSchema = z.string().regex(MOBILE_REGEX, "Enter a 10-digit Indian mobile number");
export const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");
const rupees = z.number().int().min(0, "Amount must be 0 or more");

// ---- Auth ----
export const loginInput = z.object({ mobile: mobileSchema, pin: pinSchema });
export const changePinInput = z.object({ currentPin: pinSchema, newPin: pinSchema });
export const resetPinInput = z.object({ tempPin: pinSchema });

// ---- Business units ----
export const createUnitInput = z.object({
  name: z.string().min(1),
  code: businessCodeSchema,
  defaultShift: z.object({ start: timeOfDaySchema, end: timeOfDaySchema }).optional(),
});
export const updateUnitInput = z.object({
  name: z.string().min(1).optional(),
  active: z.boolean().optional(),
  location: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), radiusMeters: z.number().int().min(100).max(200) })
    .optional(),
  defaultShift: z.object({ start: timeOfDaySchema, end: timeOfDaySchema }).optional(),
  salesCategories: z.array(salesCategorySchema).optional(),
  holidays: z.array(z.object({ date: dateStr, name: z.string().min(1) })).optional(),
  reason: z.string().min(1).optional(),
});

// ---- Employees ----
export const bankSchema = z.object({
  accountHolder: z.string().min(1),
  accountNumber: z.string().regex(/^\d{6,20}$/, "Account number must be 6-20 digits"),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC"),
});

export const createEmployeeInput = z.object({
  name: z.string().min(1),
  mobile: mobileSchema,
  tempPin: pinSchema,
  businessId: businessCodeSchema,
  roles: z.array(roleSchema).min(1).default(["staff"]),
  designation: z.string().default(""),
  managerId: z.string().nullable().default(null),
  joiningDate: dateStr,
  shift: z.object({ start: timeOfDaySchema, end: timeOfDaySchema }).optional(),
  committedSalaryRupees: rupees,
  monthlyTargetRupees: rupees.nullable().default(null),
  slabs: z.array(slabSchema).optional(),
  bank: bankSchema.optional(),
  aadhaarLast4: z.string().regex(/^\d{4}$/, "Enter the last 4 digits of Aadhaar").optional(),
  requiresSalesEntry: z.boolean().optional(),
  /** Only for Admins: units they administer. Super Admin only. */
  adminBusinessIds: z.array(businessCodeSchema).default([]),
  canApprovePayrollFor: z.array(businessCodeSchema).default([]),
});

export const updateEmployeeInput = z.object({
  name: z.string().min(1).optional(),
  designation: z.string().optional(),
  managerId: z.string().nullable().optional(),
  roles: z.array(roleSchema).min(1).optional(),
  shift: z.object({ start: timeOfDaySchema, end: timeOfDaySchema }).optional(),
  committedSalaryRupees: rupees.optional(),
  bank: bankSchema.optional(),
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  requiresSalesEntry: z.boolean().optional(),
  adminBusinessIds: z.array(businessCodeSchema).optional(),
  canApprovePayrollFor: z.array(businessCodeSchema).optional(),
  reason: z.string().min(1, "A reason is required for changes"),
});

export const setTargetInput = z.object({
  monthlyTargetRupees: rupees.nullable(),
  slabs: z.array(slabSchema).min(1),
  reason: z.string().min(1),
});

export const exitEmployeeInput = z.object({
  exitDate: dateStr,
  leadReassignTo: z.string().optional(),
  reason: z.string().min(1),
});

export const DOCUMENT_KINDS = ["aadhaarFront", "aadhaarBack", "other"] as const;
export const documentUrlInput = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  remark: z.string().default(""),
  contentType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, "File must be 10 MB or smaller"),
  fileName: z.string().min(1),
});
export const documentRegisterInput = z.object({ docId: z.string().min(1) });

// ---- Attendance ----
export const gpsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0),
});
export const punchInput = z.object({ gps: gpsSchema, selfiePath: z.string().min(1) });
export const attendanceCorrectionInput = z.object({
  employeeId: z.string(),
  dateIST: dateStr,
  punchInAt: z.string().datetime().optional(),
  punchOutAt: z.string().datetime().nullable().optional(),
  halfDay: z.boolean().optional(),
  markAbsent: z.boolean().optional(),
  reason: z.string().min(1, "A reason is required"),
});

// ---- Sales ----
export const salesEntryInput = z.object({
  /** categoryId -> whole rupees (amount type) or integer count. */
  values: z.record(z.string(), z.number().int().min(0)).default({}),
  noSales: z.boolean().default(false),
});
export const salesCorrectionInput = z.object({
  employeeId: z.string(),
  dateIST: dateStr,
  values: z.record(z.string(), z.number().int().min(0)),
  reason: z.string().min(1, "A reason is required"),
});

// ---- Leave ----
export const leaveApplyInput = z.object({
  dates: z.array(dateStr).min(1).max(31),
  type: z.enum(["full", "half"]),
  reason: z.string().min(1),
});
export const leaveDecisionInput = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().default("") });

// ---- Tasks ----
export const repeatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6) }),
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1).max(31) }),
  z.object({ kind: z.literal("monthEnd") }),
]);
export type Repeat = z.infer<typeof repeatSchema>;

export const createTaskInput = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  assigneeId: z.string().optional(),
  dueAt: z.string().datetime().nullable().default(null),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  repeat: repeatSchema.default({ kind: "none" }),
});

// ---- Leads ----
export const LEAD_SOURCES = ["manual", "leadSheet", "whatsapp", "ads", "other"] as const;
export const LEAD_STATUSES = ["new", "contacted", "followUp", "closedWon", "lost"] as const;
export const createLeadInput = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  notes: z.string().default(""),
  source: z.enum(LEAD_SOURCES).default("manual"),
  assigneeId: z.string().optional(),
});
export const updateLeadInput = z.object({
  status: z.enum(LEAD_STATUSES),
  temperature: z.enum(["hot", "warm", "cold"]).optional(),
  nextFollowUpDate: dateStr.nullable().optional(),
  closedValueRupees: rupees.optional(),
  lostReason: z.string().optional(),
  note: z.string().default(""),
});
export const reassignLeadInput = z.object({ assigneeId: z.string() });
export const intakeInput = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  source: z.enum(LEAD_SOURCES),
  businessCode: businessCodeSchema,
  poolId: z.string().optional(),
  notes: z.string().default(""),
  externalId: z.string().optional(),
});
export const poolInput = z.object({
  businessId: businessCodeSchema,
  /** A lead source, or "all". */
  source: z.union([z.enum(LEAD_SOURCES), z.literal("all")]),
  staffOrder: z.array(z.string()).min(1),
  skipAbsent: z.boolean().default(true),
  managerId: z.string().optional(),
});

// ---- Payroll ----
export const advanceInput = z.object({
  employeeId: z.string(),
  amountRupees: z.number().int().positive(),
  date: dateStr,
  note: z.string().default(""),
});
export const adjustmentInput = z.object({
  employeeId: z.string(),
  amountRupees: z.number().int().refine((n) => n !== 0, "Amount cannot be 0"),
  reason: z.string().min(1, "A reason is required"),
});
export const payrollMonthParams = z.object({ unit: businessCodeSchema, month: monthStr });
export const monthQuery = z.object({ month: monthStr.optional() });
