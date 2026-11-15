import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, gpsAt, ist, seedBasics } from "./harness.js";
import { createStaff, punch, submitNoSales } from "./flows.js";

const h = createHarness();

beforeEach(async () => {
  await h.reset();
  h.setNow("2026-11-16 09:00:00");
  await seedBasics(h);
});

const intake = (body: Record<string, unknown>, secret: string | null = "s3cret") =>
  h.call("POST", "/api/leads/intake", { body, headers: secret ? { "x-intake-secret": secret } : {} });

describe("round-robin and dedup (acceptance 12)", () => {
  it("A -> B -> C with B on leave gives A, C, A, C; same phone again adds history and alerts the assignee", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const [a, b, c] = [
      await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr }),
      await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr }),
      await createStaff(h, { name: "C", mobile: "9876500003", managerId: mgr }),
    ] as [string, string, string];
    // A and C are punched in; B has approved leave today.
    h.setNow("2026-11-12 09:00:00");
    const apply = await h.call("POST", "/api/leave/apply", { as: b, body: { dates: ["2026-11-16"], type: "full", reason: "Family function" } });
    expect(apply.status).toBe(200);
    const id = apply.body.requests[0].id as string;
    expect((await h.call("POST", `/api/leave/${id}/decision`, { as: mgr, body: { decision: "approved" } })).status).toBe(200);
    h.setNow("2026-11-16 09:00:00");
    await punch(h, a, "in", gpsAt(10));
    await punch(h, c, "in", gpsAt(10));

    const pool = await h.call("POST", "/api/lead-pools", { as: mgr, body: { businessId: "BM", source: "all", staffOrder: [a, b, c], skipAbsent: true } });
    expect(pool.status).toBe(200);

    const assigned: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await intake({ name: `Lead${i}`, phone: `98000000${10 + i}`, source: "ads", businessCode: "BM" });
      expect(r.status).toBe(200);
      assigned.push(r.body.assigneeId);
    }
    expect(assigned).toEqual([a, c, a, c]);
    expect(h.notifier.events.filter((e) => e.template === "lead_assigned").map((e) => e.toEmployeeId)).toEqual([a, c, a, c]);

    // Same phone again: no new lead, a history note, assignee alerted.
    const again = await intake({ name: "Lead0 again", phone: "+91 98000 00010", source: "whatsapp", businessCode: "BM" });
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.assigneeId).toBe(a);
    const leads = await h.ctx.db.collection("leads").get();
    expect(leads.size).toBe(4);
    const detail = await h.call("GET", `/api/leads/${again.body.leadId}`, { as: a });
    expect(detail.body.history.map((x: { note: string }) => x.note)).toContain("Enquired again via whatsapp");
    expect(h.notifier.events.some((e) => e.template === "lead_enquired_again" && e.toEmployeeId === a)).toBe(true);
  });

  it("a Lost lead is reset to Follow-up when the customer enquires again", async () => {
    const staff = await createStaff(h, { name: "A", mobile: "9876500001" });
    const created = await h.call("POST", "/api/leads", { as: staff, body: { name: "Ravi", phone: "9800000099", notes: "wants phone" } });
    const id = created.body.leadId as string;
    const lost = await h.call("PATCH", `/api/leads/${id}`, { as: staff, body: { status: "lost", lostReason: "Price too high" } });
    expect(lost.status).toBe(200);
    const r = await intake({ name: "Ravi", phone: "9800000099", source: "ads", businessCode: "BM" });
    expect(r.body.deduplicated).toBe(true);
    const lead = await h.call("GET", `/api/leads/${id}`, { as: staff });
    expect(lead.body.lead.status).toBe("followUp");
    expect(lead.body.lead.nextFollowUpDate).toBe("2026-11-16");
  });

  it("concurrent intake of the same phone creates only one lead; externalId is idempotent", async () => {
    const staff = await createStaff(h, { name: "A", mobile: "9876500001" });
    await h.call("POST", "/api/lead-pools", { as: "SA001", body: { businessId: "BM", source: "all", staffOrder: [staff], skipAbsent: false } });
    const rs = await Promise.all([1, 2, 3].map(() => intake({ name: "Dup", phone: "9811111111", source: "ads", businessCode: "BM" })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await h.ctx.db.collection("leads").get()).size).toBe(1);
    const e1 = await intake({ name: "X", phone: "9822222222", source: "ads", businessCode: "BM", externalId: "wa-1" });
    const e2 = await intake({ name: "X", phone: "9822222222", source: "ads", businessCode: "BM", externalId: "wa-1" });
    expect(e2.body.leadId).toBe(e1.body.leadId);
    expect((await h.ctx.db.collection("leads").get()).size).toBe(2);
  });

  it("intake needs the secret; nobody eligible falls back to normal order and alerts the manager", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    expect((await intake({ name: "N", phone: "9833333333", source: "ads", businessCode: "BM" }, null)).status).toBe(401);
    expect((await intake({ name: "N", phone: "9833333333", source: "ads", businessCode: "BM" }, "wrong")).status).toBe(401);
    await h.call("POST", "/api/lead-pools", { as: mgr, body: { businessId: "BM", source: "all", staffOrder: [a], skipAbsent: true } });
    const r = await intake({ name: "N", phone: "9833333333", source: "ads", businessCode: "BM" });
    expect(r.body.assigneeId).toBe(a); // nobody punched in -> normal order
    expect(r.body.noneEligible).toBe(true);
    expect(h.notifier.events.some((e) => e.template === "lead_nobody_available" && e.toEmployeeId === mgr)).toBe(true);
    expect((await intake({ name: "N", phone: "12345", source: "ads", businessCode: "BM" })).body.code).toBe("BAD_PHONE");
  });
});

