import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, gpsAt, ist, seedBasics } from "./harness.js";
import { createStaff, punch, submitNoSales, uploadAadhaar } from "./flows.js";

const h = createHarness();

beforeEach(async () => {
  await h.reset();
  h.setNow("2026-11-16 09:00:00");
  await seedBasics(h);
});

describe("employee IDs (acceptance 1, 2)", () => {
  it("26BM015 when the counter is 14; counter becomes 15; simultaneous creates never collide", async () => {
    await h.ctx.db.collection("businessUnits").doc("BM").update({ idCounter: 14 });
    const first = await createStaff(h, { name: "A", mobile: "9876500001", joiningDate: "2026-03-01" });
    expect(first).toBe("26BM015");
    expect((await h.ctx.db.collection("businessUnits").doc("BM").get()).data()?.["idCounter"]).toBe(15);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        h.call("POST", "/api/employees", {
          as: "SA001",
          body: { name: `P${n}`, mobile: `98765000${10 + n}`, tempPin: "5802", businessId: "BM", joiningDate: "2026-03-01", committedSalaryRupees: 10000 },
        }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const ids = results.map((r) => r.body.employee.employeeId as string);
    expect(new Set(ids).size).toBe(5);
    expect((await h.ctx.db.collection("businessUnits").doc("BM").get()).data()?.["idCounter"]).toBe(20);
  });

  it("back-dated joiner in 2025 gets 25BM016 (counter never resets)", async () => {
    await h.ctx.db.collection("businessUnits").doc("BM").update({ idCounter: 14 });
    await createStaff(h, { name: "A", mobile: "9876500001", joiningDate: "2026-03-01" });
    const second = await createStaff(h, { name: "B", mobile: "9876500002", joiningDate: "2025-05-10" });
    expect(second).toBe("25BM016");
  });

  it("uses the unit code in the id and rejects a duplicate mobile", async () => {
    const id = await createStaff(h, { name: "F", mobile: "9876500003", businessId: "F6G1" });
    expect(id).toBe("26F6G1001");
    const dup = await h.call("POST", "/api/employees", { as: "SA001", body: { name: "X", mobile: "9876500003", tempPin: "5802", businessId: "BM", joiningDate: "2026-03-01", committedSalaryRupees: 1 } });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ code: "MOBILE_EXISTS", message: expect.any(String) });
  });
});

describe("login (spec 5)", () => {
  it("first login forces a PIN change; weak PINs rejected", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" }, "SA001", { activate: false });
    await uploadAadhaar(h, id);
    await h.call("POST", `/api/employees/${id}/activate`, { as: "SA001" });
    const login = await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "5802" } });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePin).toBe(true);
    // Other endpoints are blocked until the PIN is changed.
    expect((await h.call("GET", "/api/attendance/today", { as: id })).body.code).toBe("PIN_CHANGE_REQUIRED");
    for (const bad of ["0000", "1234", "0001"]) {
      const r = await h.call("POST", "/api/auth/change-pin", { as: id, body: { currentPin: "5802", newPin: bad } });
      expect(r.status).toBe(400);
    }
    const ok = await h.call("POST", "/api/auth/change-pin", { as: id, body: { currentPin: "5802", newPin: "4821" } });
    expect(ok.status).toBe(200);
    expect((await h.call("GET", "/api/attendance/today", { as: id })).status).toBe(200);
  });

  it("5 wrong PINs lock the account for 15 minutes; Admin can reset", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    for (let i = 0; i < 4; i++) {
      expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "9999" } })).body.code).toBe("BAD_CREDENTIALS");
    }
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "9999" } })).body.code).toBe("ACCOUNT_LOCKED");
    // Even the correct PIN is refused while locked.
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "4821" } })).status).toBe(423);
    h.setNow("2026-11-16 09:16:00");
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "4821" } })).status).toBe(200);
    // Admin reset forces a change again.
    expect((await h.call("POST", `/api/employees/${id}/reset-pin`, { as: "SA001", body: { tempPin: "6150" } })).status).toBe(200);
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "6150" } })).body.mustChangePin).toBe(true);
  });

  it("exited employee cannot log in the day after the exit date (acceptance 17)", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    const exit = await h.call("POST", `/api/employees/${id}/exit`, { as: "SA001", body: { exitDate: "2026-11-16", reason: "Resigned" } });
    expect(exit.status).toBe(200);
    // On the exit date itself they can still log in; the next day they cannot.
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "4821" } })).status).toBe(200);
    h.setNow("2026-11-17 08:00:00");
    const next = await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "4821" } });
    expect(next.status).toBe(401);
    expect(next.body.code).toBe("ACCOUNT_INACTIVE");
    expect((await h.call("GET", "/api/attendance/today", { as: id })).status).toBe(401);
  });

  it("pending employee (no Aadhaar yet) cannot log in", async () => {
    await createStaff(h, { name: "A", mobile: "9876500001" }, "SA001", { activate: false });
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "5802" } })).body.code).toBe("ACCOUNT_INACTIVE");
  });
});

