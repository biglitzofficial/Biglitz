import type { FastifyInstance } from "fastify";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { createTaskInput, dateIST, monthKeyIST } from "@biglitz/shared";
import type { AppContext } from "../context.js";
import { canManage, isManager, isAnyAdmin } from "../access.js";
import { audit } from "../audit.js";
import { badRequest, forbidden, notFound } from "../http.js";
import type { AttendanceDoc } from "../types.js";
import { generateRecurringFor, type TaskDoc } from "../services/recurring.js";
import { attendanceId } from "../services/stats.js";
import { getEmployee, listScopedEmployees } from "./employees.js";
import { guard } from "./guard.js";

type TaskView = TaskDoc & { id: string };

function view(id: string, t: TaskDoc) {
  return {
    id,
    title: t.title,
    description: t.description,
    assigneeId: t.assigneeId,
    assignedBy: t.assignedBy,
    businessId: t.businessId,
    dueAt: t.dueAt?.toDate().toISOString() ?? null,
    priority: t.priority,
    status: t.status,
    repeat: t.repeat,
    templateId: t.templateId,
    createdAt: t.createdAt.toDate().toISOString(),
    doneAt: t.doneAt?.toDate().toISOString() ?? null,
  };
}

/** Real (non-template) tasks of an employee. */
async function tasksOf(ctx: AppContext, employeeId: string): Promise<TaskView[]> {
  const snaps = await ctx.db.collection("tasks").where("assigneeId", "==", employeeId).get();
  return snaps.docs.map((d) => ({ id: d.id, ...(d.data() as TaskDoc) })).filter((t) => !t.isTemplate);
}

export function classify(t: TaskDoc, now: Date, today: string) {
  const dueToday = t.dueAt ? dateIST(t.dueAt.toDate()) === today : dateIST(t.createdAt.toDate()) === today;
  const overdue = t.status === "todo" && !!t.dueAt && t.dueAt.toMillis() < now.getTime();
  return { dueToday, overdue };
}

export function summarizeTasks(tasks: TaskDoc[], now: Date) {
  const today = dateIST(now);
  const month = monthKeyIST(now);
  const todays = tasks.filter((t) => classify(t, now, today).dueToday);
  return {
    todayDone: todays.filter((t) => t.status === "done").length,
    todayTotal: todays.length,
    pending: tasks.filter((t) => t.status === "todo").length,
    overdue: tasks.filter((t) => classify(t, now, today).overdue).length,
    completedThisMonth: tasks.filter((t) => t.status === "done" && t.doneAt && monthKeyIST(t.doneAt.toDate()) === month).length,
  };
}

