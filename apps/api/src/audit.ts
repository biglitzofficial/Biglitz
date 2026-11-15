import { Timestamp, type Transaction } from "firebase-admin/firestore";
import type { AppContext } from "./context.js";

export interface AuditEntry {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason?: string;
}

/** Writes an auditLogs entry (who, when, before, after, reason). Pass `tx` to make it atomic. */
export async function audit(ctx: AppContext, entry: AuditEntry, tx?: Transaction): Promise<void> {
  const ref = ctx.db.collection("auditLogs").doc();
  const doc = {
    ...entry,
    // undefined is not allowed in Firestore; normalise via JSON.
    before: entry.before === undefined ? null : JSON.parse(JSON.stringify(entry.before)),
    after: entry.after === undefined ? null : JSON.parse(JSON.stringify(entry.after)),
    reason: entry.reason ?? null,
    at: Timestamp.fromDate(ctx.clock()),
  };
  if (tx) tx.set(ref, doc);
  else await ref.set(doc);
}
