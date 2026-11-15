import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Timestamp } from "firebase-admin/firestore";
import type { AppContext } from "../context.js";
import { requireSuperAdmin } from "../access.js";
import { guard } from "./guard.js";

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Audit log viewer: Super Admin only.
  app.get("/api/audit", { preHandler: guard(ctx) }, async (req) => {
    requireSuperAdmin(req.actor);
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    let query: FirebaseFirestore.Query = ctx.db.collection("auditLogs");
    if (q.entity) query = query.where("entity", "==", q.entity);
    if (q.entityId) query = query.where("entityId", "==", q.entityId);
    const snaps = await query.get();
    const logs = snaps.docs
      .map((d) => ({ id: d.id, ...(d.data() as { at: Timestamp } & Record<string, unknown>) }))
      .sort((a, b) => b.at.toMillis() - a.at.toMillis())
      .slice(0, q.limit)
      .map((l) => ({ ...l, at: l.at.toDate().toISOString() }));
    return { logs };
  });
}
