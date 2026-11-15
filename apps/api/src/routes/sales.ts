import type { FastifyInstance } from "fastify";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { dateIST, monthKeyIST, salesCorrectionInput, salesEntryInput, type BusinessUnit } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canManage, requireManage } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, forbidden } from "../http.js";
import type { DailySalesDoc } from "../types.js";
import { assertMonthUnlocked } from "../services/lock.js";
import { recalcIfPastMonth } from "../services/payroll.js";
import { amountTotal, salesId } from "../services/sales.js";
import { dateRange, eligibleDates } from "../services/stats.js";
import { getEmployee, listScopedEmployees } from "./employees.js";
import { getUnit } from "./units.js";
import { guard } from "./guard.js";

/** Converts submitted values (whole rupees for amount, count for count) and validates against active categories. */
function toStored(unit: BusinessUnit, input: { values: Record<string, number>; noSales: boolean }): Record<string, number> {
  const active = unit.salesCategories.filter((c) => c.active);
  const out: Record<string, number> = {};
  if (input.noSales) {
    for (const c of active) out[c.id] = 0;
    return out;
  }
  const unknown = Object.keys(input.values).filter((k) => !active.some((c) => c.id === k));
  if (unknown.length) throw badRequest("BAD_CATEGORY", `Unknown sales category: ${unknown.join(", ")}.`);
  const missing = active.filter((c) => input.values[c.id] === undefined);
  if (missing.length) throw badRequest("SALES_INCOMPLETE", `Enter a value for every category (use 0 if none). Missing: ${missing.map((c) => c.name).join(", ")}.`);
  for (const c of active) out[c.id] = c.type === "amount" ? (input.values[c.id] as number) * 100 : (input.values[c.id] as number);
  return out;
}

