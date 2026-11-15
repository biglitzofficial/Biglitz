import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { dateIST, normalisePhone, pickAssignee, rupeesToPaise, type LEAD_SOURCES } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { badRequest } from "../http.js";
import type { AttendanceDoc, EmployeeDoc, LeaveDoc } from "../types.js";
import { attendanceId } from "./stats.js";

export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LeadStatus = "new" | "contacted" | "followUp" | "closedWon" | "lost";

export interface LeadDoc {
  name: string;
  phone: string;
  notes: string;
  source: LeadSource;
  businessId: string;
  assigneeId: string | null;
  status: LeadStatus;
  temperature: "hot" | "warm" | "cold" | null;
  nextFollowUpDate: string | null;
  closedValuePaise: number | null;
  closedDateIST: string | null;
  lostReason: string | null;
  externalId: string | null;
  createdAt: Timestamp;
  createdBy: string;
}

export interface PoolDoc {
  businessId: string;
  source: LeadSource | "all";
  staffOrder: string[];
  pointer: number;
  skipAbsent: boolean;
  managerId: string | null;
}

export const isOpen = (s: LeadStatus): boolean => s !== "closedWon" && s !== "lost";
export const leadPhoneId = (unit: string, phone: string): string => `${unit}_${phone}`;

export function requirePhone(raw: string): string {
  const p = normalisePhone(raw);
  if (!p) throw badRequest("BAD_PHONE", "Enter a valid 10-digit Indian mobile number.");
  return p;
}

export interface IntakeResult {
  leadId: string;
  deduplicated: boolean;
  assigneeId: string | null;
  noneEligible: boolean;
}

/** Staff eligible for round-robin today: punched in, not punched out, not on approved full-day leave. */
async function eligibilityMap(ctx: AppContext, staffIds: string[], today: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  if (staffIds.length === 0) return out;
  // Three batched reads instead of three per person (keeps intake fast for big pools).
  const [emps, atts, leaves] = await Promise.all([
    ctx.db.getAll(...staffIds.map((id) => ctx.db.collection("employees").doc(id))),
    ctx.db.getAll(...staffIds.map((id) => ctx.db.collection("attendance").doc(attendanceId(id, today)))),
    ctx.db.getAll(...staffIds.map((id) => ctx.db.collection("leaveRequests").doc(attendanceId(id, today)))),
  ]);
  staffIds.forEach((id, i) => {
    const e = emps[i]?.data() as EmployeeDoc | undefined;
    if (!e || e.status !== "active" || (e.exitDate && today > e.exitDate)) {
      out[id] = false;
      return;
    }
    const a = atts[i]?.exists ? (atts[i]?.data() as AttendanceDoc) : null;
    const l = leaves[i]?.exists ? (leaves[i]?.data() as LeaveDoc) : null;
    const onLeave = !!l && l.status === "approved" && l.type === "full";
    out[id] = !!a?.punchInAt && !a.punchOutAt && !onLeave;
  });
  return out;
}

/**
 * In-process queue per key: a burst of leads for the same pool is applied one after another instead of
 * all fighting over the pool's round-robin pointer. (Across several API instances the transaction + retry still protects it.)
 */
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries a Firestore transaction that lost a contention race (many leads hitting one pool pointer at once). */
async function withContentionRetry<T>(fn: () => Promise<T>, attempts = 15): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { code?: number | string; message?: string };
      const contention = err.code === 10 || err.code === 4 || err.code === "aborted" || /aborted|contention|too much|deadline/i.test(err.message ?? "");
      if (!contention || i >= attempts - 1) throw e;
      await sleep(Math.random() * 40 * 2 ** Math.min(i, 5));
    }
  }
}

async function findPool(ctx: AppContext, businessId: string, source: LeadSource, poolId?: string) {
  if (poolId) {
    const snap = await ctx.db.collection("leadPools").doc(poolId).get();
    return snap.exists ? { id: snap.id, pool: snap.data() as PoolDoc } : null;
  }
  const snaps = await ctx.db.collection("leadPools").where("businessId", "==", businessId).get();
  const pools = snaps.docs.map((d) => ({ id: d.id, pool: d.data() as PoolDoc }));
  return pools.find((p) => p.pool.source === source) ?? pools.find((p) => p.pool.source === "all") ?? null;
}

export interface CreateLeadParams {
  businessId: string;
  name: string;
  phone: string; // already normalised
  notes: string;
  source: LeadSource;
  createdBy: string;
  /** Direct assignee (manual add). If omitted the round-robin pool decides. */
  assigneeId?: string;
  poolId?: string;
  externalId?: string;
}