describe("documents (spec 7.3)", () => {
  it("Aadhaar is mandatory before activation; visibility is limited", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const id = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr }, "SA001", { activate: false });
    const early = await h.call("POST", `/api/employees/${id}/activate`, { as: "SA001" });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe("AADHAAR_REQUIRED");

    const up = await h.call("POST", `/api/employees/${id}/documents/upload-url`, { as: "SA001", body: { kind: "other", remark: "", contentType: "application/pdf", sizeBytes: 5, fileName: "x.pdf" } });
    expect(up.body.code).toBe("REMARK_REQUIRED");
    const big = await h.call("POST", `/api/employees/${id}/documents/upload-url`, { as: "SA001", body: { kind: "other", remark: "x", contentType: "application/pdf", sizeBytes: 11 * 1024 * 1024, fileName: "x.pdf" } });
    expect(big.status).toBe(400);
    const exe = await h.call("POST", `/api/employees/${id}/documents/upload-url`, { as: "SA001", body: { kind: "other", remark: "x", contentType: "application/zip", sizeBytes: 10, fileName: "x.zip" } });
    expect(exe.status).toBe(400);

    await uploadAadhaar(h, id);
    expect((await h.call("POST", `/api/employees/${id}/activate`, { as: "SA001" })).status).toBe(200);

    const docs = await h.call("GET", `/api/employees/${id}/documents`, { as: "SA001" });
    expect(docs.body.documents).toHaveLength(2);
    // Employee sees own; Manager and other staff never do.
    const self = await h.call("POST", "/api/auth/login", { body: { mobile: "9876500001", pin: "5802" } });
    expect(self.status).toBe(200);
    await h.call("POST", "/api/auth/change-pin", { as: id, body: { currentPin: "5802", newPin: "4821" } });
    expect((await h.call("GET", `/api/employees/${id}/documents`, { as: id })).status).toBe(200);
    expect((await h.call("GET", `/api/employees/${id}/documents`, { as: mgr })).status).toBe(403);
    const other = await createStaff(h, { name: "B", mobile: "9876500002" });
    expect((await h.call("GET", `/api/employees/${id}/documents`, { as: other })).status).toBe(403);
    // Full Aadhaar number is never stored: only the last 4 digits.
    const pay = (await h.ctx.db.collection("employeePay").doc(id).get()).data();
    expect(pay?.["aadhaarLast4"]).toBe("4321");
  });
});