describe("lead status flow and dashboard (spec 10)", () => {
  it("enforces required fields and counts follow-ups", async () => {
    const s = await createStaff(h, { name: "A", mobile: "9876500001" });
    const mk = async (n: number) => (await h.call("POST", "/api/leads", { as: s, body: { name: `L${n}`, phone: `97000000${10 + n}` } })).body.leadId as string;
    const [l1, l2, l3, l4] = [await mk(1), await mk(2), await mk(3), await mk(4)] as [string, string, string, string];
    const patch = (id: string, body: object) => h.call("PATCH", `/api/leads/${id}`, { as: s, body });
    expect((await patch(l1, { status: "followUp", nextFollowUpDate: "2026-11-20" })).body.code).toBe("TEMPERATURE_REQUIRED");
    expect((await patch(l1, { status: "followUp", temperature: "hot" })).body.code).toBe("FOLLOWUP_DATE_REQUIRED");
    expect((await patch(l1, { status: "followUp", temperature: "hot", nextFollowUpDate: "2026-11-16" })).status).toBe(200); // today
    expect((await patch(l2, { status: "followUp", temperature: "warm", nextFollowUpDate: "2026-11-10" })).status).toBe(200); // overdue
    expect((await patch(l3, { status: "closedWon" })).body.code).toBe("VALUE_REQUIRED");
    expect((await patch(l3, { status: "closedWon", closedValueRupees: 12000 })).status).toBe(200);
    expect((await patch(l4, { status: "lost" })).body.code).toBe("REASON_REQUIRED");
    expect((await patch(l4, { status: "lost", lostReason: "Other" })).body.code).toBe("NOTE_REQUIRED");
    expect((await patch(l4, { status: "lost", lostReason: "Other", note: "moved city" })).status).toBe(200);
    const dash = (await h.call("GET", "/api/leads/dashboard", { as: s })).body.counts;
    expect(dash).toMatchObject({ todayFollowUps: 1, overdue: 1, total: 4, closedWon: 1, lost: 1, open: 2, closedValueThisMonthPaise: 1_200_000 });
    const today = (await h.call("GET", "/api/leads?view=today", { as: s })).body.leads;
    expect(today.map((l: { id: string }) => l.id)).toEqual([l1]);
    const overdue = (await h.call("GET", "/api/leads?view=overdue", { as: s })).body.leads;
    expect(overdue.map((l: { id: string }) => l.id)).toEqual([l2]);
  });

  it("staff cannot see another person's leads; exit requires reassigning open leads", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr });
    const lead = (await h.call("POST", "/api/leads", { as: a, body: { name: "L", phone: "9700000011" } })).body.leadId as string;
    expect((await h.call("GET", `/api/leads/${lead}`, { as: b })).status).toBe(403);
    expect((await h.call("GET", `/api/leads/${lead}`, { as: mgr })).status).toBe(200);
    await h.call("POST", "/api/lead-pools", { as: mgr, body: { businessId: "BM", source: "all", staffOrder: [a, b], skipAbsent: false } });
    const exit = await h.call("POST", `/api/employees/${a}/exit`, { as: "SA001", body: { exitDate: "2026-11-16", reason: "Resigned" } });
    expect(exit.body.code).toBe("REASSIGN_REQUIRED");
    const ok = await h.call("POST", `/api/employees/${a}/exit`, { as: "SA001", body: { exitDate: "2026-11-16", reason: "Resigned", leadReassignTo: b } });
    expect(ok.status).toBe(200);
    expect((await h.call("GET", `/api/leads/${lead}`, { as: b })).body.lead.assigneeId).toBe(b);
    const pools = await h.call("GET", "/api/lead-pools", { as: mgr });
    expect(pools.body.pools[0].staffOrder).toEqual([b]);
    // Exited staff cannot be given new tasks.
    h.setNow("2026-11-17 09:00:00");
    expect((await h.call("POST", "/api/tasks", { as: mgr, body: { title: "x", assigneeId: a } })).status).toBe(400);
  });
});