export function registerSalesRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  app.get("/api/sales/today", pre, async (req) => {
    const today = dateIST(ctx.clock());
    const unit = await getUnit(ctx, req.actor.emp.businessId);
    const snap = await ctx.db.collection("dailySales").doc(salesId(req.actor.id, today)).get();
    return {
      dateIST: today,
      categories: unit.salesCategories.filter((c) => c.active).sort((a, b) => a.order - b.order),
      required: req.actor.emp.requiresSalesEntry && unit.salesCategories.some((c) => c.active),
      entry: snap.exists ? snap.data() : null,
    };
  });

  // Staff submit (or re-submit) today's entry; editable until 23:59 IST because the date is always "today".
  app.post("/api/sales/today", pre, async (req) => {
    const a = req.actor;
    const input = salesEntryInput.parse(req.body);
    const today = dateIST(ctx.clock());
    const unit = await getUnit(ctx, a.emp.businessId);
    if (!unit.salesCategories.some((c) => c.active)) throw badRequest("NO_CATEGORIES", "This business unit has no sales categories.");
    const values = toStored(unit, input);
    const ref = ctx.db.collection("dailySales").doc(salesId(a.id, today));
    const doc = await ctx.db.runTransaction(async (tx) => {
      await assertMonthUnlocked(ctx, a.emp.businessId, today, tx);
      const prev = await tx.get(ref);
      const next: DailySalesDoc = {
        employeeId: a.id,
        businessId: a.emp.businessId,
        dateIST: today,
        values,
        amountTotalPaise: amountTotal(unit, values),
        noSales: input.noSales,
        submittedAt: Timestamp.fromDate(ctx.clock()),
        corrections: prev.exists ? (prev.data() as DailySalesDoc).corrections : [],
      };
      tx.set(ref, next);
      return next;
    });
    return { entry: doc };
  });

  // After 23:59 IST only a Manager/Admin can correct (reason required, audited).
  app.post("/api/sales/correct", pre, async (req) => {
    const a = req.actor;
    const input = salesCorrectionInput.parse(req.body);
    const target = await getEmployee(ctx, input.employeeId);
    requireManage(a, target);
    if (input.dateIST > dateIST(ctx.clock())) throw badRequest("FUTURE_DATE", "You cannot correct a future date.");
    const unit = await getUnit(ctx, target.businessId);
    const values = toStored(unit, { values: input.values, noSales: false });
    const ref = ctx.db.collection("dailySales").doc(salesId(target.employeeId, input.dateIST));
    const next = await ctx.db.runTransaction(async (tx) => {
      await assertMonthUnlocked(ctx, target.businessId, input.dateIST, tx);
      const prev = await tx.get(ref);
      const before = prev.exists ? (prev.data() as DailySalesDoc) : null;
      const doc: DailySalesDoc = {
        employeeId: target.employeeId,
        businessId: target.businessId,
        dateIST: input.dateIST,
        values,
        amountTotalPaise: amountTotal(unit, values),
        noSales: false,
        submittedAt: before?.submittedAt ?? Timestamp.fromDate(ctx.clock()),
        corrections: [...(before?.corrections ?? []), { by: a.id, at: Timestamp.fromDate(ctx.clock()), reason: input.reason, before: before?.values ?? {} }],
      };
      tx.set(ref, doc);
      await audit(ctx, { actorId: a.id, action: "sales.correct", entity: "dailySales", entityId: ref.id, before: before?.values ?? null, after: values, reason: input.reason }, tx);
      return doc;
    });
    await recalcIfPastMonth(ctx, target, input.dateIST, dateIST(ctx.clock()));
    return { entry: next };
  });

  // Entries for one employee for a month, with category totals.
  app.get("/api/sales", pre, async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), employeeId: z.string().optional() }).parse(req.query);
    const target = q.employeeId ? await getEmployee(ctx, q.employeeId) : req.actor.emp;
    if (target.employeeId !== req.actor.id && !canManage(req.actor, target)) throw forbidden("That employee is outside your scope.");
    const month = q.month ?? monthKeyIST(ctx.clock());
    const dates = eligibleDates(target, month, `${month}-31`);
    const snaps = dates.length ? await ctx.db.getAll(...dates.map((d) => ctx.db.collection("dailySales").doc(salesId(target.employeeId, d)))) : [];
    const entries = snaps.filter((s) => s.exists).map((s) => s.data() as DailySalesDoc);
    const totals: Record<string, number> = {};
    for (const e of entries) for (const [k, v] of Object.entries(e.values)) totals[k] = (totals[k] ?? 0) + v;
    return {
      month,
      entries: entries.map((e) => ({ dateIST: e.dateIST, values: e.values, amountTotalPaise: e.amountTotalPaise, noSales: e.noSales })),
      totalsByCategory: totals,
      amountTotalPaise: entries.reduce((s, e) => s + e.amountTotalPaise, 0),
    };
  });

  // Team sales by category (today / month) for Managers and above.
  app.get("/api/sales/team", pre, async (req) => {
    const q = z.object({ unit: z.string().optional(), month: z.string().regex(/^\d{4}-\d{2}$/).optional(), date: z.string().optional() }).parse(req.query);
    const team = (await listScopedEmployees(ctx, req.actor, q.unit)).filter((e) => e.employeeId !== req.actor.id);
    const month = q.month ?? monthKeyIST(ctx.clock());
    const dates = q.date ? [q.date] : dateRange(`${month}-01`, `${month}-31`).filter((d) => d.startsWith(month));
    const byUnit: Record<string, Record<string, number>> = {};
    const byEmployee: Record<string, number> = {};
    for (const e of team) {
      const snaps = await ctx.db.getAll(...dates.map((d) => ctx.db.collection("dailySales").doc(salesId(e.employeeId, d))));
      for (const s of snaps) {
        if (!s.exists) continue;
        const doc = s.data() as DailySalesDoc;
        byEmployee[e.employeeId] = (byEmployee[e.employeeId] ?? 0) + doc.amountTotalPaise;
        const u = (byUnit[e.businessId] ??= {});
        for (const [k, v] of Object.entries(doc.values)) u[k] = (u[k] ?? 0) + v;
      }
    }
    return { month, date: q.date ?? null, byUnit, byEmployee };
  });
}