describe("scope (acceptance 13, 14 at API level)", () => {
  it("staff cannot read another staff member, salary, or payslip; managers cannot read pay", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr });
    expect((await h.call("GET", `/api/employees/${b}`, { as: a })).status).toBe(403);
    expect((await h.call("GET", `/api/employees/${b}/pay`, { as: a })).status).toBe(403);
    expect((await h.call("GET", `/api/employees/${a}/pay`, { as: a })).status).toBe(200);
    expect((await h.call("GET", `/api/employees/${a}`, { as: mgr })).status).toBe(200);
    expect((await h.call("GET", `/api/employees/${a}/pay`, { as: mgr })).status).toBe(403);
    expect((await h.call("GET", `/api/employees/${a}/target`, { as: mgr })).status).toBe(200);
    const list = await h.call("GET", "/api/employees", { as: a });
    expect(list.body.employees.map((e: { employeeId: string }) => e.employeeId)).toEqual([a]);
  });

  it("manager sees only their team; admin sees only assigned units", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const mine = await createStaff(h, { name: "Mine", mobile: "9876500001", managerId: mgr });
    const notMine = await createStaff(h, { name: "NotMine", mobile: "9876500002" });
    const list = (await h.call("GET", "/api/employees", { as: mgr })).body.employees.map((e: { employeeId: string }) => e.employeeId);
    expect(list).toContain(mine);
    expect(list).not.toContain(notMine);
    expect((await h.call("GET", `/api/employees/${notMine}`, { as: mgr })).status).toBe(403);

    const admin = await createStaff(h, { name: "Adm", mobile: "9876500010", roles: ["admin"], adminBusinessIds: ["BM"] });
    const fitoStaff = await createStaff(h, { name: "F", mobile: "9876500011", businessId: "F6G1" });
    expect((await h.call("GET", `/api/employees/${notMine}`, { as: admin })).status).toBe(200);
    expect((await h.call("GET", `/api/employees/${fitoStaff}`, { as: admin })).status).toBe(403);
    const adminList = (await h.call("GET", "/api/employees", { as: admin })).body.employees.map((e: { businessId: string }) => e.businessId);
    expect(adminList.every((u: string) => u === "BM")).toBe(true);
    // Admin cannot create an employee in an unassigned unit, nor another Admin.
    const bad = await h.call("POST", "/api/employees", { as: admin, body: { name: "Z", mobile: "9876500012", tempPin: "5802", businessId: "F6G1", joiningDate: "2026-03-01", committedSalaryRupees: 1 } });
    expect(bad.status).toBe(403);
    const adm2 = await h.call("POST", "/api/employees", { as: admin, body: { name: "Z", mobile: "9876500013", tempPin: "5802", businessId: "BM", roles: ["admin"], joiningDate: "2026-03-01", committedSalaryRupees: 1 } });
    expect(adm2.status).toBe(403);
    // Roles are re-checked from Firestore on every call (a stale token cannot widen scope).
    await h.ctx.db.collection("employees").doc(admin).update({ adminBusinessIds: [] });
    expect((await h.call("GET", `/api/employees/${notMine}`, { as: admin })).status).toBe(403);
  });

  it("only the Super Admin creates units; Admin cannot", async () => {
    const admin = await createStaff(h, { name: "Adm", mobile: "9876500010", roles: ["admin"], adminBusinessIds: ["BM"] });
    expect((await h.call("POST", "/api/units", { as: admin, body: { name: "Casifly", code: "CF" } })).status).toBe(403);
    expect((await h.call("POST", "/api/units", { as: "SA001", body: { name: "Casifly", code: "CF" } })).status).toBe(200);
    expect((await h.call("POST", "/api/units", { as: "SA001", body: { name: "Casifly", code: "CF" } })).status).toBe(409);
    expect((await h.call("PATCH", "/api/units/BM", { as: admin, body: { holidays: [{ date: "2026-11-20", name: "Fest" }] } })).status).toBe(200);
    expect((await h.call("PATCH", "/api/units/F6G1", { as: admin, body: { name: "Hack" } })).status).toBe(403);
  });
});