describe("tasks (spec 9)", () => {
  it("staff create self tasks only; managers assign within team; alerts; done/reopen; overdue; summary", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const b = await createStaff(h, { name: "B", mobile: "9876500002" });
    expect((await h.call("POST", "/api/tasks", { as: a, body: { title: "x", assigneeId: b } })).status).toBe(403);
    const self = await h.call("POST", "/api/tasks", { as: a, body: { title: "Self task" } });
    expect(self.status).toBe(200);
    expect((await h.call("POST", "/api/tasks", { as: mgr, body: { title: "x", assigneeId: b } })).status).toBe(403);
    const t = await h.call("POST", "/api/tasks", { as: mgr, body: { title: "Count stock", assigneeId: a, dueAt: ist("2026-11-16 08:00:00").toISOString(), priority: "high" } });
    expect(t.status).toBe(200);
    expect(h.notifier.events.filter((e) => e.template === "task_assigned").map((e) => e.toEmployeeId)).toEqual([a]);
    const overdue = await h.call("GET", "/api/tasks?tab=overdue", { as: a });
    expect(overdue.body.tasks.map((x: { title: string }) => x.title)).toEqual(["Count stock"]);
    expect((await h.call("POST", `/api/tasks/${t.body.task.id}/done`, { as: a })).status).toBe(200);
    expect((await h.call("POST", `/api/tasks/${t.body.task.id}/reopen`, { as: a })).status).toBe(403);
    expect((await h.call("GET", "/api/tasks?tab=done", { as: a })).body.tasks).toHaveLength(1);
    expect((await h.call("POST", `/api/tasks/${t.body.task.id}/reopen`, { as: mgr })).status).toBe(200);
    const sum = (await h.call("GET", "/api/tasks?tab=today", { as: a })).body.summary;
    expect(sum).toMatchObject({ todayTotal: 2, todayDone: 0, pending: 2, overdue: 1 });
    expect((await h.call("GET", `/api/tasks?employeeId=${a}`, { as: b })).status).toBe(403);
  });

  it("'No task right now' lists punched-in staff with zero open tasks", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr });
    await punch(h, a, "in", gpsAt(10));
    await punch(h, b, "in", gpsAt(10));
    await h.call("POST", "/api/tasks", { as: mgr, body: { title: "Work", assigneeId: b } });
    const team = await h.call("GET", "/api/tasks/team", { as: mgr });
    expect(team.body.noTaskNow).toEqual([{ employeeId: a, name: "A" }]);
  });

  it("recurring tasks: daily/weekly/monthly/month-end occurrences are created once by the cron", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    h.setNow("2026-11-15 12:00:00"); // a Sunday
    const mk = (title: string, repeat: object, dueAt?: string) => h.call("POST", "/api/tasks", { as: mgr, body: { title, assigneeId: a, repeat, ...(dueAt ? { dueAt } : {}) } });
    await mk("Morning report", { kind: "daily" }, ist("2026-11-15 09:30:00").toISOString());
    await mk("Stock audit", { kind: "weekly", weekday: 5 });
    await mk("Rent", { kind: "monthly", day: 30 });
    await mk("Closing", { kind: "monthEnd" });
    const { buildHandlers } = await import("../src/cron/jobs.js");
    const handlers = buildHandlers(h.ctx);
    const titlesOn = async (date: string) => {
      const snaps = await h.ctx.db.collection("tasks").where("occurrenceDate", "==", date).get();
      return snaps.docs.map((d) => (d.data() as { title: string }).title).sort();
    };
    expect(await titlesOn("2026-11-15")).toEqual(["Morning report"]); // created when template saved (daily)
    h.setNow("2026-11-20 00:05:00"); // Friday
    await handlers["recurringTasks"]?.({ slot: "2026-11-20", now: h.now() });
    await handlers["recurringTasks"]?.({ slot: "2026-11-20", now: h.now() }); // run twice
    expect(await titlesOn("2026-11-20")).toEqual(["Morning report", "Stock audit"]);
    h.setNow("2026-11-30 00:05:00");
    await handlers["recurringTasks"]?.({ slot: "2026-11-30", now: h.now() });
    expect(await titlesOn("2026-11-30")).toEqual(["Closing", "Morning report", "Rent"]);
    // The morning report occurrence keeps its 09:30 IST due time.
    const occ = await h.ctx.db.collection("tasks").where("occurrenceDate", "==", "2026-11-30").get();
    const morning = occ.docs.map((d) => d.data()).find((d) => d["title"] === "Morning report");
    expect((morning?.["dueAt"] as { toDate(): Date }).toDate().toISOString()).toBe(ist("2026-11-30 09:30:00").toISOString());
  });
});

