import type { FastifyInstance } from "fastify";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import {
  attendanceCorrectionInput,
  checkGps,
  dateIST,
  monthKeyIST,
  punchInput,
  todayEarned,
  type BusinessUnit,
} from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canManage, requireManage, type Actor } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, conflict, forbidden, notFound } from "../http.js";
import type { AttendanceDoc, DailySalesDoc, EmployeeDoc, EmployeePayDoc } from "../types.js";
import { assertMonthUnlocked } from "../services/lock.js";
import { recalcIfPastMonth } from "../services/payroll.js";
import { attendanceId, eligibleDates, effectiveStatus, loadDayDetails } from "../services/stats.js";
import { currentRateBps, getTarget, monthAmountSales, salesId } from "../services/sales.js";
import { getEmployee } from "./employees.js";
import { getUnit } from "./units.js";
import { guard } from "./guard.js";

const GPS_ACCURACY_LIMIT_M = 100;

async function checkSelfie(ctx: AppContext, actor: Actor, path: string): Promise<void> {
  if (!path.startsWith(`selfies/${actor.id}/`)) throw badRequest("BAD_SELFIE", "Invalid selfie. Please retake it.");
  if (!(await ctx.files.exists(path))) throw badRequest("SELFIE_MISSING", "The selfie did not upload. Please retake it and retry.");
}

function unitLocation(unit: BusinessUnit) {
  return unit.location;
}

export async function buildEarned(ctx: AppContext, emp: EmployeeDoc, today: string, halfDay: boolean) {
  const pay = (await ctx.db.collection("employeePay").doc(emp.employeeId).get()).data() as EmployeePayDoc;
  const target = await getTarget(ctx, emp.employeeId);
  const month = today.slice(0, 7);
  const monthSales = await monthAmountSales(ctx, emp.employeeId, month, today);
  const rate = currentRateBps(monthSales, target);
  const todaySnap = await ctx.db.collection("dailySales").doc(salesId(emp.employeeId, today)).get();
  const todaySales = todaySnap.exists ? (todaySnap.data() as DailySalesDoc).amountTotalPaise : 0;
  return {
    ...todayEarned({ committedPaise: pay.committedPaise, halfDay, todayAmountSalesPaise: todaySales, currentRateBps: rate }),
    incentiveIsEstimate: true,
  };
}

export function summarize(att: AttendanceDoc | undefined, today: string) {
  if (!att) return { state: "notPunchedIn" as const };
  return {
    state: att.punchOutAt ? ("punchedOut" as const) : ("punchedIn" as const),
    status: effectiveStatus(att, today),
    punchInAt: att.punchInAt?.toDate().toISOString() ?? null,
    punchOutAt: att.punchOutAt?.toDate().toISOString() ?? null,
    halfDay: att.halfDay,
  };
}

