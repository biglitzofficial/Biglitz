import bcrypt from "bcryptjs";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { DEFAULT_SLABS, addDays, dateIST, isLateApplication, previousMonthKey, type BusinessUnit } from "@biglitz/shared";
import { buildContext } from "../bootstrap.js";
import type { AppContext } from "../context.js";
import { createMemoryNotifier } from "../services/notifier.js";
import { buildHandlers } from "../cron/jobs.js";
import { computeScores } from "../services/scores.js";
import { createDraft } from "../services/payroll.js";
import { generateRecurringFor, type TaskDoc } from "../services/recurring.js";
import { amountTotal } from "../services/sales.js";
import type { LeadDoc, PoolDoc } from "../services/leads.js";
import type { AttendanceDoc, DailySalesDoc, EmployeeDoc, LeaveDoc } from "../types.js";

/**
 * DEMO DATA. `npm run demo:load -w @biglitz/api` fills every module with sample data (all tagged demo: true);
 * `npm run demo:clear -w @biglitz/api` removes all of it. Demo logins: PIN 4821 for every demo user.
 */

const DEMO_PIN = "4821";
const PLACEHOLDER = "demo/placeholder.jpg";
const JPEG_1PX = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

interface Person {
  id: string;
  name: string;
  mobile: string;
  unit: string;
  roles: EmployeeDoc["roles"];
  designation: string;
  manager: string | null;
  salary: number; // rupees
  target: number | null; // rupees
  ach: number; // sales achievement factor
  absent: number;
  late: number;
  status?: EmployeeDoc["status"];
  adminUnits?: string[];
}

const PEOPLE: Person[] = [
  { id: "26BM901", name: "Priya Nair", mobile: "9000000101", unit: "BM", roles: ["staff", "admin"], designation: "Admin (demo)", manager: null, salary: 32000, target: null, ach: 0, absent: 0.02, late: 0.02, adminUnits: ["BM", "F6G1"] },
  { id: "26BM902", name: "Karthik Raj", mobile: "9000000102", unit: "BM", roles: ["staff", "manager"], designation: "Store Manager", manager: "26BM901", salary: 28000, target: null, ach: 0, absent: 0.01, late: 0.03 },
  { id: "26BM903", name: "Arun Kumar", mobile: "9000000103", unit: "BM", roles: ["staff"], designation: "Sales Executive", manager: "26BM902", salary: 18000, target: 300000, ach: 1.08, absent: 0.0, late: 0.02 },
  { id: "26BM904", name: "Meena Devi", mobile: "9000000104", unit: "BM", roles: ["staff"], designation: "Sales Executive", manager: "26BM902", salary: 17000, target: 300000, ach: 0.9, absent: 0.03, late: 0.05 },
  { id: "26BM905", name: "Vignesh S", mobile: "9000000105", unit: "BM", roles: ["staff"], designation: "Sales Executive", manager: "26BM902", salary: 16000, target: 300000, ach: 0.72, absent: 0.05, late: 0.2 },
  { id: "26BM906", name: "Lakshmi P", mobile: "9000000106", unit: "BM", roles: ["staff"], designation: "Service Technician", manager: "26BM902", salary: 15000, target: 300000, ach: 0.85, absent: 0.08, late: 0.1 },
  { id: "26BM907", name: "Suresh M", mobile: "9000000107", unit: "BM", roles: ["staff"], designation: "Sales Executive", manager: "26BM902", salary: 15000, target: 300000, ach: 0.55, absent: 0.1, late: 0.3 },
  { id: "26BM908", name: "Anitha R", mobile: "9000000108", unit: "BM", roles: ["staff"], designation: "Cashier", manager: "26BM902", salary: 14000, target: 300000, ach: 1.0, absent: 0.04, late: 0.12 },
  { id: "26BM909", name: "Ravi T (pending)", mobile: "9000000109", unit: "BM", roles: ["staff"], designation: "New joiner", manager: "26BM902", salary: 14000, target: null, ach: 0, absent: 0, late: 0, status: "pending" },
  { id: "26F6G901", name: "Divya S", mobile: "9000000111", unit: "F6G1", roles: ["staff", "manager"], designation: "Studio Manager", manager: "26BM901", salary: 26000, target: null, ach: 0, absent: 0.0, late: 0.03 },
  { id: "26F6G902", name: "Hari Prasad", mobile: "9000000112", unit: "F6G1", roles: ["staff"], designation: "Trainer", manager: "26F6G901", salary: 16000, target: 150000, ach: 1.02, absent: 0.03, late: 0.1 },
  { id: "26F6G903", name: "Janani K", mobile: "9000000113", unit: "F6G1", roles: ["staff"], designation: "Front Desk", manager: "26F6G901", salary: 14000, target: 150000, ach: 0.8, absent: 0.05, late: 0.2 },
  { id: "26F6G904", name: "Mohan D", mobile: "9000000114", unit: "F6G1", roles: ["staff"], designation: "Trainer", manager: "26F6G901", salary: 15000, target: 150000, ach: 0.6, absent: 0.08, late: 0.25 },
];

