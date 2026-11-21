import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { addDays } from "@biglitz/shared";
import { createHarness, gpsAt, ist, seedBasics, type Harness } from "./harness.js";
import { createStaff } from "./flows.js";
import { buildHandlers } from "../src/cron/jobs.js";
import { runDueJobs, type JobRunStore } from "../src/cron/runner.js";

const h = createHarness();

beforeEach(async () => {
  await h.reset();
  h.setNow("2026-11-16 09:00:00");
  await seedBasics(h);
});

/** Writes a finished attendance day directly (fixtures only). */
async function seedDay(hh: Harness, id: string, date: string, inT = "09:20", outT = "22:05", businessId = "BM"): Promise<void> {
  const pin = { lat: gpsAt(10).lat, lng: gpsAt(10).lng, accuracy: 20, distanceMeters: 10, selfiePath: `selfies/${id}/${date}.jpg` };
  await hh.ctx.db.collection("attendance").doc(`${id}_${date}`).set({
    employeeId: id,
    businessId,
    dateIST: date,
    punchInAt: Timestamp.fromDate(ist(`${date} ${inT}`)),
    punchOutAt: Timestamp.fromDate(ist(`${date} ${outT}`)),
    punchIn: pin,
    punchOut: pin,
    shift: { start: "09:30", end: "22:00" },
    halfDay: false,
    absentOverride: false,
    corrections: [],
  });
}

async function seedMonth(hh: Harness, id: string, month: string, days: number, skip: string[] = [], late: string[] = []): Promise<void> {
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    if (skip.includes(date)) continue;
    await seedDay(hh, id, date, late.includes(date) ? "10:05" : "09:20");
  }
}

async function seedSales(hh: Harness, id: string, date: string, rupees: number): Promise<void> {
  await hh.ctx.db.collection("dailySales").doc(`${id}_${date}`).set({
    employeeId: id,
    businessId: "BM",
    dateIST: date,
    values: { "new-mobiles": rupees * 100, "second-hand-mobiles": 0, accessories: 0, service: 0 },
    amountTotalPaise: rupees * 100,
    noSales: false,
    submittedAt: Timestamp.fromDate(ist(`${date} 21:00:00`)),
    corrections: [],
  });
}

