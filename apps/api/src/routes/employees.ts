import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Timestamp } from "firebase-admin/firestore";
import {
  DEFAULT_SLABS,
  createEmployeeInput,
  dateIST,
  documentRegisterInput,
  documentUrlInput,
  exitEmployeeInput,
  formatEmployeeId,
  rupeesToPaise,
  setTargetInput,
  updateEmployeeInput,
  validatePin,
  type BusinessUnit,
} from "@biglitz/shared";
import type { AppContext } from "../context.js";
import {
  adminUnits,
  canView,
  canViewPay,
  isAdminOf,
  isManager,
  requireAdminOf,
  requireManage,
  requireSuperAdmin,
  type Actor,
} from "../access.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import type { EmployeeDoc, EmployeePayDoc, EmployeeTargetDoc } from "../types.js";
import { guard } from "./guard.js";
import { loadEmployee } from "./auth.js";

const emp = (a: Actor): EmployeeDoc => a.emp;

export async function getEmployee(ctx: AppContext, id: string): Promise<EmployeeDoc> {
  const e = await loadEmployee(ctx, id);
  if (!e) throw notFound("Employee");
  return e;
}

/** Employees the actor may see (non-money). */
export async function listScopedEmployees(ctx: AppContext, a: Actor, unit?: string): Promise<EmployeeDoc[]> {
  const col = ctx.db.collection("employees");
  const found = new Map<string, EmployeeDoc>();
  const add = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.forEach((d) => found.set(d.id, d.data() as EmployeeDoc));

  const units = adminUnits(a);
  if (units === null) add((await col.get()).docs);
  else {
    for (let i = 0; i < units.length; i += 30) {
      const chunk = units.slice(i, i + 30);
      if (chunk.length) add((await col.where("businessId", "in", chunk).get()).docs);
    }
  }
  if (isManager(a)) add((await col.where("managerId", "==", a.id).get()).docs);
  found.set(a.id, emp(a));
  let list = [...found.values()];
  if (unit) list = list.filter((e) => e.businessId === unit);
  return list.sort((x, y) => x.employeeId.localeCompare(y.employeeId));
}

async function assertValidManager(ctx: AppContext, managerId: string | null, unit: string): Promise<void> {
  if (!managerId) return;
  const m = await loadEmployee(ctx, managerId);
  if (!m) throw badRequest("BAD_MANAGER", "The chosen manager does not exist.");
  if (!m.roles.includes("manager") && !m.roles.includes("admin") && !m.roles.includes("superAdmin")) {
    throw badRequest("BAD_MANAGER", "The chosen person is not a Manager.");
  }
  if (m.businessId !== unit && !m.adminBusinessIds.includes(unit) && !m.roles.includes("superAdmin")) {
    throw badRequest("BAD_MANAGER", "The manager must belong to the same business unit.");
  }
}

const sanitizeFileName = (n: string): string => n.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);

