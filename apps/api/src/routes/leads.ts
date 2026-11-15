import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { createLeadInput, dateIST, intakeInput, monthKeyIST, poolInput, reassignLeadInput, updateLeadInput } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canManage, isAdminOf, isAnyAdmin, isManager, isSuperAdmin, type Actor } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, forbidden, HttpError, notFound } from "../http.js";
import type { EmployeeDoc } from "../types.js";
import { closedValueToPaise, createOrDedupLead, isOpen, requirePhone, type LeadDoc, type PoolDoc } from "../services/leads.js";
import { getEmployee, listScopedEmployees } from "./employees.js";
import { guard } from "./guard.js";

const DEFAULT_LOST_REASONS = ["Price too high", "Bought elsewhere", "Not reachable", "Just enquiring", "Other"];

function leadView(id: string, l: LeadDoc) {
  return {
    id,
    name: l.name,
    phone: l.phone,
    notes: l.notes,
    source: l.source,
    businessId: l.businessId,
    assigneeId: l.assigneeId,
    status: l.status,
    temperature: l.temperature,
    nextFollowUpDate: l.nextFollowUpDate,
    closedValuePaise: l.closedValuePaise,
    lostReason: l.lostReason,
    createdAt: l.createdAt.toDate().toISOString(),
  };
}

/** Can the actor see/change this lead? Own leads, or leads owned by someone in their management scope. */
async function canTouchLead(ctx: AppContext, a: Actor, lead: LeadDoc): Promise<boolean> {
  if (lead.assigneeId === a.id) return true;
  if (isAdminOf(a, lead.businessId)) return true;
  if (lead.assigneeId && isManager(a)) {
    const owner = await ctx.db.collection("employees").doc(lead.assigneeId).get();
    return owner.exists && canManage(a, owner.data() as EmployeeDoc);
  }
  // Unassigned leads are visible to Managers of that unit.
  return !lead.assigneeId && isManager(a) && a.emp.businessId === lead.businessId;
}

async function scopedLeads(ctx: AppContext, a: Actor, employeeId?: string): Promise<Array<LeadDoc & { id: string }>> {
  const team = employeeId
    ? [await getEmployee(ctx, employeeId)]
    : (await listScopedEmployees(ctx, a));
  const allowed = team.filter((e) => e.employeeId === a.id || canManage(a, e));
  const out: Array<LeadDoc & { id: string }> = [];
  for (const e of allowed) {
    const snaps = await ctx.db.collection("leads").where("assigneeId", "==", e.employeeId).get();
    snaps.docs.forEach((d) => out.push({ id: d.id, ...(d.data() as LeadDoc) }));
  }
  if (!employeeId && (isManager(a) || isAnyAdmin(a))) {
    const units = new Set(allowed.map((e) => e.businessId));
    for (const u of units) {
      const snaps = await ctx.db.collection("leads").where("businessId", "==", u).where("assigneeId", "==", null).get();
      snaps.docs.forEach((d) => out.push({ id: d.id, ...(d.data() as LeadDoc) }));
    }
  }
  return out;
}