export function registerAttendanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  // Live selfie upload slot (backend-issued signed upload URL).
  app.post("/api/uploads/selfie-url", pre, async (req) => {
    const { kind } = z.object({ kind: z.enum(["in", "out"]) }).parse(req.body);
    const today = dateIST(ctx.clock());
    const path = `selfies/${req.actor.id}/${today}-${kind}-${ctx.clock().getTime()}.jpg`;
    return { path, uploadUrl: await ctx.files.uploadUrl(path, "image/jpeg") };
  });

  app.post("/api/attendance/punch-in", pre, async (req) => {
    const a = req.actor;
    const input = punchInput.parse(req.body);
    const now = ctx.clock();
    const today = dateIST(now);
    const unit = await getUnit(ctx, a.emp.businessId);
    const gps = checkGps(input.gps, unitLocation(unit), GPS_ACCURACY_LIMIT_M);
    if (!gps.ok) throw badRequest(gps.code, gps.message);
    await checkSelfie(ctx, a, input.selfiePath);

    const ref = ctx.db.collection("attendance").doc(attendanceId(a.id, today));
    await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const existing = snap.data() as AttendanceDoc;
        if (existing.punchInAt) throw conflict("ALREADY_PUNCHED_IN", "You have already punched in today.");
        if (existing.absentOverride) throw conflict("MARKED_ABSENT", "You were marked absent today. Ask your Manager.");
      }
      const doc: AttendanceDoc = {
        employeeId: a.id,
        businessId: a.emp.businessId,
        dateIST: today,
        punchInAt: Timestamp.fromDate(now),
        punchOutAt: null,
        punchIn: { ...input.gps, distanceMeters: gps.distanceMeters, selfiePath: input.selfiePath },
        punchOut: null,
        shift: a.emp.shift,
        halfDay: snap.exists ? (snap.data() as AttendanceDoc).halfDay : false,
        absentOverride: false,
        corrections: snap.exists ? (snap.data() as AttendanceDoc).corrections : [],
      };
      tx.set(ref, doc);
    });
    const att = (await ref.get()).data() as AttendanceDoc;
    return { attendance: summarize(att, today), distanceMeters: Math.round(gps.distanceMeters) };
  });

  app.post("/api/attendance/punch-out", pre, async (req) => {
    const a = req.actor;
    const input = punchInput.parse(req.body);
    const now = ctx.clock();
    const today = dateIST(now);
    const unit = await getUnit(ctx, a.emp.businessId);
    const ref = ctx.db.collection("attendance").doc(attendanceId(a.id, today));
    const pre0 = await ref.get();
    if (!pre0.exists || !(pre0.data() as AttendanceDoc).punchInAt) throw badRequest("NOT_PUNCHED_IN", "You have not punched in today.");
    if ((pre0.data() as AttendanceDoc).punchOutAt) throw conflict("ALREADY_PUNCHED_OUT", "You have already punched out today.");

    const gps = checkGps(input.gps, unitLocation(unit), GPS_ACCURACY_LIMIT_M);
    if (!gps.ok) throw badRequest(gps.code, gps.message);
    await checkSelfie(ctx, a, input.selfiePath);

    // Daily sales entry must be submitted before punch-out (spec 8.5).
    const hasCategories = unit.salesCategories.some((c) => c.active);
    if (a.emp.requiresSalesEntry && hasCategories) {
      const sales = await ctx.db.collection("dailySales").doc(salesId(a.id, today)).get();
      if (!sales.exists) throw conflict("SALES_REQUIRED", "Submit today's sales entry (or tap \"No sales today\") before punching out.");
    }

    await ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.data() as AttendanceDoc;
      if (cur.punchOutAt) throw conflict("ALREADY_PUNCHED_OUT", "You have already punched out today.");
      tx.update(ref, {
        punchOutAt: Timestamp.fromDate(now),
        punchOut: { ...input.gps, distanceMeters: gps.distanceMeters, selfiePath: input.selfiePath },
      });
    });
    const att = (await ref.get()).data() as AttendanceDoc;
    const earned = await buildEarned(ctx, a.emp, today, att.halfDay);
    return { attendance: summarize(att, today), earned };
  });

  app.get("/api/attendance/today", pre, async (req) => {
    const today = dateIST(ctx.clock());
    const snap = await ctx.db.collection("attendance").doc(attendanceId(req.actor.id, today)).get();
    return { dateIST: today, attendance: summarize(snap.exists ? (snap.data() as AttendanceDoc) : undefined, today) };
  });

  // Calendar: colours per day. Staff see only themselves; managers/admins see anyone in scope.
  app.get("/api/attendance/calendar", pre, async (req) => {
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional(), employeeId: z.string().optional() }).parse(req.query);
    const target = q.employeeId ? await getEmployee(ctx, q.employeeId) : req.actor.emp;
    if (target.employeeId !== req.actor.id && !canManage(req.actor, target)) throw forbidden("That employee is outside your scope.");
    const today = dateIST(ctx.clock());
    const month = q.month ?? monthKeyIST(ctx.clock());
    const dates = eligibleDates(target, month, `${month}-31`).filter((d) => d <= today);
    const details = await loadDayDetails(ctx, target, dates, today);
    return {
      month,
      days: details.map((d) => ({ date: d.date, status: d.status, lateApplication: d.lateApplication, present: d.present })),
    };
  });

  // Single-day detail with GPS pins and selfies for managers.
  app.get("/api/attendance/:employeeId/:date", pre, async (req) => {
    const { employeeId, date } = req.params as { employeeId: string; date: string };
    const target = await getEmployee(ctx, employeeId);
    if (!canManage(req.actor, target)) throw forbidden("That employee is outside your scope.");
    const snap = await ctx.db.collection("attendance").doc(attendanceId(employeeId, date)).get();
    if (!snap.exists) throw notFound("Attendance record");
    const att = snap.data() as AttendanceDoc;
    const selfie = async (p: { selfiePath: string } | null) => (p ? await ctx.files.downloadUrl(p.selfiePath) : null);
    return {
      attendance: {
        ...summarize(att, dateIST(ctx.clock())),
        punchIn: att.punchIn && { lat: att.punchIn.lat, lng: att.punchIn.lng, accuracy: att.punchIn.accuracy, distanceMeters: att.punchIn.distanceMeters, selfieUrl: await selfie(att.punchIn) },
        punchOut: att.punchOut && { lat: att.punchOut.lat, lng: att.punchOut.lng, accuracy: att.punchOut.accuracy, distanceMeters: att.punchOut.distanceMeters, selfieUrl: await selfie(att.punchOut) },
        corrections: att.corrections.map((c) => ({ by: c.by, at: c.at.toDate().toISOString(), reason: c.reason })),
      },
    };
  });

  app.post("/api/attendance/correct", pre, async (req) => {
    const a = req.actor;
    const input = attendanceCorrectionInput.parse(req.body);
    const target = await getEmployee(ctx, input.employeeId);
    requireManage(a, target);
    const today = dateIST(ctx.clock());
    if (input.dateIST > today) throw badRequest("FUTURE_DATE", "You cannot correct a future date.");
    const ref = ctx.db.collection("attendance").doc(attendanceId(target.employeeId, input.dateIST));
    const result = await ctx.db.runTransaction(async (tx) => {
      await assertMonthUnlocked(ctx, target.businessId, input.dateIST, tx);
      const snap = await tx.get(ref);
      const before: AttendanceDoc = snap.exists
        ? (snap.data() as AttendanceDoc)
        : { employeeId: target.employeeId, businessId: target.businessId, dateIST: input.dateIST, punchInAt: null, punchOutAt: null, punchIn: null, punchOut: null, shift: target.shift, halfDay: false, absentOverride: false, corrections: [] };
      const next: AttendanceDoc = { ...before };
      if (input.markAbsent) {
        next.absentOverride = true;
        next.halfDay = false;
      } else {
        next.absentOverride = false;
        if (input.punchInAt) next.punchInAt = Timestamp.fromDate(new Date(input.punchInAt));
        if (input.punchOutAt !== undefined) next.punchOutAt = input.punchOutAt ? Timestamp.fromDate(new Date(input.punchOutAt)) : null;
        if (input.halfDay !== undefined) next.halfDay = input.halfDay;
      }
      const snapshot = {
        punchInAt: before.punchInAt?.toDate().toISOString() ?? null,
        punchOutAt: before.punchOutAt?.toDate().toISOString() ?? null,
        halfDay: before.halfDay,
        absentOverride: before.absentOverride,
      };
      next.corrections = [...before.corrections, { by: a.id, at: Timestamp.fromDate(ctx.clock()), reason: input.reason, before: snapshot }];
      tx.set(ref, next);
      await audit(ctx, { actorId: a.id, action: "attendance.correct", entity: "attendance", entityId: ref.id, before: snapshot, after: { punchInAt: next.punchInAt?.toDate().toISOString() ?? null, punchOutAt: next.punchOutAt?.toDate().toISOString() ?? null, halfDay: next.halfDay, absentOverride: next.absentOverride }, reason: input.reason }, tx);
      return next;
    });
    await recalcIfPastMonth(ctx, target, input.dateIST, today);
    return { attendance: summarize(result, today) };
  });

}
