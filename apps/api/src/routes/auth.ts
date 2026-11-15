import type { FastifyInstance, FastifyRequest } from "fastify";
import bcrypt from "bcryptjs";
import { Timestamp } from "firebase-admin/firestore";
import { changePinInput, dateIST, loginInput, resetPinInput, validatePin } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import type { Actor } from "../access.js";
import { isAdminOf } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../http.js";
import { guard } from "./guard.js";
import type { AuthPinDoc, EmployeeDoc } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
  }
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

/** Exited employees cannot log in the day after their exit date (spec 7.4, 5.5). */
export function loginBlockReason(emp: EmployeeDoc, today: string): string | null {
  if (emp.status === "pending") return "Your account is not active yet. Please contact your Admin.";
  if (emp.status === "exited") return "Your account is no longer active.";
  if (emp.exitDate && today > emp.exitDate) return "Your account is no longer active.";
  return null;
}

export async function loadEmployee(ctx: AppContext, id: string): Promise<EmployeeDoc | null> {
  const snap = await ctx.db.collection("employees").doc(id).get();
  return snap.exists ? (snap.data() as EmployeeDoc) : null;
}

/** Verifies the bearer token and re-reads roles from Firestore (claims are not the authority). */
export async function authenticate(ctx: AppContext, req: FastifyRequest, opts: { allowMustChangePin?: boolean } = {}): Promise<Actor> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  let uid: string;
  try {
    uid = await ctx.tokens.verify(header.slice(7));
  } catch {
    throw unauthorized("Your session has expired. Please log in again.");
  }
  const emp = await loadEmployee(ctx, uid);
  if (!emp) throw unauthorized();
  const blocked = loginBlockReason(emp, dateIST(ctx.clock()));
  if (blocked) throw new HttpError(401, "ACCOUNT_INACTIVE", blocked);
  if (!opts.allowMustChangePin) {
    const pin = (await ctx.db.collection("authPins").doc(uid).get()).data() as AuthPinDoc | undefined;
    if (pin?.mustChangePin) throw new HttpError(403, "PIN_CHANGE_REQUIRED", "Please set a new PIN before continuing.");
  }
  return { id: uid, emp };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/auth/login", async (req) => {
    const { mobile, pin } = loginInput.parse(req.body);
    const now = ctx.clock();
    const idx = await ctx.db.collection("mobileIndex").doc(mobile).get();
    const wrong = new HttpError(401, "BAD_CREDENTIALS", "Mobile number or PIN is incorrect.");
    if (!idx.exists) throw wrong;
    const employeeId = (idx.data() as { employeeId: string }).employeeId;
    const emp = await loadEmployee(ctx, employeeId);
    if (!emp) throw wrong;

    const pinRef = ctx.db.collection("authPins").doc(employeeId);
    const pinSnap = await pinRef.get();
    if (!pinSnap.exists) throw wrong;
    const pinDoc = pinSnap.data() as AuthPinDoc;

    if (pinDoc.lockedUntil && pinDoc.lockedUntil.toMillis() > now.getTime()) {
      const mins = Math.ceil((pinDoc.lockedUntil.toMillis() - now.getTime()) / 60_000);
      throw new HttpError(423, "ACCOUNT_LOCKED", `Too many wrong PINs. Try again in ${mins} minute(s) or ask your Admin to reset your PIN.`);
    }

    const ok = await bcrypt.compare(pin, pinDoc.pinHash);
    if (!ok) {
      const failed = pinDoc.failedAttempts + 1;
      const lock = failed >= MAX_FAILED;
      await pinRef.update({
        failedAttempts: lock ? 0 : failed,
        lockedUntil: lock ? Timestamp.fromMillis(now.getTime() + LOCK_MINUTES * 60_000) : null,
      });
      if (lock) throw new HttpError(423, "ACCOUNT_LOCKED", `Too many wrong PINs. Account locked for ${LOCK_MINUTES} minutes.`);
      throw wrong;
    }

    const blocked = loginBlockReason(emp, dateIST(now));
    if (blocked) throw new HttpError(401, "ACCOUNT_INACTIVE", blocked);

    await pinRef.update({ failedAttempts: 0, lockedUntil: null });
    const token = await ctx.tokens.mint(employeeId, {
      employeeId,
      roles: emp.roles,
      businessIds: [emp.businessId, ...emp.adminBusinessIds],
      ...(emp.roles.includes("manager") ? { managerOf: employeeId } : {}),
    });
    return { token, mustChangePin: pinDoc.mustChangePin };
  });

  app.post("/api/auth/change-pin", { preHandler: guard(ctx, { allowMustChangePin: true }) }, async (req) => {
    const { currentPin, newPin } = changePinInput.parse(req.body);
    const actor = req.actor;
    const check = validatePin(newPin, actor.emp.mobile);
    if (!check.ok) throw badRequest("WEAK_PIN", check.message);
    const pinRef = ctx.db.collection("authPins").doc(actor.id);
    const pinDoc = (await pinRef.get()).data() as AuthPinDoc;
    if (!(await bcrypt.compare(currentPin, pinDoc.pinHash))) throw badRequest("BAD_PIN", "Your current PIN is incorrect.");
    if (currentPin === newPin) throw badRequest("SAME_PIN", "Choose a PIN different from the current one.");
    await pinRef.update({ pinHash: await bcrypt.hash(newPin, ctx.bcryptCost), mustChangePin: false });
    await audit(ctx, { actorId: actor.id, action: "pin.change", entity: "authPins", entityId: actor.id, before: null, after: null });
    return { ok: true };
  });

  app.post(
    "/api/employees/:id/reset-pin",
    { preHandler: guard(ctx) },
    async (req) => {
      const { id } = req.params as { id: string };
      const { tempPin } = resetPinInput.parse(req.body);
      const target = await loadEmployee(ctx, id);
      if (!target) throw notFound("Employee");
      if (!isAdminOf(req.actor, target.businessId)) throw forbidden("Only an Admin of this unit can reset a PIN.");
      const check = validatePin(tempPin, target.mobile);
      if (!check.ok) throw badRequest("WEAK_PIN", check.message);
      await ctx.db.collection("authPins").doc(id).set({
        pinHash: await bcrypt.hash(tempPin, ctx.bcryptCost),
        failedAttempts: 0,
        lockedUntil: null,
        mustChangePin: true,
      });
      await audit(ctx, { actorId: req.actor.id, action: "pin.reset", entity: "authPins", entityId: id, before: null, after: null });
      return { ok: true };
    },
  );
}
