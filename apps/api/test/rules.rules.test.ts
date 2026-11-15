import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";

// rules-unit-testing returns the firebase *compat* Firestore; use its methods directly.
interface Ref {
  get(): Promise<unknown>;
  set(data: object): Promise<void>;
  update(data: object): Promise<void>;
  delete(): Promise<void>;
}
interface Db {
  doc(path: string): Ref;
}
const doc = (db: Db, path: string): Ref => db.doc(path);
const getDoc = (r: Ref) => r.get();
const setDoc = (r: Ref, data: object) => r.set(data);
const updateDoc = (r: Ref, data: object) => r.update(data);
const deleteDoc = (r: Ref) => r.delete();

/**
 * Firestore security rules tests (acceptance 13). Run in the Firebase emulator:
 *   npm run test:rules -w @biglitz/api
 */
let env: RulesTestEnvironment;

const emp = (id: string, extra: Record<string, unknown>) => ({
  employeeId: id,
  name: id,
  businessId: "BM",
  roles: ["staff"],
  managerId: null,
  adminBusinessIds: [],
  status: "active",
  ...extra,
});

beforeAll(async () => {
  const host = (process.env["FIRESTORE_EMULATOR_HOST"] ?? "127.0.0.1:8081").split(":");
  env = await initializeTestEnvironment({
    projectId: "demo-biglitz-rules",
    firestore: { rules: readFileSync(resolve(import.meta.dirname, "../../../firestore.rules"), "utf8"), host: host[0] ?? "127.0.0.1", port: Number(host[1] ?? 8081) },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Db;
    await setDoc(doc(db, "employees/SA"), emp("SA", { roles: ["superAdmin"] }));
    await setDoc(doc(db, "employees/ADM"), emp("ADM", { roles: ["admin"], adminBusinessIds: ["BM"] }));
    await setDoc(doc(db, "employees/ADM_F"), emp("ADM_F", { roles: ["admin"], businessId: "F6G1", adminBusinessIds: ["F6G1"] }));
    await setDoc(doc(db, "employees/MGR"), emp("MGR", { roles: ["manager"] }));
    await setDoc(doc(db, "employees/A"), emp("A", { managerId: "MGR" }));
    await setDoc(doc(db, "employees/B"), emp("B", { managerId: "MGR" }));
    await setDoc(doc(db, "employees/OUT"), emp("OUT", { managerId: null }));
    await setDoc(doc(db, "employeePay/A"), { committedPaise: 1_500_000 });
    await setDoc(doc(db, "employeePay/B"), { committedPaise: 1_500_000 });
    await setDoc(doc(db, "employeeTargets/A"), { targetPaise: 1 });
    await setDoc(doc(db, "employees/A/documents/d1"), { kind: "aadhaarFront", uploaded: true });
    await setDoc(doc(db, "payslips/A_2026-11"), { employeeId: "A", businessId: "BM", month: "2026-11" });
    await setDoc(doc(db, "payslips/B_2026-11"), { employeeId: "B", businessId: "BM", month: "2026-11" });
    await setDoc(doc(db, "leaveRequests/A_2026-11-12"), { employeeId: "A", reason: "private" });
    await setDoc(doc(db, "attendance/A_2026-11-12"), { employeeId: "A" });
    await setDoc(doc(db, "authPins/A"), { pinHash: "x" });
    await setDoc(doc(db, "mobileIndex/9876543210"), { employeeId: "A" });
    await setDoc(doc(db, "leaderboards/BM_2026-11"), { unit: "BM", entries: [] });
    await setDoc(doc(db, "leaderboards/F6G1_2026-11"), { unit: "F6G1", entries: [] });
    await setDoc(doc(db, "payrollRuns/BM_2026-11"), { unit: "BM" });
    await setDoc(doc(db, "auditLogs/x"), { action: "x" });
  });
});

const as = (uid: string) => env.authenticatedContext(uid).firestore() as unknown as Db;

