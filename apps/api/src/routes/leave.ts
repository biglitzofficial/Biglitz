import type { FastifyInstance } from "fastify";
import { Timestamp } from "firebase-admin/firestore";
import { dateIST, isLateApplication, leaveApplyInput, leaveDecisionInput } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canManage } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import type { LeaveDoc } from "../types.js";
import { assertMonthUnlocked } from "../services/lock.js";
import { recalcIfPastMonth } from "../services/payroll.js";
import { attendanceId } from "../services/stats.js";
import { getEmployee, listScopedEmployees } from "./employees.js";
import { guard } from "./guard.js";

export function registerLeaveRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  // Preview of the 2-day rule, shown while applying.
  app.post("/api/leave/preview", pre, async (req) => {
    const { dates } = leaveApplyInput.pick({ dates: true }).parse(req.body);
    const today = dateIST(ctx.clock());
    return { today, days: dates.map((d) => ({ date: d, lateApplication: isLateApplication(today, d) })) };
  });

  app.post("/api/leave/apply", pre, async (req) => {
    const a = req.actor;
    const input = leaveApplyInput.parse(req.body);
    const today = dateIST(ctx.clock());
    const dates = [...new Set(input.dates)].sort();
    for (const d of dates) {
      if (d < today) throw badRequest("PAST_DATE", `${d} is in the past. Ask your Manager to correct attendance instead.`);
      if (d < a.emp.joiningDate) throw badRequest("BEFORE_JOINING", `${d} is before your joining date.`);
      if (a.emp.exitDate && d > a.emp.exitDate) throw badRequest("AFTER_EXIT", `${d} is after your exit date.`);
    }
    const created: Array<{ id: string; dateIST: string; lateApplication: boolean }> = [];
    for (const d of dates) {
      const ref = ctx.db.collection("leaveRequests").doc(attendanceId(a.id, d));
      await ctx.db.runTransaction(async (tx) => {
        await assertMonthUnlocked(ctx, a.emp.businessId, d, tx);
        const snap = await tx.get(ref);
        if (snap.exists && (snap.data() as LeaveDoc).status !== "rejected") {
          throw conflict("LEAVE_EXISTS", `You already have a leave request for ${d}.`);
        }
        const doc: LeaveDoc = {
          employeeId: a.id,
          businessId: a.emp.businessId,
          managerId: a.emp.managerId,
          dateIST: d,
          type: input.type,
          reason: input.reason,
          appliedDateIST: today,
          appliedAt: Timestamp.fromDate(ctx.clock()),
          lateApplication: isLateApplication(today, d),
          status: "pending",
          decidedBy: null,
          decidedAt: null,
          decisionNote: "",
        };
        tx.set(ref, doc);
        created.push({ id: ref.id, dateIST: d, lateApplication: doc.lateApplication });
      });
    }
    if (a.emp.managerId) {
      await ctx.notifier.send({ template: "leave_applied", toEmployeeId: a.emp.managerId, params: { name: a.emp.name, dates: dates.join(", ") } });
    }
    return { requests: created };
  });

  // Staff see their own list (including their own reasons).
  app.get("/api/leave/mine", pre, async (req) => {
    const snaps = await ctx.db.collection("leaveRequests").where("employeeId", "==", req.actor.id).get();
    const list = snaps.docs.map((d) => ({ id: d.id, ...serialize(d.data() as LeaveDoc) }));
    return { requests: list.sort((x, y) => (x.dateIST < y.dateIST ? 1 : -1)) };
  });

  // Approver view: requests of people in scope (never the approver's own).
  app.get("/api/leave/pending", pre, async (req) => {
    const team = (await listScopedEmployees(ctx, req.actor)).filter((e) => e.employeeId !== req.actor.id);
    const out: Array<ReturnType<typeof serialize> & { id: string; employeeName: string }> = [];
    for (const e of team) {
      const snaps = await ctx.db.collection("leaveRequests").where("employeeId", "==", e.employeeId).get();
      for (const d of snaps.docs) {
        const doc = d.data() as LeaveDoc;
        if (doc.status === "pending") out.push({ id: d.id, employeeName: e.name, ...serialize(doc) });
      }
    }
    return { requests: out.sort((x, y) => (x.dateIST < y.dateIST ? -1 : 1)) };
  });

  app.post("/api/leave/:id/decision", pre, async (req) => {
    const a = req.actor;
    const { id } = req.params as { id: string };
    const input = leaveDecisionInput.parse(req.body);
    const ref = ctx.db.collection("leaveRequests").doc(id);
    const preSnap = await ref.get();
    if (!preSnap.exists) throw notFound("Leave request");
    const target = await getEmployee(ctx, (preSnap.data() as LeaveDoc).employeeId);
    if (target.employeeId === a.id) throw forbidden("You cannot decide your own leave request.");
    if (!canManage(a, target)) throw forbidden("That employee is outside your scope.");
    const updated = await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.data() as LeaveDoc;
      await assertMonthUnlocked(ctx, cur.businessId, cur.dateIST, tx);
      if (cur.status !== "pending") throw conflict("ALREADY_DECIDED", `This request was already ${cur.status}.`);
      const next: LeaveDoc = { ...cur, status: input.decision, decidedBy: a.id, decidedAt: Timestamp.fromDate(ctx.clock()), decisionNote: input.note };
      tx.set(ref, next);
      await audit(ctx, { actorId: a.id, action: `leave.${input.decision}`, entity: "leaveRequests", entityId: id, before: { status: cur.status }, after: { status: next.status, lateApplication: cur.lateApplication }, reason: input.note || undefined }, tx);
      return next;
    });
    await recalcIfPastMonth(ctx, target, updated.dateIST, dateIST(ctx.clock()));
    await ctx.notifier.send({ template: "leave_decided", toEmployeeId: target.employeeId, params: { date: updated.dateIST, decision: updated.status } });
    return { request: { id, ...serialize(updated) }, note: updated.lateApplication && updated.status === "approved" ? "Late application: counts as absent for discipline." : null };
  });
}

function serialize(d: LeaveDoc) {
  return {
    employeeId: d.employeeId,
    dateIST: d.dateIST,
    type: d.type,
    reason: d.reason,
    appliedDateIST: d.appliedDateIST,
    lateApplication: d.lateApplication,
    status: d.status,
    decisionNote: d.decisionNote,
  };
}
