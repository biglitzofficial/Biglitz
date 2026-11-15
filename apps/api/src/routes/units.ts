import type { FastifyInstance } from "fastify";
import { businessUnitSchema, createUnitInput, updateUnitInput, type BusinessUnit } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { adminUnits, isAdminOf, isSuperAdmin, requireSuperAdmin } from "../access.js";
import { audit } from "../audit.js";
import { conflict, forbidden, notFound } from "../http.js";
import { guard } from "./guard.js";

export async function getUnit(ctx: AppContext, code: string): Promise<BusinessUnit> {
  const snap = await ctx.db.collection("businessUnits").doc(code).get();
  if (!snap.exists) throw notFound("Business unit");
  return snap.data() as BusinessUnit;
}

export function registerUnitRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  // Units visible to the actor: Super Admin all; Admin assigned; others their own unit.
  app.get("/api/units", pre, async (req) => {
    const a = req.actor;
    const snaps = await ctx.db.collection("businessUnits").get();
    const all = snaps.docs.map((d) => d.data() as BusinessUnit);
    if (isSuperAdmin(a)) return { units: all };
    const allowed = new Set([a.emp.businessId, ...(adminUnits(a) ?? [])]);
    return { units: all.filter((u) => allowed.has(u.code)) };
  });

  app.get("/api/units/:code", pre, async (req) => {
    const { code } = req.params as { code: string };
    const a = req.actor;
    if (!isSuperAdmin(a) && a.emp.businessId !== code && !isAdminOf(a, code)) throw forbidden();
    return { unit: await getUnit(ctx, code) };
  });

  // Only the Super Admin creates new business units.
  app.post("/api/units", pre, async (req) => {
    requireSuperAdmin(req.actor);
    const input = createUnitInput.parse(req.body);
    const unit: BusinessUnit = businessUnitSchema.parse({
      name: input.name,
      code: input.code,
      active: true,
      location: null,
      defaultShift: input.defaultShift ?? { start: "09:30", end: "22:00" },
      salesCategories: [],
      holidays: [],
      idCounter: 0,
      admins: [],
    });
    const ref = ctx.db.collection("businessUnits").doc(unit.code);
    await ctx.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) throw conflict("UNIT_EXISTS", `Business code ${unit.code} is already in use.`);
      tx.set(ref, unit);
      await audit(ctx, { actorId: req.actor.id, action: "unit.create", entity: "businessUnits", entityId: unit.code, before: null, after: unit }, tx);
    });
    return { unit };
  });

  // Super Admin, or Admin of that unit (cannot create new units).
  app.patch("/api/units/:code", pre, async (req) => {
    const { code } = req.params as { code: string };
    if (!isAdminOf(req.actor, code)) throw forbidden("Only an Admin of this business unit can change its settings.");
    const { reason, ...changes } = updateUnitInput.parse(req.body);
    const ref = ctx.db.collection("businessUnits").doc(code);
    return ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw notFound("Business unit");
      const before = snap.data() as BusinessUnit;
      const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      const after = businessUnitSchema.parse({ ...before, ...defined });
      tx.set(ref, after);
      await audit(ctx, { actorId: req.actor.id, action: "unit.update", entity: "businessUnits", entityId: code, before, after, ...(reason ? { reason } : {}) }, tx);
      return { unit: after };
    });
  });
}
