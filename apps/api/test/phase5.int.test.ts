import { beforeEach, describe, expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { createHarness, gpsAt, ist, seedBasics } from "./harness.js";
import { createStaff } from "./flows.js";
import { buildHandlers } from "../src/cron/jobs.js";

const h = createHarness();

beforeEach(async () => {
  await h.reset();
  h.setNow("2026-11-16 09:00:00");
  await seedBasics(h);
});

async function seedDay(id: string, date: string, inT: string): Promise<void> {
  const pin = { lat: gpsAt(10).lat, lng: gpsAt(10).lng, accuracy: 20, distanceMeters: 10, selfiePath: `selfies/${id}/${date}.jpg` };
  await h.ctx.db.collection("attendance").doc(`${id}_${date}`).set({
    employeeId: id,
    businessId: "BM",
    dateIST: date,
    punchInAt: Timestamp.fromDate(ist(`${date} ${inT}`)),
    punchOutAt: Timestamp.fromDate(ist(`${date} 22:05:00`)),
    punchIn: pin,
    punchOut: pin,
    shift: { start: "09:30", end: "22:00" },
    halfDay: false,
    absentOverride: false,
    corrections: [],
  });
}

describe("admin reports (spec 11.3)", () => {
  it("returns attendance trend, ranking, sales and funnel; staff are refused", async () => {
    const a = await createStaff(h, { name: "A", mobile: "9876500001", joiningDate: "2026-11-01" });
    for (let d = 1; d <= 5; d++) await seedDay(a, `2026-11-0${d}`, d === 3 ? "10:10" : "09:20");
    await h.ctx.db.collection("dailySales").doc(`${a}_2026-11-02`).set({
      employeeId: a,
      businessId: "BM",
      dateIST: "2026-11-02",
      values: { "new-mobiles": 500_000 },
      amountTotalPaise: 500_000,
      noSales: false,
      submittedAt: Timestamp.fromDate(ist("2026-11-02 21:00:00")),
      corrections: [],
    });
    await h.call("POST", "/api/leads", { as: a, body: { name: "Lead", phone: "9123456789", source: "manual" } });
    h.setNow("2026-11-06 00:15:00");
    await buildHandlers(h.ctx)["dayClose"]?.({ slot: "2026-11-06", now: h.now() });

    const res = await h.call("GET", "/api/reports?unit=BM&month=2026-11", { as: "SA001" });
    expect(res.status).toBe(200);
    const day3 = res.body.attendanceTrend.find((t: { date: string }) => t.date === "2026-11-03");
    expect(day3).toMatchObject({ present: 1, late: 1 });
    expect(res.body.ranking[0]).toMatchObject({ employeeId: a, rank: 1 });
    expect(res.body.salesByCategory.BM["new-mobiles"]).toBe(500_000);
    expect(res.body.funnel.new).toBe(1);
    expect(res.body.payrollCost[0].unit).toBe("BM");

    expect((await h.call("GET", "/api/reports", { as: a })).status).toBe(403);
  });
});

describe("portal rule", () => {
  it("Super Admin signs in only via the admin portal; the admin portal rejects staff", async () => {
    const a = await createStaff(h, { name: "S", mobile: "9876500009" });
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9000000001", pin: "7391" } })).status).toBe(403);
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9000000001", pin: "7391", portal: "app" } })).body.code).toBe("ADMIN_PORTAL_ONLY");
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9000000001", pin: "7391", portal: "admin" } })).status).toBe(200);
    expect(a).toBeTruthy();
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500009", pin: "4821", portal: "admin" } })).body.code).toBe("NOT_AN_ADMIN");
    expect((await h.call("POST", "/api/auth/login", { body: { mobile: "9876500009", pin: "4821" } })).status).toBe(200);
  });
});
