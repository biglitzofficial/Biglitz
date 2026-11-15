import { Timestamp } from "firebase-admin/firestore";
import { daysInMonth, dayOfMonth, minutesOfDayIST, weekdayOf, type Repeat } from "@biglitz/shared";
import type { AppContext } from "../context.js";

export interface TaskDoc {
  title: string;
  description: string;
  assigneeId: string;
  assignedBy: string;
  businessId: string;
  dueAt: Timestamp | null;
  priority: "low" | "normal" | "high";
  status: "todo" | "done";
  repeat: Repeat;
  isTemplate: boolean;
  templateId: string | null;
  occurrenceDate: string | null;
  createdAt: Timestamp;
  doneAt: Timestamp | null;
}

/** Does a repeat rule produce an occurrence on `date` (YYYY-MM-DD)? */
export function repeatMatches(repeat: Repeat, date: string): boolean {
  const month = date.slice(0, 7);
  const dom = dayOfMonth(date);
  switch (repeat.kind) {
    case "none":
      return false;
    case "daily":
      return true;
    case "weekly":
      return weekdayOf(date) === repeat.weekday;
    case "monthly":
      // Months shorter than N use their last day.
      return dom === Math.min(repeat.day, daysInMonth(month));
    case "monthEnd":
      return dom === daysInMonth(month);
  }
}

/** Due time on `date` = same IST time-of-day as the template's dueAt (none if template has no due time). */
function occurrenceDue(template: TaskDoc, date: string): Timestamp | null {
  if (!template.dueAt) return null;
  const minutes = minutesOfDayIST(template.dueAt.toDate());
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Timestamp.fromMillis(Date.UTC(y, m - 1, d, 0, minutes) - 330 * 60_000);
}

/** Creates occurrences for `date`. Deterministic ids make it idempotent. Returns the number created. */
export async function generateRecurringFor(ctx: AppContext, date: string, onlyTemplateId?: string): Promise<number> {
  const snaps = await ctx.db.collection("tasks").where("isTemplate", "==", true).get();
  let created = 0;
  for (const t of snaps.docs) {
    if (onlyTemplateId && t.id !== onlyTemplateId) continue;
    const tpl = t.data() as TaskDoc;
    if (!repeatMatches(tpl.repeat, date)) continue;
    const assignee = await ctx.db.collection("employees").doc(tpl.assigneeId).get();
    const a = assignee.data() as { status: string; exitDate: string | null } | undefined;
    if (!a || a.status === "exited" || (a.exitDate && date > a.exitDate)) continue;
    const ref = ctx.db.collection("tasks").doc(`${t.id}_${date}`);
    const occurrence: TaskDoc = {
      ...tpl,
      isTemplate: false,
      templateId: t.id,
      occurrenceDate: date,
      status: "todo",
      dueAt: occurrenceDue(tpl, date),
      createdAt: Timestamp.fromDate(ctx.clock()),
      doneAt: null,
      repeat: { kind: "none" },
    };
    try {
      await ref.create(occurrence);
      created++;
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (code !== 6 && code !== "already-exists") throw err;
    }
  }
  return created;
}