describe("punch in / out (acceptance 3-6)", () => {
  it("120 m is rejected with the distance shown; 80 m is accepted", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    h.setNow("2026-11-16 09:20:00");
    const far = await punch(h, id, "in", gpsAt(120));
    expect(far.status).toBe(400);
    expect(far.body.code).toBe("OUT_OF_RANGE");
    expect(far.body.message).toMatch(/120 m/);
    const near = await punch(h, id, "in", gpsAt(80));
    expect(near.status).toBe(200);
    expect(near.body.attendance.state).toBe("punchedIn");
  });

  it("rejects poor GPS accuracy, missing selfie, and a unit with no location", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    const slot = await h.call("POST", "/api/uploads/selfie-url", { as: id, body: { kind: "in" } });
    const noFile = await h.call("POST", "/api/attendance/punch-in", { as: id, body: { gps: gpsAt(10), selfiePath: slot.body.path } });
    expect(noFile.body.code).toBe("SELFIE_MISSING");
    const stolen = await h.call("POST", "/api/attendance/punch-in", { as: id, body: { gps: gpsAt(10), selfiePath: "selfies/OTHER/x.jpg" } });
    expect(stolen.body.code).toBe("BAD_SELFIE");
    const poor = await punch(h, id, "in", { ...gpsAt(10), accuracy: 250 });
    expect(poor.body.code).toBe("GPS_ACCURACY");
    const fito = await createStaff(h, { name: "F", mobile: "9876500002", businessId: "F6G1" });
    expect((await punch(h, fito, "in", gpsAt(10))).body.code).toBe("NO_LOCATION");
  });

  it("09:30:45 is on time, 09:31:00 is late; punch-out 21:55 is not on time (acceptance 4)", async () => {
    const early = await createStaff(h, { name: "Early", mobile: "9876500001" });
    const late = await createStaff(h, { name: "Late", mobile: "9876500002" });
    const leaver = await createStaff(h, { name: "Leaver", mobile: "9876500003" });
    h.setNow(ist("2026-11-16 09:30:45"));
    expect((await punch(h, early, "in", gpsAt(10))).status).toBe(200);
    h.setNow(ist("2026-11-16 09:31:00"));
    expect((await punch(h, late, "in", gpsAt(10))).status).toBe(200);
    expect((await punch(h, leaver, "in", gpsAt(10))).status).toBe(200);
    for (const id of [early, late, leaver]) await submitNoSales(h, id);
    h.setNow(ist("2026-11-16 22:00:00"));
    expect((await punch(h, early, "out", gpsAt(10))).status).toBe(200);
    expect((await punch(h, late, "out", gpsAt(10))).status).toBe(200);
    h.setNow(ist("2026-11-16 21:55:00"));
    expect((await punch(h, leaver, "out", gpsAt(10))).status).toBe(200);
    h.setNow("2026-11-17 08:00:00");
    const status = async (id: string) => (await h.call("GET", `/api/attendance/calendar?month=2026-11`, { as: id })).body.days.find((d: { date: string }) => d.date === "2026-11-16").status;
    expect(await status(early)).toBe("onTime");
    expect(await status(late)).toBe("late");
    expect(await status(leaver)).toBe("earlyLeave");
  });

  it("a second punch-in the same day is rejected (acceptance 5)", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    expect((await punch(h, id, "in", gpsAt(10))).status).toBe(200);
    const again = await punch(h, id, "in", gpsAt(10));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_PUNCHED_IN");
  });

  it("punch-out is blocked without a sales entry; 'No sales today' saves all zeros (acceptance 6)", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    await punch(h, id, "in", gpsAt(10));
    h.setNow("2026-11-16 22:05:00");
    const blocked = await punch(h, id, "out", gpsAt(10));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("SALES_REQUIRED");
    const none = await submitNoSales(h, id);
    expect(none.status).toBe(200);
    expect(none.body.entry.values).toEqual({ "new-mobiles": 0, "second-hand-mobiles": 0, accessories: 0, service: 0 });
    expect(none.body.entry.noSales).toBe(true);
    const out = await punch(h, id, "out", gpsAt(10));
    expect(out.status).toBe(200);
    expect(out.body.earned.salaryPaise).toBe(50_000);
    expect(out.body.earned.incentiveIsEstimate).toBe(true);
    expect((await punch(h, id, "out", gpsAt(10))).body.code).toBe("ALREADY_PUNCHED_OUT");
  });

  it("every category needs a value; amount values are stored in paise", async () => {
    const id = await createStaff(h, { name: "A", mobile: "9876500001" });
    const partial = await h.call("POST", "/api/sales/today", { as: id, body: { values: { "new-mobiles": 1000 } } });
    expect(partial.body.code).toBe("SALES_INCOMPLETE");
    const unknown = await h.call("POST", "/api/sales/today", { as: id, body: { values: { bogus: 1 } } });
    expect(unknown.body.code).toBe("BAD_CATEGORY");
    const ok = await h.call("POST", "/api/sales/today", { as: id, body: { values: { "new-mobiles": 25000, "second-hand-mobiles": 0, accessories: 500, service: 0 } } });
    expect(ok.body.entry.amountTotalPaise).toBe(2_550_000);
    // Staff can edit their own entry the same day.
    const edit = await h.call("POST", "/api/sales/today", { as: id, body: { values: { "new-mobiles": 30000, "second-hand-mobiles": 0, accessories: 500, service: 0 } } });
    expect(edit.body.entry.amountTotalPaise).toBe(3_050_000);
  });

  it("corrections need a reason, are audited, and manager scope applies", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const id = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const outsider = await createStaff(h, { name: "O", mobile: "9876500002" });
    h.setNow("2026-11-17 10:00:00");
    const noReason = await h.call("POST", "/api/attendance/correct", { as: mgr, body: { employeeId: id, dateIST: "2026-11-16", punchInAt: ist("2026-11-16 09:00:00").toISOString(), reason: "" } });
    expect(noReason.status).toBe(400);
    const fix = await h.call("POST", "/api/attendance/correct", { as: mgr, body: { employeeId: id, dateIST: "2026-11-16", punchInAt: ist("2026-11-16 09:00:00").toISOString(), punchOutAt: ist("2026-11-16 22:00:00").toISOString(), reason: "Phone died" } });
    expect(fix.status).toBe(200);
    expect(fix.body.attendance.status).toBe("onTime");
    expect((await h.call("POST", "/api/attendance/correct", { as: mgr, body: { employeeId: outsider, dateIST: "2026-11-16", markAbsent: true, reason: "x" } })).status).toBe(403);
    const audit = await h.call("GET", "/api/audit?entity=attendance", { as: "SA001" });
    expect(audit.body.logs).toHaveLength(1);
    expect(audit.body.logs[0]).toMatchObject({ actorId: mgr, reason: "Phone died", action: "attendance.correct" });
    expect((await h.call("GET", "/api/audit", { as: mgr })).status).toBe(403);
    // Manager can see the punch's map pin and selfie details.
    const detail = await h.call("GET", `/api/attendance/${id}/2026-11-16`, { as: mgr });
    expect(detail.status).toBe(200);
  });
});
