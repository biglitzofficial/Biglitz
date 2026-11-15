import { beforeAll, describe, expect, it } from "vitest";
import { addRawEmployee, createHarness, gpsAt, seedBasics } from "./harness.js";
import { punch } from "./flows.js";

/**
 * Phase 5 load test: 50 users act at the same moment (morning punch-in rush, home screens,
 * sales entry, lead intake). Everything must succeed, with no duplicates, within a generous budget.
 */
const h = createHarness();
const N = 50;
const ids = Array.from({ length: N }, (_, i) => `LT${String(i + 1).padStart(3, "0")}`);
const mobiles = ids.map((_, i) => `98000${String(10000 + i)}`);

async function timed<T>(label: string, fn: () => Promise<T[]>): Promise<{ results: T[]; ms: number }> {
  const t0 = Date.now();
  const results = await fn();
  const ms = Date.now() - t0;
  console.log(`[load] ${label}: ${results.length} requests in ${ms} ms`);
  return { results, ms };
}

beforeAll(async () => {
  await h.reset();
  h.setNow("2026-11-16 09:25:00");
  await seedBasics(h);
  await Promise.all(ids.map((id, i) => addRawEmployee(h, { employeeId: id, name: `Load ${i + 1}`, mobile: mobiles[i] ?? "", joiningDate: "2026-11-01" })));
}, 120_000);

describe("50 concurrent users", () => {
  it("logs in, punches in, loads Home and submits sales without errors", async () => {
    const login = await timed("login", () => Promise.all(mobiles.map((m) => h.call("POST", "/api/auth/login", { body: { mobile: m, pin: "4821" } }))));
    expect(login.results.every((r) => r.status === 200)).toBe(true);

    const punches = await timed("punch-in", () => Promise.all(ids.map((id) => punch(h, id, "in", gpsAt(20)))));
    expect(punches.results.map((r) => r.status)).toEqual(Array(N).fill(200));
    const docs = await h.ctx.db.collection("attendance").where("dateIST", "==", "2026-11-16").get();
    expect(docs.size).toBe(N);

    const homes = await timed("home", () => Promise.all(ids.map((id) => h.call("GET", "/api/me/home", { as: id }))));
    expect(homes.results.every((r) => r.status === 200 && r.body.attendance.punchedIn === true)).toBe(true);

    const cats = (await h.call("GET", "/api/sales/today", { as: ids[0] })).body.categories as Array<{ id: string }>;
    const values = Object.fromEntries(cats.map((c) => [c.id, 1]));
    const sales = await timed("sales", () => Promise.all(ids.map((id) => h.call("POST", "/api/sales/today", { as: id, body: { values, noSales: false } }))));
    expect(sales.results.every((r) => r.status === 200)).toBe(true);

    for (const t of [login, punches, homes, sales]) expect(t.ms).toBeLessThan(60_000);
  }, 180_000);

  it("round-robins 100 simultaneous intake leads evenly with no duplicates", async () => {
    await h.call("POST", "/api/lead-pools", { as: "SA001", body: { businessId: "BM", source: "all", staffOrder: ids, skipAbsent: true } });
    const reqs = Array.from({ length: 100 }, (_, i) =>
      h.call("POST", "/api/leads/intake", {
        headers: { "x-intake-secret": "s3cret" },
        body: { name: `Lead ${i}`, phone: `9${String(100000000 + i)}`, source: "ads", businessCode: "BM" },
      }),
    );
    const { results } = await timed("lead intake", () => Promise.all(reqs));
    const bad = results.filter((r) => r.status !== 200 || r.body.deduplicated !== false);
    expect(bad.map((r) => `${r.status} ${r.raw.slice(0, 120)}`).slice(0, 3)).toEqual([]);
    const leads = (await h.ctx.db.collection("leads").get()).docs.map((d) => d.data() as { assigneeId: string });
    expect(leads).toHaveLength(100);
    const per = new Map<string, number>();
    for (const l of leads) per.set(l.assigneeId, (per.get(l.assigneeId) ?? 0) + 1);
    // 100 leads over 50 people: everyone gets exactly 2 (pointer moves transactionally).
    expect([...per.values()].every((c) => c === 2)).toBe(true);
    expect(per.size).toBe(N);
  }, 180_000);
});