describe("dashboards", () => {
  it("Team Today shows who is in, late, absent, on leave, and sales not reported", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const onTime = await createStaff(h, { name: "OnTime", mobile: "9876500001", managerId: mgr });
    const late = await createStaff(h, { name: "Late", mobile: "9876500002", managerId: mgr });
    const absent = await createStaff(h, { name: "Absent", mobile: "9876500003", managerId: mgr });
    h.setNow("2026-11-16 09:25:00");
    await punch(h, onTime, "in", gpsAt(10));
    h.setNow("2026-11-16 09:45:00");
    await punch(h, late, "in", gpsAt(10));
    await submitNoSales(h, onTime);
    const r = await h.call("GET", "/api/dashboard/today", { as: mgr });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ total: 3, present: 2, late: 1, absent: 1, salesNotReported: 2 });
    const byId = Object.fromEntries(r.body.team.map((t: { employeeId: string }) => [t.employeeId, t]));
    expect(byId[absent].state).toBe("absent");
    expect((await h.call("GET", "/api/dashboard/today", { as: onTime })).status).toBe(403);
    const overview = await h.call("GET", "/api/dashboard/overview", { as: "SA001" });
    expect(overview.body.units.find((u: { unit: string }) => u.unit === "BM")).toMatchObject({ present: 2, late: 1 });
    expect((await h.call("GET", "/api/dashboard/overview", { as: mgr })).status).toBe(403);
  });

  it("late alerts message the manager once per employee per day", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr });
    const { buildHandlers } = await import("../src/cron/jobs.js");
    const handlers = buildHandlers(h.ctx);
    h.setNow("2026-11-16 09:40:00"); // before shift start + 15 (09:45)
    await handlers["lateAlerts"]?.({ slot: "x", now: h.now() });
    expect(h.notifier.events).toHaveLength(0);
    h.setNow("2026-11-16 09:50:00");
    await handlers["lateAlerts"]?.({ slot: "x", now: h.now() });
    await handlers["lateAlerts"]?.({ slot: "y", now: h.now() });
    expect(h.notifier.events.filter((e) => e.template === "late_punch_in" && e.toEmployeeId === mgr)).toHaveLength(1);
    await punch(h, a, "in", gpsAt(10));
  });
});