describe("discipline score, rank, streak and home (Phase 3)", () => {
  it("computes ranks with tie-breaks and the Home numbers", async () => {
    const a = await createStaff(h, { name: "A", mobile: "9876500001", joiningDate: "2026-11-01" });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", joiningDate: "2026-11-01" });
    await seedMonth(h, a, "2026-11", 13);
    await seedMonth(h, b, "2026-11", 13, [], ["2026-11-10"]); // one late day
    h.setNow("2026-11-14 00:15:00");
    const handlers = buildHandlers(h.ctx);
    await handlers["dayClose"]?.({ slot: "2026-11-14", now: h.now() });
    const scoreA = (await h.ctx.db.collection("scores").doc(`${a}_2026-11`).get()).data();
    const scoreB = (await h.ctx.db.collection("scores").doc(`${b}_2026-11`).get()).data();
    expect(scoreA).toMatchObject({ score: 100, rank: 1, streak: 13, presentDays: 13, onTimeDays: 13 });
    expect(scoreB?.["rank"]).toBe(2);
    expect(scoreB?.["score"]).toBeCloseTo(96.2, 1); // att 100%, punctuality 12/13 = 92.3% -> 96.2
    expect(scoreB?.["streak"]).toBe(3); // 11th, 12th, 13th after the late 10th
    expect(scoreA?.["badges"]).toContain("neverLate");
    expect(scoreB?.["badges"]).not.toContain("neverLate");

    h.setNow("2026-11-14 10:00:00");
    const home = (await h.call("GET", "/api/me/home", { as: b })).body;
    expect(home.rank).toMatchObject({ unit: 2, score: scoreB?.["score"] });
    expect(home.rank.gap.toRank).toBe(1);
    expect(home.rank.gap.points).toBeCloseTo(3.8, 1);
    expect(home.salarySoFarPaise).toBe(13 * 50_000);
    expect(home.projectedSalaryPaise).toBe(1_600_000); // present every remaining day => 32 payable days
    expect(home.leave).toEqual({ used: 0, free: 2, overFree: false });
    expect(home.streak).toBe(3);
    // Staff see the unit leaderboard (rank + name + score), not salary.
    const lb = await h.call("GET", "/api/leaderboard", { as: b });
    expect(lb.body.entries.map((e: { name: string }) => e.name)).toEqual(["A", "B"]);
    expect(JSON.stringify(lb.body)).not.toMatch(/salary|incentive|paise/i);
    // Leave used turns red above 2 free days.
    await h.ctx.db.collection("attendance").doc(`${b}_2026-11-12`).delete();
    await h.ctx.db.collection("attendance").doc(`${b}_2026-11-11`).delete();
    await h.ctx.db.collection("attendance").doc(`${b}_2026-11-13`).delete();
    const home2 = (await h.call("GET", "/api/me/home", { as: b })).body;
    expect(home2.leave).toMatchObject({ used: 3, overFree: true });
  });

  it("punch-out shows Today you earned with the estimated incentive", async () => {
    const a = await createStaff(h, { name: "A", mobile: "9876500001", joiningDate: "2026-11-01" });
    await seedSales(h, a, "2026-11-10", 250_000); // 83% of 3,00,000 => 1% slab
    h.setNow("2026-11-16 09:20:00");
    const slot = await h.call("POST", "/api/uploads/selfie-url", { as: a, body: { kind: "in" } });
    h.files.put(slot.body.path);
    await h.call("POST", "/api/attendance/punch-in", { as: a, body: { gps: gpsAt(10), selfiePath: slot.body.path } });
    await h.call("POST", "/api/sales/today", { as: a, body: { values: { "new-mobiles": 10000, "second-hand-mobiles": 0, accessories: 0, service: 0 } } });
    h.setNow("2026-11-16 22:05:00");
    const out = await h.call("POST", "/api/uploads/selfie-url", { as: a, body: { kind: "out" } });
    h.files.put(out.body.path);
    const r = await h.call("POST", "/api/attendance/punch-out", { as: a, body: { gps: gpsAt(10), selfiePath: out.body.path } });
    // 260,000 / 300,000 = 86.7% => 1% of today's 10,000 = Rs 100
    expect(r.body.earned).toMatchObject({ salaryPaise: 50_000, incentiveEstimatePaise: 10_000, totalPaise: 60_000, incentiveIsEstimate: true });
  });
});