export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pre = { preHandler: guard(ctx) };

  app.post("/api/tasks", pre, async (req) => {
    const a = req.actor;
    const input = createTaskInput.parse(req.body);
    const assigneeId = input.assigneeId ?? a.id;
    const assignee = assigneeId === a.id ? a.emp : await getEmployee(ctx, assigneeId);
    if (assigneeId !== a.id && !canManage(a, assignee)) throw forbidden("Staff can only create tasks for themselves.");
    if (assignee.status === "exited" || (assignee.exitDate && dateIST(ctx.clock()) > assignee.exitDate)) {
      throw badRequest("ASSIGNEE_EXITED", "That employee has exited and cannot be assigned tasks.");
    }
    const isTemplate = input.repeat.kind !== "none";
    const doc: TaskDoc = {
      title: input.title,
      description: input.description,
      assigneeId,
      assignedBy: a.id,
      businessId: assignee.businessId,
      dueAt: input.dueAt ? Timestamp.fromDate(new Date(input.dueAt)) : null,
      priority: input.priority,
      status: "todo",
      repeat: input.repeat,
      isTemplate,
      templateId: null,
      occurrenceDate: null,
      createdAt: Timestamp.fromDate(ctx.clock()),
      doneAt: null,
    };
    const ref = ctx.db.collection("tasks").doc();
    await ref.set(doc);
    if (isTemplate) await generateRecurringFor(ctx, dateIST(ctx.clock()), ref.id);
    if (assigneeId !== a.id) {
      await ctx.notifier.send({ template: "task_assigned", toEmployeeId: assigneeId, params: { title: input.title, by: a.emp.name }, dedupKey: `task_assigned_${ref.id}` });
    }
    return { task: view(ref.id, doc) };
  });

  app.get("/api/tasks", pre, async (req) => {
    const q = z.object({ tab: z.enum(["today", "pending", "overdue", "done"]).default("today"), employeeId: z.string().optional() }).parse(req.query);
    const target = q.employeeId ? await getEmployee(ctx, q.employeeId) : req.actor.emp;
    if (target.employeeId !== req.actor.id && !canManage(req.actor, target)) throw forbidden("That employee is outside your scope.");
    const now = ctx.clock();
    const today = dateIST(now);
    const all = await tasksOf(ctx, target.employeeId);
    const pick = (t: TaskView): boolean => {
      const c = classify(t, now, today);
      switch (q.tab) {
        case "today": return c.dueToday;
        case "pending": return t.status === "todo";
        case "overdue": return c.overdue;
        case "done": return t.status === "done";
      }
    };
    return { tasks: all.filter(pick).sort((x, y) => (x.dueAt?.toMillis() ?? Infinity) - (y.dueAt?.toMillis() ?? Infinity)).map((t) => view(t.id, t)), summary: summarizeTasks(all, now) };
  });

  // Recurring templates created by / visible to managers.
  app.get("/api/tasks/templates", pre, async (req) => {
    if (!isManager(req.actor) && !isAnyAdmin(req.actor)) throw forbidden();
    const team = new Set((await listScopedEmployees(ctx, req.actor)).map((e) => e.employeeId));
    const snaps = await ctx.db.collection("tasks").where("isTemplate", "==", true).get();
    return { templates: snaps.docs.filter((d) => team.has((d.data() as TaskDoc).assigneeId)).map((d) => view(d.id, d.data() as TaskDoc)) };
  });

  app.post("/api/tasks/:id/done", pre, async (req) => {
    const { id } = req.params as { id: string };
    const ref = ctx.db.collection("tasks").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Task");
    const t = snap.data() as TaskDoc;
    if (t.isTemplate) throw badRequest("TEMPLATE", "This is a recurring template, not a task.");
    const owner = t.assigneeId === req.actor.id;
    if (!owner && !canManage(req.actor, await getEmployee(ctx, t.assigneeId))) throw forbidden("Only the assignee can mark this done.");
    await ref.update({ status: "done", doneAt: Timestamp.fromDate(ctx.clock()) });
    return { ok: true };
  });

  app.post("/api/tasks/:id/reopen", pre, async (req) => {
    const { id } = req.params as { id: string };
    const ref = ctx.db.collection("tasks").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw notFound("Task");
    const t = snap.data() as TaskDoc;
    if (!canManage(req.actor, await getEmployee(ctx, t.assigneeId)) || t.assigneeId === req.actor.id) throw forbidden("Only a Manager can reopen a task.");
    await ref.update({ status: "todo", doneAt: null });
    await audit(ctx, { actorId: req.actor.id, action: "task.reopen", entity: "tasks", entityId: id, before: { status: t.status }, after: { status: "todo" } });
    return { ok: true };
  });

  // Manager dashboard: per team member + "No task right now" (punched in, zero open tasks).
  app.get("/api/tasks/team", pre, async (req) => {
    if (!isManager(req.actor) && !isAnyAdmin(req.actor)) throw forbidden();
    const now = ctx.clock();
    const today = dateIST(now);
    const team = (await listScopedEmployees(ctx, req.actor)).filter((e) => e.employeeId !== req.actor.id && e.status === "active");
    const members = [];
    const noTaskNow: Array<{ employeeId: string; name: string }> = [];
    for (const e of team) {
      const tasks = await tasksOf(ctx, e.employeeId);
      const att = await ctx.db.collection("attendance").doc(attendanceId(e.employeeId, today)).get();
      const a = att.exists ? (att.data() as AttendanceDoc) : null;
      const punchedIn = !!a?.punchInAt && !a.punchOutAt;
      members.push({ employeeId: e.employeeId, name: e.name, ...summarizeTasks(tasks, now) });
      if (punchedIn && !tasks.some((t) => t.status === "todo")) noTaskNow.push({ employeeId: e.employeeId, name: e.name });
    }
    return { members, noTaskNow };
  });
}