describe("staff", () => {
  it("can read own employee doc, pay, payslip, attendance and leave", async () => {
    const db = as("A");
    await assertSucceeds(getDoc(doc(db, "employees/A")));
    await assertSucceeds(getDoc(doc(db, "employeePay/A")));
    await assertSucceeds(getDoc(doc(db, "payslips/A_2026-11")));
    await assertSucceeds(getDoc(doc(db, "attendance/A_2026-11-12")));
    await assertSucceeds(getDoc(doc(db, "leaveRequests/A_2026-11-12")));
    await assertSucceeds(getDoc(doc(db, "employees/A/documents/d1")));
  });

  it("cannot read another staff member's employee doc, salary, documents, payslip, leave reason", async () => {
    const db = as("B");
    await assertFails(getDoc(doc(db, "employees/A")));
    await assertFails(getDoc(doc(db, "employeePay/A")));
    await assertFails(getDoc(doc(db, "employeeTargets/A")));
    await assertFails(getDoc(doc(db, "employees/A/documents/d1")));
    await assertFails(getDoc(doc(db, "payslips/A_2026-11")));
    await assertFails(getDoc(doc(db, "leaveRequests/A_2026-11-12")));
    await assertFails(getDoc(doc(db, "attendance/A_2026-11-12")));
  });

  it("can read only their own unit's leaderboard", async () => {
    await assertSucceeds(getDoc(doc(as("B"), "leaderboards/BM_2026-11")));
    await assertFails(getDoc(doc(as("B"), "leaderboards/F6G1_2026-11")));
  });

  it("cannot read backend-only collections or audit logs", async () => {
    const db = as("A");
    await assertFails(getDoc(doc(db, "authPins/A")));
    await assertFails(getDoc(doc(db, "mobileIndex/9876543210")));
    await assertFails(getDoc(doc(db, "auditLogs/x")));
    await assertFails(getDoc(doc(db, "payrollRuns/BM_2026-11")));
  });

  it("unauthenticated users read nothing", async () => {
    await assertFails(getDoc(doc((env.unauthenticatedContext().firestore() as unknown as Db), "employees/A")));
  });
});

describe("manager", () => {
  it("reads their team's employee/target/attendance/leave but NEVER employeePay or documents", async () => {
    const db = as("MGR");
    await assertSucceeds(getDoc(doc(db, "employees/A")));
    await assertSucceeds(getDoc(doc(db, "employeeTargets/A")));
    await assertSucceeds(getDoc(doc(db, "attendance/A_2026-11-12")));
    await assertSucceeds(getDoc(doc(db, "leaveRequests/A_2026-11-12")));
    await assertFails(getDoc(doc(db, "employeePay/A")));
    await assertFails(getDoc(doc(db, "employeePay/B")));
    await assertFails(getDoc(doc(db, "employees/A/documents/d1")));
    await assertFails(getDoc(doc(db, "payslips/A_2026-11")));
  });

  it("cannot read staff outside their team", async () => {
    await assertFails(getDoc(doc(as("MGR"), "employees/OUT")));
  });
});

describe("admin and super admin", () => {
  it("admin reads pay and documents within assigned units only", async () => {
    await assertSucceeds(getDoc(doc(as("ADM"), "employeePay/A")));
    await assertSucceeds(getDoc(doc(as("ADM"), "employees/A/documents/d1")));
    await assertSucceeds(getDoc(doc(as("ADM"), "payrollRuns/BM_2026-11")));
    await assertFails(getDoc(doc(as("ADM_F"), "employeePay/A")));
    await assertFails(getDoc(doc(as("ADM_F"), "employees/A")));
    await assertFails(getDoc(doc(as("ADM_F"), "payrollRuns/BM_2026-11")));
  });

  it("nobody reads authPins; only the super admin reads audit logs", async () => {
    await assertFails(getDoc(doc(as("SA"), "authPins/A")));
    await assertFails(getDoc(doc(as("ADM"), "authPins/A")));
    await assertSucceeds(getDoc(doc(as("SA"), "auditLogs/x")));
    await assertFails(getDoc(doc(as("ADM"), "auditLogs/x")));
    await assertSucceeds(getDoc(doc(as("SA"), "employeePay/A")));
  });
});

describe("no client writes anywhere", () => {
  it("denies create, update and delete for every role", async () => {
    for (const uid of ["A", "MGR", "ADM", "SA"]) {
      const db = as(uid);
      await assertFails(setDoc(doc(db, "attendance/new"), { employeeId: uid }));
      await assertFails(updateDoc(doc(db, "employees/A"), { name: "hack" }));
      await assertFails(setDoc(doc(db, "dailySales/x"), { employeeId: uid }));
      await assertFails(deleteDoc(doc(db, "leaveRequests/A_2026-11-12")));
      await assertFails(setDoc(doc(db, "employeePay/A"), { committedPaise: 9 }));
    }
  });
});