export function counts(leads: LeadDoc[], today: string, month: string) {
  const open = leads.filter((l) => isOpen(l.status));
  return {
    todayFollowUps: open.filter((l) => l.nextFollowUpDate === today).length,
    overdue: open.filter((l) => !!l.nextFollowUpDate && l.nextFollowUpDate < today).length,
    total: leads.length,
    closedWon: leads.filter((l) => l.status === "closedWon").length,
    lost: leads.filter((l) => l.status === "lost").length,
    open: open.length,
    closedValueThisMonthPaise: leads.filter((l) => l.status === "closedWon" && l.closedDateIST?.startsWith(month)).reduce((s, l) => s + (l.closedValuePaise ?? 0), 0),
  };
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerLeadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  // Automatic intake from n8n. Auth: X-Intake-Secret header.
  app.post("/api/leads/intake", async (req) => {
    if (!ctx.env.INTAKE_SECRET) throw new HttpError(503, "INTAKE_DISABLED", "Lead intake is not configured.");
    if (!secretMatches(req.headers["x-intake-secret"] as string | undefined, ctx.env.INTAKE_SECRET)) {
      throw new HttpError(401, "BAD_SECRET", "Invalid intake secret.");
    }
    const input = intakeInput.parse(req.body);
    const unitSnap = await ctx.db.collection("businessUnits").doc(input.businessCode).get();
    if (!unitSnap.exists) throw badRequest("BAD_UNIT", `Unknown business code ${input.businessCode}.`);
    const result = await createOrDedupLead(ctx, {
      businessId: input.businessCode,
      name: input.name,
      phone: requirePhone(input.phone),
      notes: input.notes,
      source: input.source,
      createdBy: "intake",
      ...(input.poolId ? { poolId: input.poolId } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
    });
    return result;
  });

  app.post("/api/leads", pre, async (req) => {
    const a = req.actor;
    const input = createLeadInput.parse(req.body);
    const assigneeId = input.assigneeId ?? a.id;
    if (assigneeId !== a.id && !canManage(a, await getEmployee(ctx, assigneeId))) throw forbidden("You can only add leads for yourself.");
    const result = await createOrDedupLead(ctx, {
      businessId: a.emp.businessId,
      name: input.name,
      phone: requirePhone(input.phone),
      notes: input.notes,
      source: input.source,
      createdBy: a.id,
      assigneeId,
    });
    return result;
  });

  app.get("/api/leads", pre, async (req) => {
    const q = z.object({
      view: z.enum(["today", "overdue", "all"]).default("all"),
      status: z.string().optional(),
      employeeId: z.string().optional(),
      search: z.string().optional(),
    }).parse(req.query);
    const today = dateIST(ctx.clock());
    let leads = await scopedLeads(ctx, req.actor, q.employeeId);
    if (q.view === "today") leads = leads.filter((l) => isOpen(l.status) && l.nextFollowUpDate === today);
    if (q.view === "overdue") leads = leads.filter((l) => isOpen(l.status) && !!l.nextFollowUpDate && l.nextFollowUpDate < today);
    if (q.status) leads = leads.filter((l) => l.status === q.status);
    if (q.search) {
      const s = q.search.toLowerCase();
      leads = leads.filter((l) => l.name.toLowerCase().includes(s) || l.phone.includes(s));
    }
    leads.sort((x, y) => (x.nextFollowUpDate ?? "9999") < (y.nextFollowUpDate ?? "9999") ? -1 : 1);
    return { leads: leads.map((l) => leadView(l.id, l)) };
  });

  app.get("/api/leads/dashboard", pre, async (req) => {
    const q = z.object({ employeeId: z.string().optional() }).parse(req.query);
    const leads = await scopedLeads(ctx, req.actor, q.employeeId);
    const now = ctx.clock();
    return { counts: counts(leads, dateIST(now), monthKeyIST(now)) };
  });

  app.get("/api/leads/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const snap = await ctx.db.collection("leads").doc(id).get();
    if (!snap.exists) throw notFound("Lead");
    const lead = snap.data() as LeadDoc;
    if (!(await canTouchLead(ctx, req.actor, lead))) throw forbidden("That lead is not in your scope.");
    const hist = await snap.ref.collection("history").get();
    const history = hist.docs
      .map((d) => d.data() as { at: Timestamp; by: string; status: string; note: string })
      .sort((x, y) => x.at.toMillis() - y.at.toMillis())
      .map((h) => ({ at: h.at.toDate().toISOString(), by: h.by, status: h.status, note: h.note }));
    return { lead: leadView(id, lead), history };
  });

  app.patch("/api/leads/:id", pre, async (req) => {
    const a = req.actor;
    const { id } = req.params as { id: string };
    const input = updateLeadInput.parse(req.body);
    const ref = ctx.db.collection("leads").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Lead");
    const lead = snap.data() as LeadDoc;
    if (!(await canTouchLead(ctx, a, lead))) throw forbidden("That lead is not in your scope.");

    const today = dateIST(ctx.clock());
    const update: Partial<LeadDoc> = { status: input.status };
    switch (input.status) {
      case "followUp":
        if (!input.temperature) throw badRequest("TEMPERATURE_REQUIRED", "Choose Hot, Warm or Cold for a follow-up.");
        if (!input.nextFollowUpDate) throw badRequest("FOLLOWUP_DATE_REQUIRED", "Set the next follow-up date.");
        update.temperature = input.temperature;
        update.nextFollowUpDate = input.nextFollowUpDate;
        break;
      case "contacted":
      case "new":
        if (input.nextFollowUpDate !== undefined) update.nextFollowUpDate = input.nextFollowUpDate;
        break;
      case "closedWon":
        if (input.closedValueRupees === undefined) throw badRequest("VALUE_REQUIRED", "Enter the sale value for Closed won.");
        update.closedValuePaise = closedValueToPaise(input.closedValueRupees);
        update.closedDateIST = today;
        update.nextFollowUpDate = null;
        break;
      case "lost": {
        const reason = input.lostReason?.trim();
        if (!reason) throw badRequest("REASON_REQUIRED", "Choose a reason for Lost.");
        if (reason === "Other" && !input.note.trim()) throw badRequest("NOTE_REQUIRED", "A note is required when the reason is Other.");
        update.lostReason = reason;
        update.closedDateIST = today;
        update.nextFollowUpDate = null;
        break;
      }
    }
    await ref.update(update);
    await ref.collection("history").add({ at: Timestamp.fromDate(ctx.clock()), by: a.id, status: input.status, note: input.note });
    return { lead: leadView(id, { ...lead, ...update }) };
  });

  app.post("/api/leads/:id/reassign", pre, async (req) => {
    const a = req.actor;
    const { id } = req.params as { id: string };
    const { assigneeId } = reassignLeadInput.parse(req.body);
    const ref = ctx.db.collection("leads").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Lead");
    const lead = snap.data() as LeadDoc;
    const newOwner = await getEmployee(ctx, assigneeId);
    if (!canManage(a, newOwner)) throw forbidden("You can only assign to someone in your scope.");
    if (newOwner.status === "exited") throw badRequest("BAD_ASSIGNEE", "That employee has exited.");
    if (!(await canTouchLead(ctx, a, lead)) || (lead.assigneeId === a.id && !isManager(a) && !isAnyAdmin(a))) throw forbidden("That lead is not in your scope.");
    await ref.update({ assigneeId });
    await ref.collection("history").add({ at: Timestamp.fromDate(ctx.clock()), by: a.id, status: lead.status, note: `Reassigned to ${assigneeId}` });
    await ctx.notifier.send({ template: "lead_assigned", toEmployeeId: assigneeId, params: { name: lead.name, phone: lead.phone, source: lead.source }, dedupKey: `lead_${id}_re_${assigneeId}_${ctx.clock().getTime()}` });
    return { ok: true };
  });

  // ---- Lost reasons (editable list) ----
  app.get("/api/settings/lost-reasons", pre, async () => {
    const snap = await ctx.db.collection("settings").doc("global").get();
    return { reasons: ((snap.data() as { lostReasons?: string[] } | undefined)?.lostReasons ?? DEFAULT_LOST_REASONS) as string[] };
  });
  app.put("/api/settings/lost-reasons", pre, async (req) => {
    if (!isAnyAdmin(req.actor)) throw forbidden("Only an Admin can edit lost reasons.");
    const { reasons } = z.object({ reasons: z.array(z.string().min(1)).min(1) }).parse(req.body);
    if (!reasons.includes("Other")) reasons.push("Other");
    await ctx.db.collection("settings").doc("global").set({ lostReasons: reasons }, { merge: true });
    await audit(ctx, { actorId: req.actor.id, action: "settings.lostReasons", entity: "settings", entityId: "global", before: null, after: reasons });
    return { reasons };
  });

  // ---- Round-robin pools (Manager/Admin) ----
  async function assertPoolAccess(a: Actor, unit: string, staff: string[]): Promise<void> {
    if (!isAdminOf(a, unit) && !(isManager(a) && a.emp.businessId === unit)) throw forbidden("You cannot manage pools for that business unit.");
    for (const id of staff) {
      const e = await getEmployee(ctx, id);
      if (e.businessId !== unit) throw badRequest("BAD_STAFF", `${id} does not belong to ${unit}.`);
      if (e.status === "exited") throw badRequest("BAD_STAFF", `${id} has exited.`);
      if (!isAdminOf(a, unit) && !canManage(a, e) && e.employeeId !== a.id) throw forbidden(`${id} is outside your team.`);
    }
  }

  app.post("/api/lead-pools", pre, async (req) => {
    const input = poolInput.parse(req.body);
    await assertPoolAccess(req.actor, input.businessId, input.staffOrder);
    const doc: PoolDoc = { businessId: input.businessId, source: input.source, staffOrder: input.staffOrder, pointer: 0, skipAbsent: input.skipAbsent, managerId: input.managerId ?? req.actor.id };
    const ref = await ctx.db.collection("leadPools").add(doc);
    await audit(ctx, { actorId: req.actor.id, action: "pool.create", entity: "leadPools", entityId: ref.id, before: null, after: doc });
    return { id: ref.id, pool: doc };
  });

  app.put("/api/lead-pools/:id", pre, async (req) => {
    const { id } = req.params as { id: string };
    const input = poolInput.parse(req.body);
    const ref = ctx.db.collection("leadPools").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Pool");
    await assertPoolAccess(req.actor, input.businessId, input.staffOrder);
    const before = snap.data() as PoolDoc;
    const doc: PoolDoc = { ...before, source: input.source, staffOrder: input.staffOrder, skipAbsent: input.skipAbsent, managerId: input.managerId ?? before.managerId, pointer: 0 };
    await ref.set(doc);
    await audit(ctx, { actorId: req.actor.id, action: "pool.update", entity: "leadPools", entityId: id, before, after: doc });
    return { id, pool: doc };
  });

  app.get("/api/lead-pools", pre, async (req) => {
    const a = req.actor;
    if (!isManager(a) && !isAnyAdmin(a)) throw forbidden();
    const units = isSuperAdmin(a)
      ? new Set((await ctx.db.collection("businessUnits").get()).docs.map((d) => d.id))
      : new Set([a.emp.businessId, ...a.emp.adminBusinessIds]);
    const out: Array<PoolDoc & { id: string }> = [];
    for (const u of units) {
      const snaps = await ctx.db.collection("leadPools").where("businessId", "==", u).get();
      snaps.docs.forEach((d) => out.push({ id: d.id, ...(d.data() as PoolDoc) }));
    }
    return { pools: out };
  });
}