/**
 * Creates a lead, or - if the phone already exists in that unit - adds a history note, reopens it if lost,
 * and alerts the assignee. Phone uniqueness is enforced with a `leadPhones` index doc in a transaction.
 */
export async function createOrDedupLead(ctx: AppContext, p: CreateLeadParams): Promise<IntakeResult> {
  const today = dateIST(ctx.clock());
  const now = Timestamp.fromDate(ctx.clock());
  const idxRef = ctx.db.collection("leadPhones").doc(leadPhoneId(p.businessId, p.phone));

  // Idempotency for n8n retries.
  if (p.externalId) {
    const ext = await ctx.db.collection("leads").doc(`ext_${p.businessId}_${p.externalId}`.replace(/\//g, "_")).get();
    if (ext.exists) {
      const d = ext.data() as LeadDoc;
      return { leadId: ext.id, deduplicated: true, assigneeId: d.assigneeId, noneEligible: false };
    }
  }

  const found = await findPool(ctx, p.businessId, p.source, p.poolId);
  const elig = found && !p.assigneeId ? await eligibilityMap(ctx, found.pool.staffOrder, today) : {};

  const result = await serialize(found?.id ?? `unit_${p.businessId}`, () => withContentionRetry(() => ctx.db.runTransaction(async (tx: Transaction): Promise<IntakeResult> => {
    const idx = await tx.get(idxRef);
    const poolRef = found ? ctx.db.collection("leadPools").doc(found.id) : null;
    const poolSnap = poolRef ? await tx.get(poolRef) : null;

    if (idx.exists) {
      const leadId = (idx.data() as { leadId: string }).leadId;
      const leadRef = ctx.db.collection("leads").doc(leadId);
      const lead = (await tx.get(leadRef)).data() as LeadDoc;
      const wasLost = lead.status === "lost";
      if (wasLost) tx.update(leadRef, { status: "followUp", nextFollowUpDate: today, lostReason: null, closedDateIST: null });
      tx.set(leadRef.collection("history").doc(), { at: now, by: p.createdBy, status: wasLost ? "followUp" : lead.status, note: `Enquired again via ${p.source}` });
      return { leadId, deduplicated: true, assigneeId: lead.assigneeId, noneEligible: false };
    }

    let assigneeId: string | null = p.assigneeId ?? null;
    let noneEligible = false;
    if (!assigneeId && poolRef && poolSnap?.exists) {
      const pool = poolSnap.data() as PoolDoc;
      const pick = pickAssignee(pool.staffOrder, pool.pointer, (id) => elig[id] === true, pool.skipAbsent);
      assigneeId = pick.assignee;
      noneEligible = pick.noneEligible;
      tx.update(poolRef, { pointer: pick.nextPointer });
    }
    const leadRef = p.externalId
      ? ctx.db.collection("leads").doc(`ext_${p.businessId}_${p.externalId}`.replace(/\//g, "_"))
      : ctx.db.collection("leads").doc();
    const lead: LeadDoc = {
      name: p.name,
      phone: p.phone,
      notes: p.notes,
      source: p.source,
      businessId: p.businessId,
      assigneeId,
      status: "new",
      temperature: null,
      nextFollowUpDate: today,
      closedValuePaise: null,
      closedDateIST: null,
      lostReason: null,
      externalId: p.externalId ?? null,
      createdAt: now,
      createdBy: p.createdBy,
    };
    tx.set(leadRef, lead);
    tx.set(idxRef, { leadId: leadRef.id });
    tx.set(leadRef.collection("history").doc(), { at: now, by: p.createdBy, status: "new", note: `Lead created via ${p.source}` });
    return { leadId: leadRef.id, deduplicated: false, assigneeId, noneEligible };
  })));

  // Alerts (outside the transaction).
  if (result.assigneeId) {
    await ctx.notifier.send({
      template: result.deduplicated ? "lead_enquired_again" : "lead_assigned",
      toEmployeeId: result.assigneeId,
      params: { name: p.name, phone: p.phone, source: p.source },
      dedupKey: `lead_${result.leadId}_${result.deduplicated ? ctx.clock().getTime() : "assigned"}`,
    });
  }
  if (result.noneEligible && found?.pool.managerId) {
    await ctx.notifier.send({
      template: "lead_nobody_available",
      toEmployeeId: found.pool.managerId,
      params: { name: p.name, phone: p.phone, source: p.source },
      dedupKey: `lead_${result.leadId}_noneligible`,
    });
  }
  return result;
}

export const closedValueToPaise = (rupees: number): number => rupeesToPaise(rupees);
