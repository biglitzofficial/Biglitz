import type { FastifyInstance } from "fastify";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { adjustmentInput, advanceInput, dateIST, payrollMonthParams, penaltyInput, previousMonthKey, rupeesToPaise } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canApprovePayroll, isAdminOf, requireAdminOf } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, forbidden, notFound } from "../http.js";
import {
  addAdjustment,
  approvePart,
  createDraft,
  linesCol,
  markPaid,
  maybeGeneratePayslips,
  recalcAll,
  recalcLine,
  reopenPart,
  runRef,
  submitPart,
  transferCsv,
  type Part,
  type PayrollLine,
  type PayrollRun,
} from "../services/payroll.js";
import { getEmployee } from "./employees.js";
import { guard } from "./guard.js";

const partSchema = z.object({ part: z.enum(["salary", "incentive"]) });

export function registerPayrollRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };
  const today = () => dateIST(ctx.clock());

  // ---- Advances ----
  app.post("/api/advances", pre, async (req) => {
    const input = advanceInput.parse(req.body);
    const target = await getEmployee(ctx, input.employeeId);
    requireAdminOf(req.actor, target.businessId);
    const doc = { employeeId: target.employeeId, businessId: target.businessId, amountPaise: rupeesToPaise(input.amountRupees), recoveredPaise: 0, date: input.date, note: input.note, createdBy: req.actor.id, createdAt: Timestamp.fromDate(ctx.clock()) };
    const ref = await ctx.db.collection("advances").add(doc);
    await audit(ctx, { actorId: req.actor.id, action: "advance.create", entity: "advances", entityId: ref.id, before: null, after: doc });
    // If last month's payroll is still a draft, it picks up the new advance.
    const prev = previousMonthKey(today().slice(0, 7));
    await recalcLine(ctx, target.businessId, prev, target.employeeId, today());
    return { id: ref.id, advance: doc };
  });

  app.get("/api/advances", pre, async (req) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.query);
    const target = await getEmployee(ctx, employeeId);
    requireAdminOf(req.actor, target.businessId);
    const snaps = await ctx.db.collection("advances").where("employeeId", "==", employeeId).get();
    return { advances: snaps.docs.map((d) => ({ id: d.id, ...d.data() })) };
  });

  // ---- Penalties (Admin of the unit / Super Admin): deducted on next salary draft ----
  app.post("/api/penalties", pre, async (req) => {
    const input = penaltyInput.parse(req.body);
    const target = await getEmployee(ctx, input.employeeId);
    requireAdminOf(req.actor, target.businessId);
    const doc = {
      employeeId: target.employeeId,
      businessId: target.businessId,
      amountPaise: rupeesToPaise(input.amountRupees),
      recoveredPaise: 0,
      date: input.date,
      reason: input.reason,
      createdBy: req.actor.id,
      createdAt: Timestamp.fromDate(ctx.clock()),
    };
    const ref = await ctx.db.collection("penalties").add(doc);
    await audit(ctx, { actorId: req.actor.id, action: "penalty.create", entity: "penalties", entityId: ref.id, before: null, after: doc, reason: input.reason });
    const prev = previousMonthKey(today().slice(0, 7));
    await recalcLine(ctx, target.businessId, prev, target.employeeId, today());
    return { id: ref.id, penalty: doc };
  });

  app.get("/api/penalties", pre, async (req) => {
    const { employeeId } = z.object({ employeeId: z.string() }).parse(req.query);
    const target = await getEmployee(ctx, employeeId);
    requireAdminOf(req.actor, target.businessId);
    const snaps = await ctx.db.collection("penalties").where("employeeId", "==", employeeId).get();
    return { penalties: snaps.docs.map((d) => ({ id: d.id, ...d.data() })) };
  });

  // ---- Payroll runs (Admin of the unit) ----
  const adminOfUnit = (req: { actor: Parameters<typeof isAdminOf>[0] }, unit: string) => {
    if (!isAdminOf(req.actor, unit)) throw forbidden("Only an Admin of this business unit can do that.");
  };

  app.get("/api/payroll/:unit/:month", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    adminOfUnit(req, unit);
    const run = await runRef(ctx, unit, month).get();
    if (!run.exists) throw notFound("Payroll run");
    const lines = (await linesCol(ctx, unit, month).get()).docs.map((d) => d.data() as PayrollLine);
    return { run: run.data() as PayrollRun, lines: lines.sort((a, b) => a.employeeId.localeCompare(b.employeeId)), canApprove: canApprovePayroll(req.actor, unit) };
  });

  // Manual trigger (the cron normally does this on the 1st).
  app.post("/api/payroll/:unit/:month/draft", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    adminOfUnit(req, unit);
    if (month >= today().slice(0, 7)) throw badRequest("MONTH_NOT_OVER", "Payroll can only be drafted after the month is over.");
    return createDraft(ctx, unit, month, today());
  });

  app.post("/api/payroll/:unit/:month/recalc", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    adminOfUnit(req, unit);
    await recalcAll(ctx, unit, month, today());
    return { ok: true };
  });

  app.post("/api/payroll/:unit/:month/adjustments", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    adminOfUnit(req, unit);
    const input = adjustmentInput.parse(req.body);
    const target = await getEmployee(ctx, input.employeeId);
    if (target.businessId !== unit) throw badRequest("WRONG_UNIT", "That employee is not in this unit.");
    await addAdjustment(ctx, unit, month, input.employeeId, { kind: "adjustment", amountPaise: rupeesToPaise(input.amountRupees), reason: input.reason, by: req.actor.id, at: Timestamp.fromDate(ctx.clock()) }, today());
    await audit(ctx, { actorId: req.actor.id, action: "payroll.adjustment", entity: "payrollRuns", entityId: `${unit}_${month}/${input.employeeId}`, before: null, after: { amountRupees: input.amountRupees }, reason: input.reason });
    return { ok: true };
  });

  app.post("/api/payroll/:unit/:month/submit", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    const { part } = partSchema.parse(req.body);
    adminOfUnit(req, unit);
    await submitPart(ctx, unit, month, part, req.actor.id);
    await audit(ctx, { actorId: req.actor.id, action: `payroll.submit.${part}`, entity: "payrollRuns", entityId: `${unit}_${month}`, before: null, after: { part } });
    return { ok: true };
  });

  app.post("/api/payroll/:unit/:month/reopen", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    const { part } = partSchema.parse(req.body);
    if (!canApprovePayroll(req.actor, unit)) throw forbidden("You are not allowed to approve payroll for this unit.");
    await reopenPart(ctx, unit, month, part);
    await audit(ctx, { actorId: req.actor.id, action: `payroll.reopen.${part}`, entity: "payrollRuns", entityId: `${unit}_${month}`, before: null, after: { part } });
    return { ok: true };
  });

  // Super Admin, or Admin with canApprovePayroll for the unit.
  app.post("/api/payroll/:unit/:month/approve", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    const { part } = partSchema.parse(req.body);
    if (!canApprovePayroll(req.actor, unit)) throw forbidden("You are not allowed to approve payroll for this unit.");
    await approvePart(ctx, unit, month, part as Part, req.actor.id);
    await audit(ctx, { actorId: req.actor.id, action: `payroll.approve.${part}`, entity: "payrollRuns", entityId: `${unit}_${month}`, before: null, after: { part, locked: true } });
    const payslips = await maybeGeneratePayslips(ctx, unit, month);
    return { ok: true, payslipsGenerated: payslips };
  });

  app.post("/api/payroll/:unit/:month/paid", pre, async (req) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    const { part } = partSchema.parse(req.body);
    adminOfUnit(req, unit);
    await markPaid(ctx, unit, month, part);
    await audit(ctx, { actorId: req.actor.id, action: `payroll.paid.${part}`, entity: "payrollRuns", entityId: `${unit}_${month}`, before: null, after: { part } });
    return { ok: true };
  });

  app.get("/api/payroll/:unit/:month/transfer.csv", pre, async (req, reply) => {
    const { unit, month } = payrollMonthParams.parse(req.params);
    const { part } = partSchema.parse(req.query);
    adminOfUnit(req, unit);
    const csv = await transferCsv(ctx, unit, month, part);
    return reply.header("Content-Type", "text/csv").header("Content-Disposition", `attachment; filename="${unit}_${month}_${part}.csv"`).send(csv);
  });

  // ---- Payslips (staff: own only) ----
  app.get("/api/payslips", pre, async (req) => {
    const snaps = await ctx.db.collection("payslips").where("employeeId", "==", req.actor.id).get();
    const list = snaps.docs.map((d) => d.data() as { month: string; netSalaryPaise: number; incentivePaise: number }).sort((a, b) => (a.month < b.month ? 1 : -1));
    return { payslips: list.map((p) => ({ month: p.month, netSalaryPaise: p.netSalaryPaise, incentivePaise: p.incentivePaise })) };
  });

  app.get("/api/payslips/:month/url", pre, async (req) => {
    const { month } = req.params as { month: string };
    const snap = await ctx.db.collection("payslips").doc(`${req.actor.id}_${month}`).get();
    if (!snap.exists) throw notFound("Payslip");
    return { url: await ctx.files.downloadUrl((snap.data() as { path: string }).path) };
  });
}