describe("leave (acceptance 7)", () => {
  it("applied the 10th for the 12th and approved = approved leave; applied the 11th = late application, counts absent", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr, joiningDate: "2026-11-01" });
    const b = await createStaff(h, { name: "B", mobile: "9876500002", managerId: mgr, joiningDate: "2026-11-01" });
    h.setNow("2026-11-10 09:00:00");
    const ok = await h.call("POST", "/api/leave/apply", { as: a, body: { dates: ["2026-11-12"], type: "full", reason: "Trip" } });
    expect(ok.body.requests[0].lateApplication).toBe(false);
    h.setNow("2026-11-11 09:00:00");
    const dup = await h.call("POST", "/api/leave/apply", { as: a, body: { dates: ["2026-11-12"], type: "full", reason: "Again" } });
    expect(dup.body.code).toBe("LEAVE_EXISTS"); // already requested for the 12th
    const late2 = await h.call("POST", "/api/leave/apply", { as: b, body: { dates: ["2026-11-12"], type: "full", reason: "Late one" } });
    expect(late2.body.requests[0].lateApplication).toBe(true);
    const pending = await h.call("GET", "/api/leave/pending", { as: mgr });
    expect(pending.body.requests).toHaveLength(2);
    expect((await h.call("GET", "/api/leave/pending", { as: a })).body.requests).toHaveLength(0);
    for (const r of pending.body.requests as Array<{ id: string }>) expect((await h.call("POST", `/api/leave/${r.id}/decision`, { as: mgr, body: { decision: "approved" } })).status).toBe(200);
    h.setNow("2026-11-14 08:00:00");
    const cal = (await h.call("GET", "/api/attendance/calendar?month=2026-11", { as: a })).body.days;
    expect(cal.find((x: { date: string }) => x.date === "2026-11-12")).toMatchObject({ status: "approvedLeave", lateApplication: false });
    const calB = (await h.call("GET", "/api/attendance/calendar?month=2026-11", { as: b })).body.days;
    expect(calB.find((x: { date: string }) => x.date === "2026-11-12")).toMatchObject({ status: "approvedLeave", lateApplication: true });
    // Discipline: the on-time approved day is removed from working days; the late-application day counts as absent.
    const { computeScores } = await import("../src/services/scores.js");
    await computeScores(h.ctx, "2026-11-13", "2026-11-14");
    const scoreA = (await h.ctx.db.collection("scores").doc(`${a}_2026-11`).get()).data();
    const scoreB = (await h.ctx.db.collection("scores").doc(`${b}_2026-11`).get()).data();
    expect(scoreA?.["workingDays"]).toBe(12); // 13 eligible days - 1 approved leave
    expect(scoreB?.["workingDays"]).toBe(13); // late application is NOT removed
    // Cannot decide your own leave / outside scope.
    const mine = await h.call("GET", "/api/leave/mine", { as: a });
    expect(mine.body.requests).toHaveLength(1);
    expect((await h.call("POST", `/api/leave/${pending.body.requests[0].id}/decision`, { as: a, body: { decision: "approved" } })).status).toBe(403);
    expect((await h.call("POST", "/api/leave/apply", { as: a, body: { dates: ["2026-11-01"], type: "full", reason: "past" } })).body.code).toBe("PAST_DATE");
  });

  it("half-day approved leave counts 0.5 present and is never on time", async () => {
    const mgr = await createStaff(h, { name: "Mgr", mobile: "9876500009", roles: ["manager"] });
    const a = await createStaff(h, { name: "A", mobile: "9876500001", managerId: mgr, joiningDate: "2026-11-01" });
    h.setNow("2026-11-05 09:00:00");
    const r = await h.call("POST", "/api/leave/apply", { as: a, body: { dates: ["2026-11-10"], type: "half", reason: "Dentist" } });
    await h.call("POST", `/api/leave/${r.body.requests[0].id}/decision`, { as: mgr, body: { decision: "approved" } });
    h.setNow("2026-11-11 08:00:00");
    const day = (await h.call("GET", "/api/attendance/calendar?month=2026-11", { as: a })).body.days.find((d: { date: string }) => d.date === "2026-11-10");
    expect(day).toMatchObject({ status: "halfDay", present: 0.5 });
  });
});
