import type { Harness } from "./harness.js";

export interface NewEmployee {
  name: string;
  mobile: string;
  businessId?: string;
  roles?: string[];
  managerId?: string | null;
  joiningDate?: string;
  committedSalaryRupees?: number;
  monthlyTargetRupees?: number | null;
  tempPin?: string;
  adminBusinessIds?: string[];
  canApprovePayrollFor?: string[];
  shift?: { start: string; end: string };
  requiresSalesEntry?: boolean;
}

/** Creates an employee through the API as `as`, uploads Aadhaar, activates, and sets a permanent PIN. Returns the id. */
export async function createStaff(h: Harness, e: NewEmployee, as = "SA001", opts: { activate?: boolean } = {}): Promise<string> {
  const res = await h.call("POST", "/api/employees", {
    as,
    body: {
      name: e.name,
      mobile: e.mobile,
      tempPin: e.tempPin ?? "5802",
      businessId: e.businessId ?? "BM",
      roles: e.roles ?? ["staff"],
      managerId: e.managerId ?? null,
      joiningDate: e.joiningDate ?? "2026-01-01",
      committedSalaryRupees: e.committedSalaryRupees ?? 15000,
      monthlyTargetRupees: e.monthlyTargetRupees === undefined ? 300000 : e.monthlyTargetRupees,
      aadhaarLast4: "4321",
      bank: { accountHolder: e.name, accountNumber: "123456789012", ifsc: "SBIN0001234" },
      adminBusinessIds: e.adminBusinessIds ?? [],
      canApprovePayrollFor: e.canApprovePayrollFor ?? [],
      ...(e.shift ? { shift: e.shift } : {}),
      ...(e.requiresSalesEntry !== undefined ? { requiresSalesEntry: e.requiresSalesEntry } : {}),
    },
  });
  if (res.status !== 200) throw new Error(`createStaff failed: ${res.status} ${res.raw}`);
  const id = res.body.employee.employeeId as string;
  if (opts.activate === false) return id;
  await uploadAadhaar(h, id, as);
  const act = await h.call("POST", `/api/employees/${id}/activate`, { as });
  if (act.status !== 200) throw new Error(`activate failed: ${act.status} ${act.raw}`);
  // Employee logs in with the temp PIN and must set a permanent one.
  const login = await h.call("POST", "/api/auth/login", { body: { mobile: e.mobile, pin: e.tempPin ?? "5802" } });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.raw}`);
  const change = await h.call("POST", "/api/auth/change-pin", { as: id, body: { currentPin: e.tempPin ?? "5802", newPin: "4821" } });
  if (change.status !== 200) throw new Error(`change-pin failed: ${change.status} ${change.raw}`);
  return id;
}

export async function uploadAadhaar(h: Harness, id: string, as = "SA001"): Promise<void> {
  for (const kind of ["aadhaarFront", "aadhaarBack"] as const) {
    const up = await h.call("POST", `/api/employees/${id}/documents/upload-url`, {
      as,
      body: { kind, remark: "", contentType: "image/jpeg", sizeBytes: 1000, fileName: `${kind}.jpg` },
    });
    if (up.status !== 200) throw new Error(`upload-url failed: ${up.status} ${up.raw}`);
    h.files.put(up.body.path);
    const reg = await h.call("POST", `/api/employees/${id}/documents/register`, { as, body: { docId: up.body.docId } });
    if (reg.status !== 200) throw new Error(`register failed: ${reg.status} ${reg.raw}`);
  }
}

/** Punch in/out helpers (a selfie file is "uploaded" first). */
export async function punch(h: Harness, id: string, kind: "in" | "out", gps: { lat: number; lng: number; accuracy: number }) {
  const slot = await h.call("POST", "/api/uploads/selfie-url", { as: id, body: { kind } });
  h.files.put(slot.body.path);
  return h.call("POST", `/api/attendance/punch-${kind}`, { as: id, body: { gps, selfiePath: slot.body.path } });
}

export async function submitNoSales(h: Harness, id: string) {
  return h.call("POST", "/api/sales/today", { as: id, body: { noSales: true } });
}