describe("payroll, incentive, lock, payslips (Phase 4; acceptance 8-10, 15)", () => {
  async function setup() {
    // The manager and admin join in December so they have no November payroll lines.
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"], joiningDate: "2026-12-01" });
    const admin = await createStaff(h, { name: "Adm", mobile: "9876500010", roles: ["admin"], adminBusinessIds: ["BM"], joiningDate: "2026-12-01" });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr });
    const c = await createStaff(h, { name: "C", mobile: "9876500003", managerId: mgr });
    await seedMonth(h, a, "2026-11", 30, ["2026-11-05", "2026-11-06"]); // 2 leave days
    await seedMonth(h, b, "2026-11", 30); // zero leave
    await seedMonth(h, c, "2026-11", 30, ["2026-11-05", "2026-11-06"]);
    await seedSales(h, a, "2026-11-20", 320_000); // 106.67% => 1.5% => Rs 4,800
    await seedSales(h, b, "2026-11-20", 200_000); // 66.67% => 0
    await seedSales(h, c, "2026-11-20", 240_000); // exactly 80% => 1% => Rs 2,400
    h.setNow("2026-11-25 10:00:00");
    // Admin records advances: Rs 3,000 for A; Rs 20,000 for C.
    expect((await h.call("POST", "/api/advances", { as: admin, body: { employeeId: a, amountRupees: 3000, date: "2026-11-25", note: "festival" } })).status).toBe(200);
    expect((await h.call("POST", "/api/advances", { as: "SA001", body: { employeeId: c, amountRupees: 20000, date: "2026-11-25" } })).status).toBe(200);
    expect((await h.call("POST", "/api/advances", { as: mgr, body: { employeeId: a, amountRupees: 100, date: "2026-11-25" } })).status).toBe(403); // managers cannot
    return { mgr, admin, a, b, c };
  }

  const line = async (id: string, month = "2026-11") => (await h.ctx.db.collection("payrollRuns").doc(`BM_${month}`).collection("lines").doc(id).get()).data() as Record<string, any>;

  it("drafts exact salary, advance and incentive numbers; approval locks the month; payslips follow both approvals", async () => {
    const { mgr, admin, a, b, c } = await setup();
    const handlers = buildHandlers(h.ctx);
    h.setNow("2026-12-01 06:00:00");
    await handlers["payrollDraft"]?.({ slot: "2026-12-01", now: h.now() });

    const la = await line(a);
    const lb = await line(b);
    const lc = await line(c);
    // Salary: A leave 2 => Rs 15,000 - advance 3,000 = 12,000; B leave 0 => 16,000; C 15,000 with Rs 20,000 advance => net 0, carry 5,000
    expect(la).toMatchObject({ D: 30, E: 30, P: 28, leaveDays: 2, netSalaryPaise: 1_200_000, advanceRecoveredPaise: 300_000, advanceCarriedPaise: 0 });
    expect(lb).toMatchObject({ P: 30, leaveDays: 0, netSalaryPaise: 1_600_000 });
    expect(lc).toMatchObject({ netSalaryPaise: 0, advanceRecoveredPaise: 1_500_000, advanceCarriedPaise: 500_000 });
    // Incentive (acceptance 10)
    expect(la.incentive).toMatchObject({ incentivePaise: 480_000, rateBps: 150 });
    expect(lb.incentive).toMatchObject({ incentivePaise: 0, rateBps: 0 });
    expect(lc.incentive).toMatchObject({ incentivePaise: 240_000, rateBps: 100 });

    // Manager or Admin can assign a penalty to their staff; not to self / outside scope.
    expect((await h.call("POST", "/api/penalties", { as: mgr, body: { employeeId: mgr, amountRupees: 100, date: "2026-11-25", reason: "self" } })).status).toBe(403);
    expect((await h.call("POST", "/api/penalties", { as: mgr, body: { employeeId: b, amountRupees: 500, date: "2026-11-25", reason: "Late without notice" } })).status).toBe(200);
    const lbPen = await line(b);
    expect(lbPen.netSalaryPaise).toBe(1_550_000);
    expect((lbPen.adjustments as Array<{ reason: string; amountPaise: number }>).some((x) => x.reason.startsWith("Penalty:") && x.amountPaise === -50_000)).toBe(true);

    // Draft is idempotent and does not wipe adjustments.
    const adj = await h.call("POST", "/api/payroll/BM/2026-11/adjustments", { as: admin, body: { employeeId: a, amountRupees: 500, reason: "Travel allowance" } });
    expect(adj.status).toBe(200);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/adjustments", { as: admin, body: { employeeId: a, amountRupees: 500, reason: "" } })).status).toBe(400);
    await handlers["payrollDraft"]?.({ slot: "2026-12-01", now: h.now() });
    expect((await line(a))["netSalaryPaise"]).toBe(1_250_000);
    expect((await h.ctx.db.collection("payrollRuns").doc("BM_2026-11").collection("lines").get()).size).toBe(3);

    // Staff / managers cannot see payroll; Admin without canApprovePayroll cannot approve.
    expect((await h.call("GET", "/api/payroll/BM/2026-11", { as: a })).status).toBe(403);
    expect((await h.call("GET", "/api/payroll/BM/2026-11", { as: mgr })).status).toBe(403);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/approve", { as: admin, body: { part: "salary" } })).status).toBe(403);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/approve", { as: "SA001", body: { part: "salary" } })).body.code).toBe("NOT_SUBMITTED");
    expect((await h.call("POST", "/api/payroll/BM/2026-11/submit", { as: admin, body: { part: "salary" } })).status).toBe(200);
    expect((await h.call("GET", "/api/payroll/BM/2026-11/transfer.csv?part=salary", { as: admin })).body.code).toBe("NOT_APPROVED");
    const approve = await h.call("POST", "/api/payroll/BM/2026-11/approve", { as: "SA001", body: { part: "salary" } });
    expect(approve.status).toBe(200);
    expect(approve.body.payslipsGenerated).toBe(0); // incentive not approved yet

    // Advances recovered atomically at approval.
    const advA = (await h.ctx.db.collection("advances").where("employeeId", "==", a).get()).docs[0]?.data();
    const advC = (await h.ctx.db.collection("advances").where("employeeId", "==", c).get()).docs[0]?.data();
    expect(advA?.["recoveredPaise"]).toBe(300_000);
    expect(advC?.["recoveredPaise"]).toBe(1_500_000); // Rs 5,000 still outstanding
    const penB = (await h.ctx.db.collection("penalties").where("employeeId", "==", b).get()).docs[0]?.data();
    expect(penB?.["recoveredPaise"]).toBe(50_000);

    // Month locked: attendance / sales / leave / adjustments all rejected (acceptance 15).
    h.setNow("2026-12-02 10:00:00");
    const att = await h.call("POST", "/api/attendance/correct", { as: mgr, body: { employeeId: a, dateIST: "2026-11-05", punchInAt: ist("2026-11-05 09:00:00").toISOString(), reason: "forgot" } });
    expect(att.status).toBe(423);
    expect(att.body).toEqual({ code: "MONTH_LOCKED", message: expect.stringContaining("Month locked") });
    expect((await h.call("POST", "/api/sales/correct", { as: mgr, body: { employeeId: a, dateIST: "2026-11-20", values: { "new-mobiles": 1, "second-hand-mobiles": 0, accessories: 0, service: 0 }, reason: "typo" } })).status).toBe(423);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/adjustments", { as: admin, body: { employeeId: a, amountRupees: 1, reason: "x" } })).body.code).toBe("NOT_DRAFT");

    // Salary bank list: names, account, IFSC, amount (C has net 0 so is excluded).
    const csv = await h.call("GET", "/api/payroll/BM/2026-11/transfer.csv?part=salary", { as: admin });
    expect(csv.status).toBe(200);
    const rows = csv.raw.trim().split("\n");
    expect(rows[0]).toBe("Name,Account Number,IFSC,Amount");
    expect(rows).toHaveLength(3);
    expect(csv.raw).toContain('"A","123456789012","SBIN0001234",12500');
    expect(csv.raw).toContain('"B","123456789012","SBIN0001234",15500');

    // Incentive approved separately; payslips only after BOTH.
    expect((await h.call("POST", "/api/payroll/BM/2026-11/submit", { as: admin, body: { part: "incentive" } })).status).toBe(200);
    const inc = await h.call("POST", "/api/payroll/BM/2026-11/approve", { as: "SA001", body: { part: "incentive" } });
    expect(inc.body.payslipsGenerated).toBe(3);
    const icsv = await h.call("GET", "/api/payroll/BM/2026-11/transfer.csv?part=incentive", { as: admin });
    expect(icsv.raw).toContain(",4800");
    expect(icsv.raw).toContain(",2400");
    expect(icsv.raw.trim().split("\n")).toHaveLength(3); // B's incentive is 0 so omitted
    expect(h.files.saved.has(`payslips/${a}_2026-11.pdf`)).toBe(true);
    const pdf = h.files.saved.get(`payslips/${a}_2026-11.pdf`);
    expect(Buffer.from(pdf ?? []).subarray(0, 4).toString()).toBe("%PDF");

    // Staff see only their own payslip.
    const mine = await h.call("GET", "/api/payslips", { as: a });
    expect(mine.body.payslips).toEqual([{ month: "2026-11", netSalaryPaise: 1_250_000, incentivePaise: 480_000 }]);
    expect((await h.call("GET", "/api/payslips/2026-11/url", { as: a })).status).toBe(200);
    expect((await h.call("GET", "/api/payslips", { as: b })).body.payslips).toHaveLength(1);
    expect((await h.call("GET", `/api/payslips/2026-11/url`, { as: "SA001" })).status).toBe(404);

    expect((await h.call("POST", "/api/payroll/BM/2026-11/paid", { as: admin, body: { part: "salary" } })).status).toBe(200);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/paid", { as: admin, body: { part: "salary" } })).body.code).toBe("NOT_APPROVED");
  });

  it("editing attendance in a draft month recalculates that line; sending back to draft works", async () => {
    const { mgr, admin, a } = await setup();
    const handlers = buildHandlers(h.ctx);
    h.setNow("2026-12-01 06:00:00");
    await handlers["payrollDraft"]?.({ slot: "2026-12-01", now: h.now() });
    expect((await line(a))["leaveDays"]).toBe(2);
    h.setNow("2026-12-01 10:00:00");
    const fix = await h.call("POST", "/api/attendance/correct", { as: mgr, body: { employeeId: a, dateIST: "2026-11-05", punchInAt: ist("2026-11-05 09:00:00").toISOString(), punchOutAt: ist("2026-11-05 22:00:00").toISOString(), reason: "Biometric missed" } });
    expect(fix.status).toBe(200);
    expect(await line(a)).toMatchObject({ leaveDays: 1, P: 29, netSalaryPaise: 1_550_000 - 300_000 });
    await h.call("POST", "/api/payroll/BM/2026-11/submit", { as: admin, body: { part: "salary" } });
    expect((await h.call("POST", "/api/payroll/BM/2026-11/reopen", { as: "SA001", body: { part: "salary" } })).status).toBe(200);
    expect((await h.call("POST", "/api/payroll/BM/2026-11/submit", { as: admin, body: { part: "salary" } })).status).toBe(200);
  });

  it("monthly rewards: top 3 get 5000/3000/1000 as bonus lines, once only (acceptance 16)", async () => {
    const { a, b, c } = await setup();
    const handlers = buildHandlers(h.ctx);
    h.setNow("2026-12-01 00:15:00");
    await handlers["dayClose"]?.({ slot: "2026-12-01", now: h.now() });
    h.setNow("2026-12-01 06:00:00");
    await handlers["payrollDraft"]?.({ slot: "2026-12-01", now: h.now() });
    h.setNow("2026-12-01 06:30:00");
    await handlers["monthlyRewards"]?.({ slot: "2026-12-01", now: h.now() });
    await handlers["monthlyRewards"]?.({ slot: "2026-12-01", now: h.now() });
    const rewards = (await h.ctx.db.collection("rewards").doc("2026-11").get()).data() as { winners: Array<{ employeeId: string; amountPaise: number; rank: number }> };
    expect(rewards.winners.map((w) => w.amountPaise)).toEqual([500_000, 300_000, 100_000]);
    expect(rewards.winners[0]?.employeeId).toBe(b); // B has zero leave => best score
    // Bonus lines applied exactly once.
    const lb = await line(b);
    expect(lb.adjustments).toHaveLength(1);
    expect(lb.netSalaryPaise).toBe(1_600_000 + 500_000);
    for (const id of [a, c]) expect((await line(id)).adjustments).toHaveLength(1);
    expect((await h.call("GET", "/api/rewards?month=2026-11", { as: a })).body.rewards.winners).toHaveLength(3);
  });
});