export function registerEmployeeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  app.post("/api/employees", pre, async (req) => {
    const a = req.actor;
    const input = createEmployeeInput.parse(req.body);
    requireAdminOf(a, input.businessId);
    if (input.roles.includes("superAdmin")) throw forbidden("The Super Admin account cannot be created here.");
    if (input.roles.includes("admin") || input.adminBusinessIds.length || input.canApprovePayrollFor.length) {
      requireSuperAdmin(a);
    }
    const pinCheck = validatePin(input.tempPin, input.mobile);
    if (!pinCheck.ok) throw badRequest("WEAK_PIN", pinCheck.message);
    await assertValidManager(ctx, input.managerId, input.businessId);
    const pinHash = await bcrypt.hash(input.tempPin, ctx.bcryptCost);

    const unitRef = ctx.db.collection("businessUnits").doc(input.businessId);
    const mobileRef = ctx.db.collection("mobileIndex").doc(input.mobile);

    const result = await ctx.db.runTransaction(async (tx) => {
      const unitSnap = await tx.get(unitRef);
      if (!unitSnap.exists) throw notFound("Business unit");
      const unit = unitSnap.data() as BusinessUnit;
      if (!unit.active) throw badRequest("UNIT_INACTIVE", "That business unit is not active.");
      if ((await tx.get(mobileRef)).exists) throw conflict("MOBILE_EXISTS", "That mobile number is already registered.");

      const counter = unit.idCounter + 1;
      const employeeId = formatEmployeeId(input.joiningDate, unit.code, counter);
      const hasCategories = unit.salesCategories.some((c) => c.active);
      const doc: EmployeeDoc = {
        employeeId,
        name: input.name,
        mobile: input.mobile,
        photoPath: null,
        businessId: unit.code,
        roles: input.roles,
        designation: input.designation,
        managerId: input.managerId,
        joiningDate: input.joiningDate,
        exitDate: null,
        status: "pending",
        shift: input.shift ?? unit.defaultShift,
        requiresSalesEntry: input.requiresSalesEntry ?? hasCategories,
        adminBusinessIds: input.adminBusinessIds,
        canApprovePayrollFor: input.canApprovePayrollFor,
        createdAt: Timestamp.fromDate(ctx.clock()),
      };
      const pay: EmployeePayDoc = {
        committedPaise: rupeesToPaise(input.committedSalaryRupees),
        bank: input.bank ?? null,
        aadhaarLast4: input.aadhaarLast4 ?? null,
      };
      const target: EmployeeTargetDoc = {
        targetPaise: input.monthlyTargetRupees === null ? null : rupeesToPaise(input.monthlyTargetRupees),
        slabs: input.slabs ?? [...DEFAULT_SLABS],
      };
      tx.update(unitRef, { idCounter: counter });
      tx.set(ctx.db.collection("employees").doc(employeeId), doc);
      tx.set(ctx.db.collection("employeePay").doc(employeeId), pay);
      tx.set(ctx.db.collection("employeeTargets").doc(employeeId), target);
      tx.set(ctx.db.collection("authPins").doc(employeeId), { pinHash, failedAttempts: 0, lockedUntil: null, mustChangePin: true });
      tx.set(mobileRef, { employeeId });
      await audit(ctx, { actorId: a.id, action: "employee.create", entity: "employees", entityId: employeeId, before: null, after: { ...doc, ...pay, ...target } }, tx);
      return doc;
    });
    return { employee: result };
  });

  app.get("/api/employees", pre, async (req) => {
    const q = (req.query ?? {}) as { unit?: string; search?: string };
    let list = await listScopedEmployees(ctx, req.actor, q.unit);
    if (q.search) {
      const s = q.search.toLowerCase();
      list = list.filter((e) => e.name.toLowerCase().includes(s) || e.employeeId.toLowerCase().includes(s) || e.mobile.includes(s));
    }
    return { employees: list };
  });

  app.get("/api/employees/:id", pre, async (req) => {
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    if (!canView(req.actor, target)) throw forbidden("You cannot view that employee.");
    return { employee: target };
  });

  app.get("/api/employees/:id/pay", pre, async (req) => {
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    if (!canViewPay(req.actor, target)) throw forbidden("You cannot view salary details.");
    const snap = await ctx.db.collection("employeePay").doc(target.employeeId).get();
    return { pay: snap.data() as EmployeePayDoc };
  });

  app.get("/api/employees/:id/target", pre, async (req) => {
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    if (!canView(req.actor, target)) throw forbidden("You cannot view that target.");
    const snap = await ctx.db.collection("employeeTargets").doc(target.employeeId).get();
    return { target: snap.data() as EmployeeTargetDoc };
  });

  app.patch("/api/employees/:id", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireAdminOf(a, target.businessId);
    const { reason, committedSalaryRupees, bank, aadhaarLast4, ...rest } = updateEmployeeInput.parse(req.body);
    if (rest.roles?.includes("superAdmin")) throw forbidden("Cannot assign Super Admin.");
    if (rest.roles?.includes("admin") || rest.adminBusinessIds || rest.canApprovePayrollFor) requireSuperAdmin(a);
    if (rest.managerId !== undefined) await assertValidManager(ctx, rest.managerId, target.businessId);
    const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const payRef = ctx.db.collection("employeePay").doc(target.employeeId);
    const empRef = ctx.db.collection("employees").doc(target.employeeId);
    const updated = await ctx.db.runTransaction(async (tx) => {
      const paySnap = await tx.get(payRef);
      const beforePay = paySnap.data() as EmployeePayDoc;
      const afterPay: EmployeePayDoc = {
        committedPaise: committedSalaryRupees === undefined ? beforePay.committedPaise : rupeesToPaise(committedSalaryRupees),
        bank: bank ?? beforePay.bank,
        aadhaarLast4: aadhaarLast4 ?? beforePay.aadhaarLast4,
      };
      tx.update(empRef, defined);
      tx.set(payRef, afterPay);
      await audit(ctx, { actorId: a.id, action: "employee.update", entity: "employees", entityId: target.employeeId, before: { ...target, ...beforePay }, after: { ...target, ...defined, ...afterPay }, reason }, tx);
      return { ...target, ...defined } as EmployeeDoc;
    });
    return { employee: updated };
  });

  // Target and slabs: Super Admin, Admin, or the employee's Manager. Whatever they set is final.
  app.put("/api/employees/:id/target", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireManage(a, target);
    const input = setTargetInput.parse(req.body);
    const ref = ctx.db.collection("employeeTargets").doc(target.employeeId);
    const before = (await ref.get()).data();
    const categoryTargetsPaise = input.categoryTargetsRupees
      ? Object.fromEntries(Object.entries(input.categoryTargetsRupees).map(([id, r]) => [id, rupeesToPaise(r)]))
      : undefined;
    const fromCats =
      categoryTargetsPaise && Object.keys(categoryTargetsPaise).length > 0
        ? Object.values(categoryTargetsPaise).reduce((s, n) => s + n, 0)
        : null;
    const after: EmployeeTargetDoc = {
      targetPaise: fromCats !== null ? fromCats : input.monthlyTargetRupees === null ? null : rupeesToPaise(input.monthlyTargetRupees),
      ...(categoryTargetsPaise ? { categoryTargetsPaise } : {}),
      slabs: input.slabs,
    };
    await ref.set(after);
    await audit(ctx, { actorId: a.id, action: "target.set", entity: "employeeTargets", entityId: target.employeeId, before, after, reason: input.reason });
    return { target: after };
  });

  // ---- Documents ----
  const canDocs = (a: Actor, t: EmployeeDoc): boolean => a.id === t.employeeId || isAdminOf(a, t.businessId);

  app.post("/api/employees/:id/documents/upload-url", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireAdminOf(a, target.businessId);
    const input = documentUrlInput.parse(req.body);
    if (input.kind === "other" && !input.remark.trim()) throw badRequest("REMARK_REQUIRED", "Add a remark describing this document.");
    const docRef = ctx.db.collection("employees").doc(target.employeeId).collection("documents").doc();
    const path = `employees/${target.employeeId}/documents/${docRef.id}-${sanitizeFileName(input.fileName)}`;
    await docRef.set({
      kind: input.kind,
      remark: input.remark,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path,
      uploaded: false,
      createdAt: Timestamp.fromDate(ctx.clock()),
      createdBy: a.id,
    });
    return { docId: docRef.id, path, uploadUrl: await ctx.files.uploadUrl(path, input.contentType) };
  });

  app.post("/api/employees/:id/documents/register", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireAdminOf(a, target.businessId);
    const { docId } = documentRegisterInput.parse(req.body);
    const ref = ctx.db.collection("employees").doc(target.employeeId).collection("documents").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Document");
    const path = (snap.data() as { path: string }).path;
    if (!(await ctx.files.exists(path))) throw badRequest("NOT_UPLOADED", "The file has not finished uploading. Please retry.");
    await ref.update({ uploaded: true });
    await audit(ctx, { actorId: a.id, action: "document.add", entity: "documents", entityId: `${target.employeeId}/${docId}`, before: null, after: snap.data() });
    return { ok: true };
  });

  app.get("/api/employees/:id/documents", pre, async (req) => {
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    if (!canDocs(req.actor, target)) throw forbidden("Documents are visible only to the employee and their Admins.");
    const snaps = await ctx.db.collection("employees").doc(target.employeeId).collection("documents").get();
    return { documents: snaps.docs.map((d) => ({ docId: d.id, ...d.data() })).filter((d) => (d as { uploaded?: boolean }).uploaded) };
  });

  app.get("/api/employees/:id/documents/:docId/url", pre, async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    const target = await getEmployee(ctx, id);
    if (!canDocs(req.actor, target)) throw forbidden("Documents are visible only to the employee and their Admins.");
    const snap = await ctx.db.collection("employees").doc(id).collection("documents").doc(docId).get();
    if (!snap.exists) throw notFound("Document");
    return { url: await ctx.files.downloadUrl((snap.data() as { path: string }).path) };
  });

  // Aadhaar (front and back) is mandatory before an employee can become active.
  app.post("/api/employees/:id/activate", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireAdminOf(a, target.businessId);
    if (target.status === "active") return { employee: target };
    if (target.status === "exited") throw badRequest("EXITED", "An exited employee cannot be reactivated.");
    const docs = await ctx.db.collection("employees").doc(target.employeeId).collection("documents").get();
    const uploaded = docs.docs.map((d) => d.data() as { kind: string; uploaded: boolean }).filter((d) => d.uploaded);
    const missing = (["aadhaarFront", "aadhaarBack"] as const).filter((k) => !uploaded.some((d) => d.kind === k));
    if (missing.length) {
      throw badRequest("AADHAAR_REQUIRED", `Aadhaar card (front and back) is mandatory. Missing: ${missing.map((m) => (m === "aadhaarFront" ? "front" : "back")).join(", ")}.`);
    }
    const pay = (await ctx.db.collection("employeePay").doc(target.employeeId).get()).data() as EmployeePayDoc;
    if (!pay.aadhaarLast4) throw badRequest("AADHAAR_REQUIRED", "Enter the last 4 digits of the Aadhaar number.");
    await ctx.db.collection("employees").doc(target.employeeId).update({ status: "active" });
    await audit(ctx, { actorId: a.id, action: "employee.activate", entity: "employees", entityId: target.employeeId, before: { status: target.status }, after: { status: "active" } });
    return { employee: { ...target, status: "active" as const } };
  });

  // ---- Exit ----
  app.post("/api/employees/:id/exit", pre, async (req) => {
    const a = req.actor;
    const target = await getEmployee(ctx, (req.params as { id: string }).id);
    requireAdminOf(a, target.businessId);
    const input = exitEmployeeInput.parse(req.body);
    if (input.exitDate < target.joiningDate) throw badRequest("BAD_DATE", "Exit date cannot be before the joining date.");

    // Open leads must be reassigned (the Manager chooses).
    const leads = await ctx.db.collection("leads").where("assigneeId", "==", target.employeeId).get();
    const open = leads.docs.filter((d) => !["closedWon", "lost"].includes((d.data() as { status: string }).status));
    if (open.length) {
      if (!input.leadReassignTo) throw badRequest("REASSIGN_REQUIRED", `${open.length} open lead(s) must be reassigned. Choose who takes them.`);
      const newOwner = await getEmployee(ctx, input.leadReassignTo);
      if (newOwner.status === "exited" || newOwner.employeeId === target.employeeId) throw badRequest("BAD_ASSIGNEE", "Choose an active employee.");
    }
    const batch = ctx.db.batch();
    for (const d of open) {
      batch.update(d.ref, { assigneeId: input.leadReassignTo });
      batch.set(d.ref.collection("history").doc(), {
        at: Timestamp.fromDate(ctx.clock()),
        by: a.id,
        note: `Reassigned from ${target.employeeId} (exit)`,
        status: (d.data() as { status: string }).status,
      });
    }
    // Remove from lead pools.
    const pools = await ctx.db.collection("leadPools").where("businessId", "==", target.businessId).get();
    for (const p of pools.docs) {
      const order = (p.data() as { staffOrder: string[] }).staffOrder;
      if (order.includes(target.employeeId)) {
        const next = order.filter((x) => x !== target.employeeId);
        batch.update(p.ref, { staffOrder: next, pointer: next.length ? 0 : 0 });
      }
    }
    batch.update(ctx.db.collection("employees").doc(target.employeeId), { exitDate: input.exitDate, ...(input.exitDate < dateIST(ctx.clock()) ? { status: "exited" } : {}) });
    await batch.commit();
    await audit(ctx, { actorId: a.id, action: "employee.exit", entity: "employees", entityId: target.employeeId, before: { exitDate: target.exitDate }, after: { exitDate: input.exitDate }, reason: input.reason });
    return { ok: true, reassigned: open.length };
  });

}