const ids = (unit: string, roleFilter?: (p: Person) => boolean): string[] => PEOPLE.filter((p) => p.unit === unit && p.status !== "pending" && (roleFilter ? roleFilter(p) : true)).map((p) => p.id);
const isRegularStaff = (p: Person): boolean => p.roles.length === 1;
const person = (id: string): Person => {
  const p = PEOPLE.find((x) => x.id === id);
  if (!p) throw new Error(`unknown demo person ${id}`);
  return p;
};

// ---- deterministic randomness so every load looks the same ----
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s: string): number => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

const istDate = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`);
const ts = (date: string, hhmm: string): Timestamp => Timestamp.fromDate(istDate(date, hhmm));
const dates = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const pick = <T,>(arr: readonly T[], r: () => number): T => arr[Math.floor(r() * arr.length)] as T;
const hm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

// ================= clear =================
async function deleteByFlag(db: Firestore, col: string): Promise<number> {
  const snaps = await db.collection(col).where("demo", "==", true).get();
  for (const d of snaps.docs) await db.recursiveDelete(d.ref);
  return snaps.size;
}

export async function clearDemo(ctx: AppContext): Promise<void> {
  const db = ctx.db;
  let n = 0;
  for (const col of ["attendance", "dailySales", "leaveRequests", "tasks", "leads", "leadPhones", "leadPools", "advances", "auditLogs"]) {
    n += await deleteByFlag(db, col);
  }
  for (const p of PEOPLE) {
    for (const col of ["employees", "employeePay", "employeeTargets", "authPins", "scoreState"]) {
      await db.recursiveDelete(db.collection(col).doc(p.id));
    }
    await db.collection("mobileIndex").doc(p.mobile).delete();
    for (const m of ["2026-09", "2026-10", "2026-11", "2026-12"]) await db.collection("scores").doc(`${p.id}_${m}`).delete();
    n++;
  }
  for (const unit of ["BM", "F6G1"]) {
    for (const m of ["2026-10", "2026-11"]) {
      await db.recursiveDelete(db.collection("payrollRuns").doc(`${unit}_${m}`));
      await db.collection("leaderboards").doc(`${unit}_${m}`).delete();
    }
  }
  for (const m of ["2026-10", "2026-11"]) {
    await db.collection("leaderboards").doc(`ALL_${m}`).delete();
    await db.collection("rewards").doc(m).delete();
  }
  const slips = await db.collection("payslips").where("employeeId", "in", PEOPLE.map((p) => p.id)).get();
  for (const d of slips.docs) await d.ref.delete();
  console.log(`demo data cleared (${n} groups)`);
}

// ================= load =================
export async function loadDemo(ctx: AppContext): Promise<void> {
  const db = ctx.db;
  await clearDemo(ctx);

  const now = ctx.clock();
  const today = dateIST(now);
  const yesterday = addDays(today, -1);
  const month = today.slice(0, 7);
  const prev = previousMonthKey(month);
  const start = `${prev}-01`;
  const flag = { demo: true } as const;

  await ctx.files.save(PLACEHOLDER, Uint8Array.from(Buffer.from(JPEG_1PX, "base64")), "image/jpeg");

  const units = new Map<string, BusinessUnit>();
  for (const u of ["BM", "F6G1"]) {
    const snap = await db.collection("businessUnits").doc(u).get();
    if (!snap.exists) throw new Error(`Unit ${u} missing: run npm run seed first.`);
    units.set(u, snap.data() as BusinessUnit);
  }

  // ---- employees, pay, targets, pins, documents ----
  const pinHash = await bcrypt.hash(DEMO_PIN, 10);
  for (const p of PEOPLE) {
    const pending = p.status === "pending";
    const emp: EmployeeDoc & { demo: true } = {
      employeeId: p.id,
      name: p.name,
      mobile: p.mobile,
      photoPath: null,
      businessId: p.unit,
      roles: p.roles,
      designation: p.designation,
      managerId: p.manager,
      joiningDate: pending ? today : "2026-09-01",
      exitDate: null,
      status: pending ? "pending" : "active",
      shift: { start: "09:30", end: "22:00" },
      requiresSalesEntry: p.roles.length === 1 && p.target !== null,
      adminBusinessIds: p.adminUnits ?? [],
      canApprovePayrollFor: [],
      createdAt: Timestamp.fromDate(now),
      ...flag,
    };
    await db.collection("employees").doc(p.id).set(emp);
    await db.collection("employeePay").doc(p.id).set({ committedPaise: p.salary * 100, bank: { accountHolder: p.name, accountNumber: `50100${p.mobile.slice(-6)}0${p.mobile.slice(-3)}`, ifsc: "HDFC0001234" }, aadhaarLast4: "4821" });
    await db.collection("employeeTargets").doc(p.id).set({ targetPaise: p.target === null ? null : p.target * 100, slabs: [...DEFAULT_SLABS] });
    await db.collection("authPins").doc(p.id).set({ pinHash, failedAttempts: 0, lockedUntil: null, mustChangePin: false });
    await db.collection("mobileIndex").doc(p.mobile).set({ employeeId: p.id });
    if (!pending) {
      for (const kind of ["aadhaarFront", "aadhaarBack"] as const) {
        await db.collection("employees").doc(p.id).collection("documents").doc(kind).set({ kind, remark: "", contentType: "image/jpeg", sizeBytes: 70, path: PLACEHOLDER, uploaded: true, createdAt: Timestamp.fromDate(now), createdBy: "26BM901" });
      }
    }
  }

  // ---- leave requests (decided first so attendance can honour them) ----
  const leave = (empId: string, date: string, status: LeaveDoc["status"], applied: string, type: LeaveDoc["type"], reason: string): LeaveDoc & { demo: true } => {
    const p = person(empId);
    return {
      employeeId: empId,
      businessId: p.unit,
      managerId: p.manager,
      dateIST: date,
      type,
      reason,
      appliedDateIST: applied,
      appliedAt: ts(applied, "10:15"),
      lateApplication: isLateApplication(applied, date),
      status,
      decidedBy: status === "pending" ? null : (p.manager ?? "26BM901"),
      decidedAt: status === "pending" ? null : ts(addDays(applied, 1), "11:00"),
      decisionNote: status === "rejected" ? "Shop is short-staffed that day" : "",
      ...flag,
    };
  };
  const leaves: Array<LeaveDoc & { demo: true }> = [
    leave("26BM904", `${prev}-14`, "approved", `${prev}-08`, "full", "Family function"),
    leave("26BM905", `${prev}-20`, "approved", `${prev}-12`, "half", "Bank work"),
    leave("26BM903", addDays(today, -5), "approved", addDays(today, -6), "full", "Fever (late application)"),
    leave("26BM907", today, "approved", addDays(today, -10), "full", "Medical checkup"),
    leave("26BM906", addDays(today, -12), "rejected", addDays(today, -20), "full", "Personal"),
    leave("26BM908", addDays(today, 5), "pending", today, "full", "Sister's wedding"),
    leave("26BM907", addDays(today, 1), "pending", today, "full", "Urgent personal work (late application)"),
    leave("26BM904", addDays(today, 10), "pending", today, "half", "Doctor appointment"),
    leave("26F6G903", addDays(today, 4), "pending", today, "full", "Exam"),
  ];
  for (const l of leaves) await db.collection("leaveRequests").doc(`${l.employeeId}_${l.dateIST}`).set(l);
  const approvedLeave = (empId: string, date: string) => leaves.find((l) => l.employeeId === empId && l.dateIST === date && l.status === "approved");

  // ---- attendance (previous month + this month to today) ----
  const punchInfo = (r: () => number) => ({ lat: 11.1085, lng: 77.3411, accuracy: 15 + Math.floor(r() * 20), distanceMeters: 5 + Math.floor(r() * 55), selfiePath: PLACEHOLDER });
  const attDoc = (p: Person, date: string, inAt: string | null, outAt: string | null, r: () => number, extra: Partial<AttendanceDoc> = {}): AttendanceDoc & { demo: true } => ({
    employeeId: p.id,
    businessId: p.unit,
    dateIST: date,
    punchInAt: inAt ? ts(date, inAt) : null,
    punchOutAt: outAt ? ts(date, outAt) : null,
    punchIn: inAt ? punchInfo(r) : null,
    punchOut: outAt ? punchInfo(r) : null,
    shift: { start: "09:30", end: "22:00" },
    halfDay: false,
    absentOverride: false,
    corrections: [],
    ...extra,
    ...flag,
  });
  const working = PEOPLE.filter((p) => p.status !== "pending");
  const presentToday = new Set<string>();
  for (const p of working) {
    const r = rng(seedOf(p.id));
    for (const date of dates(start, today)) {
      const al = approvedLeave(p.id, date);
      if (al?.type === "half") {
        await db.collection("attendance").doc(`${p.id}_${date}`).set(attDoc(p, date, "09:20", "14:05", r, { halfDay: true }));
        continue;
      }
      if (al) continue;
      if (date === today) {
        // Today: most people are in; one is late; one has not come.
        const notYet = p.id === "26BM906";
        if (notYet) continue;
        const inAt = p.id === "26BM905" ? "10:12" : hm(555 + Math.floor(r() * 18));
        presentToday.add(p.id);
        await db.collection("attendance").doc(`${p.id}_${date}`).set(attDoc(p, date, inAt, null, r));
        continue;
      }
      if (r() < p.absent) continue;
      const late = r() < p.late;
      const inAt = late ? hm(576 + Math.floor(r() * 50)) : hm(550 + Math.floor(r() * 20));
      const early = r() < 0.05;
      const outAt = early ? hm(1280 + Math.floor(r() * 30)) : hm(1320 + Math.floor(r() * 25));
      await db.collection("attendance").doc(`${p.id}_${date}`).set(attDoc(p, date, inAt, outAt, r));
    }
  }
  // One corrected day, to show the correction trail.
  {
    const p = person("26BM908");
    const date = addDays(today, -3);
    const r = rng(1);
    await db.collection("attendance").doc(`${p.id}_${date}`).set(
      attDoc(p, date, "09:25", "22:05", r, { corrections: [{ by: "26BM902", at: ts(addDays(today, -2), "10:00"), reason: "Forgot to punch out; confirmed by CCTV", before: { punchOutAt: null } }] }),
    );
  }

  // ---- daily sales ----
  for (const p of working.filter((x) => x.target !== null)) {
    const unit = units.get(p.unit) as BusinessUnit;
    const cats = unit.salesCategories.filter((c) => c.active);
    const amountCats = cats.filter((c) => c.type === "amount");
    const r = rng(seedOf(`${p.id}-sales`));
    const perDay = ((p.target as number) / 31) * p.ach;
    for (const date of dates(start, today)) {
      if (approvedLeave(p.id, date)?.type === "full") continue;
      const att = await db.collection("attendance").doc(`${p.id}_${date}`).get();
      if (!att.exists) continue;
      if (date === today && !["26BM903", "26BM904", "26F6G902"].includes(p.id)) continue; // others "not reported yet"
      const noSales = r() < 0.03;
      const values: Record<string, number> = {};
      const weights = amountCats.map((_, i) => (i === 0 ? 0.6 : 0.4 / Math.max(1, amountCats.length - 1)));
      amountCats.forEach((c, i) => {
        values[c.id] = noSales ? 0 : Math.round(perDay * (0.5 + r()) * (weights[i] ?? 0.2)) * 100;
      });
      for (const c of cats.filter((x) => x.type === "count")) values[c.id] = noSales ? 0 : Math.floor(r() * 3);
      const doc: DailySalesDoc & { demo: true } = {
        employeeId: p.id,
        businessId: p.unit,
        dateIST: date,
        values,
        amountTotalPaise: amountTotal(unit, values),
        noSales,
        submittedAt: ts(date, "21:30"),
        corrections: [],
        ...flag,
      };
      await db.collection("dailySales").doc(`${p.id}_${date}`).set(doc);
    }
  }

  // ---- tasks ----
  const mkTask = (assignee: string, title: string, over: Partial<TaskDoc>): TaskDoc & { demo: true } => {
    const p = person(assignee);
    return {
      title,
      description: "",
      assigneeId: assignee,
      assignedBy: p.manager ?? "26BM901",
      businessId: p.unit,
      dueAt: null,
      priority: "normal",
      status: "todo",
      repeat: { kind: "none" },
      isTemplate: false,
      templateId: null,
      occurrenceDate: null,
      createdAt: ts(today, "09:00"),
      doneAt: null,
      ...over,
      ...flag,
    };
  };
  const staffIds = PEOPLE.filter((p) => isRegularStaff(p) && p.status !== "pending").map((p) => p.id);
  let k = 0;
  for (const id of staffIds) {
    k++;
    await db.collection("tasks").add(mkTask(id, "Update stock register", { status: "done", dueAt: ts(yesterday, "17:00"), doneAt: ts(yesterday, "16:30"), createdAt: ts(addDays(today, -2), "10:00") }));
    await db.collection("tasks").add(mkTask(id, "Clean and arrange the display", { status: "done", dueAt: ts(today, "11:00"), doneAt: ts(today, "10:40") }));
    await db.collection("tasks").add(mkTask(id, "Call back pending customers", { dueAt: ts(today, "18:00"), priority: "high", description: "Everyone on the follow-up list for today." }));
    await db.collection("tasks").add(mkTask(id, "Submit weekly report", { dueAt: ts(addDays(today, 2), "17:00") }));
    if (k % 2 === 0) await db.collection("tasks").add(mkTask(id, "Reconcile cash drawer", { dueAt: ts(yesterday, "17:00"), priority: "high", createdAt: ts(addDays(today, -2), "10:00") })); // overdue
  }
  const tpl = await db.collection("tasks").add(mkTask("26BM903", "Daily cash tally", { repeat: { kind: "daily" }, isTemplate: true, assignedBy: "26BM902" }));
  await generateRecurringFor(ctx, today, tpl.id);

  // ---- leads, pools ----
  const NAMES = ["Rajesh", "Sangeetha", "Murugan", "Kavitha", "Dinesh", "Revathi", "Prakash", "Nandhini", "Gopal", "Shanthi", "Bala", "Uma", "Selvam", "Deepa", "Manoj", "Radha", "Vijay", "Sumathi", "Ashok", "Latha"];
  const SOURCES = ["manual", "leadSheet", "whatsapp", "ads"] as const;
  let phoneSeq = 0;
  const lead = async (unit: string, assignee: string | null, name: string, p: Partial<LeadDoc>, history: string[]): Promise<void> => {
    phoneSeq++;
    const phone = `97000${String(phoneSeq).padStart(5, "0")}`;
    const doc: LeadDoc & { demo: true } = {
      name,
      phone,
      notes: "",
      source: SOURCES[phoneSeq % SOURCES.length] as (typeof SOURCES)[number],
      businessId: unit,
      assigneeId: assignee,
      status: "new",
      temperature: null,
      nextFollowUpDate: today,
      closedValuePaise: null,
      closedDateIST: null,
      lostReason: null,
      externalId: null,
      createdAt: ts(addDays(today, -4), "11:00"),
      createdBy: assignee ?? "intake",
      ...p,
      ...flag,
    };
    const ref = db.collection("leads").doc();
    await ref.set(doc);
    await db.collection("leadPhones").doc(`${unit}_${phone}`).set({ leadId: ref.id, ...flag });
    for (const [i, h] of history.entries()) await ref.collection("history").add({ at: ts(addDays(today, -4 + i), "12:00"), by: assignee ?? "intake", status: doc.status, note: h });
  };
  let nameIdx = 0;
  const nm = () => `${NAMES[nameIdx++ % NAMES.length]} ${["K", "S", "R", "M"][nameIdx % 4]}`;
  for (const id of staffIds) {
    const p = person(id);
    const u = p.unit;
    await lead(u, id, nm(), { status: "new", nextFollowUpDate: today }, ["Lead created via manual"]);
    await lead(u, id, nm(), { status: "contacted", nextFollowUpDate: addDays(today, 1) }, ["Lead created", "Called, asked to call back tomorrow"]);
    await lead(u, id, nm(), { status: "followUp", temperature: "hot", nextFollowUpDate: today, notes: "Wants a demo of the premium plan." }, ["Lead created", "Interested, follow up today"]);
    await lead(u, id, nm(), { status: "followUp", temperature: "warm", nextFollowUpDate: addDays(today, -2) }, ["Lead created", "Will decide after salary day"]); // overdue
    await lead(u, id, nm(), { status: "followUp", temperature: "cold", nextFollowUpDate: addDays(today, 6) }, ["Lead created", "Not now, try next week"]);
    await lead(u, id, nm(), { status: "closedWon", closedValuePaise: (p.unit === "BM" ? 24500 : 9000) * 100, closedDateIST: addDays(today, -3), nextFollowUpDate: null }, ["Lead created", "Closed won"]);
    await lead(u, id, nm(), { status: "lost", lostReason: "Price too high", closedDateIST: addDays(today, -6), nextFollowUpDate: null }, ["Lead created", "Lost: price too high"]);
  }
  await lead("BM", null, nm(), { status: "new", nextFollowUpDate: today, source: "ads" }, ["Lead created via ads (no pool)"]);
  const pool = (unit: string, manager: string): PoolDoc & { demo: true } => ({ businessId: unit, source: "all", staffOrder: ids(unit, isRegularStaff), pointer: 0, skipAbsent: true, managerId: manager, ...flag });
  await db.collection("leadPools").add(pool("BM", "26BM902"));
  await db.collection("leadPools").add(pool("F6G1", "26F6G901"));

  // ---- advances ----
  const adv = (empId: string, amount: number, date: string, note: string) =>
    db.collection("advances").add({ employeeId: empId, businessId: person(empId).unit, amountPaise: amount * 100, recoveredPaise: 0, date, note, createdBy: "26BM901", createdAt: ts(date, "12:00"), ...flag });
  await adv("26BM907", 3000, `${prev}-05`, "Festival advance");
  await adv("26BM905", 5000, `${month}-05`, "Medical advance");

  // ---- audit trail samples ----
  const logs = [
    { actorId: "SA001", action: "employee.create", entity: "employees", entityId: "26BM901", before: null, after: { name: "Priya Nair", roles: ["staff", "admin"] }, reason: null },
    { actorId: "26BM901", action: "employee.update", entity: "employees", entityId: "26BM907", before: { designation: "Trainee" }, after: { designation: "Sales Executive" }, reason: "Promotion after probation" },
    { actorId: "26BM902", action: "target.set", entity: "employeeTargets", entityId: "26BM905", before: { targetPaise: 25000000 }, after: { targetPaise: 30000000 }, reason: "Revised monthly target" },
    { actorId: "26BM902", action: "attendance.correct", entity: "attendance", entityId: `26BM908_${addDays(today, -3)}`, before: { punchOutAt: null }, after: { punchOutAt: "22:05" }, reason: "Forgot to punch out; confirmed by CCTV" },
    { actorId: "26BM901", action: "advance.create", entity: "advances", entityId: "26BM905", before: null, after: { amountRupees: 5000 }, reason: null },
  ];
  for (const [i, l] of logs.entries()) await db.collection("auditLogs").add({ ...l, at: ts(addDays(today, -i), "15:00"), ...flag });

  // ---- scores, last month's payroll draft, rewards, this month's scores ----
  const lastDay = addDays(`${month}-01`, -1);
  await computeScores(ctx, lastDay, today);
  for (const unit of ["BM", "F6G1"]) await createDraft(ctx, unit, prev, today);
  const handlers = buildHandlers(ctx);
  await handlers["monthlyRewards"]?.({ slot: today, now });
  await computeScores(ctx, yesterday, today);

  void presentToday;
  console.log(`demo data loaded: ${PEOPLE.length} people, attendance ${start}..${today}, payroll draft for ${prev}`);
  console.log(`Demo logins (PIN ${DEMO_PIN}): Admin 9000000101 (use /admin), Manager 9000000102, Staff 9000000103 ...`);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const base = buildContext();
  // No real WhatsApp/n8n messages from demo runs.
  const ctx: AppContext = { ...base, notifier: createMemoryNotifier() };
  if (mode === "load") await loadDemo(ctx);
  else if (mode === "clear") await clearDemo(ctx);
  else throw new Error("Usage: demo.ts load|clear");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