describe("cron idempotency (acceptance 16)", () => {
  it("running the dispatcher twice in a row creates no duplicates", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr, joiningDate: "2026-11-01" });
    await seedMonth(h, a, "2026-11", 30);
    await h.call("POST", "/api/tasks", { as: mgr, body: { title: "Daily", assigneeId: a, repeat: { kind: "daily" } } });
    await h.call("POST", "/api/leads", { as: a, body: { name: "L", phone: "9700000011" } });

    const jobRuns = new Map<string, unknown>();
    const store: JobRunStore = {
      async claim(id, data) {
        if (jobRuns.has(id)) return false;
        jobRuns.set(id, data);
        return true;
      },
      async finish() {},
    };
    const handlers = buildHandlers(h.ctx);
    h.setNow("2026-12-01 10:30:00"); // the 1st: every job is due
    const counts = async () => {
      const c = async (name: string) => (await h.ctx.db.collection(name).get()).size;
      return { tasks: await c("tasks"), scores: await c("scores"), boards: await c("leaderboards"), runs: await c("payrollRuns"), rewards: await c("rewards"), events: h.notifier.events.length };
    };
    const first = await runDueJobs(h.now(), store, handlers);
    expect(first.every((r) => r.outcome === "ran")).toBe(true);
    const afterFirst = await counts();
    const second = await runDueJobs(h.now(), store, handlers);
    expect(second.every((r) => r.outcome === "skipped-already-run")).toBe(true);
    expect(await counts()).toEqual(afterFirst);

    // Even if a claim were lost (crash), re-running every body directly must not duplicate anything.
    for (const [name, fn] of Object.entries(handlers)) await fn({ slot: `${name}-again`, now: h.now() });
    expect(await counts()).toEqual(afterFirst);
    expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
  });
});
