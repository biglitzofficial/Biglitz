import { JOB_DEFS, dueSlot, jobRunId, type JobDef } from "@biglitz/shared";
import type { JobHandler } from "./jobs.js";

/** Atomically claims a job slot. Returns false if it was already claimed. */
export interface JobRunStore {
  claim(id: string, data: { jobName: string; slot: string; startedAt: Date }): Promise<boolean>;
  finish(id: string, data: { status: "done" | "failed"; error?: string; finishedAt: Date }): Promise<void>;
}

export interface RunResult {
  job: string;
  slot: string;
  outcome: "ran" | "skipped-already-run" | "failed";
}

export async function runDueJobs(
  now: Date,
  store: JobRunStore,
  handlers: Record<string, JobHandler>,
  defs: readonly JobDef[] = JOB_DEFS,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const def of defs) {
    const slot = dueSlot(def, now);
    if (!slot) continue;
    const id = jobRunId(def.name, slot);
    const claimed = await store.claim(id, { jobName: def.name, slot, startedAt: now });
    if (!claimed) {
      results.push({ job: def.name, slot, outcome: "skipped-already-run" });
      continue;
    }
    const handler = handlers[def.name];
    try {
      if (!handler) throw new Error(`No handler registered for job ${def.name}`);
      await handler({ slot, now });
      await store.finish(id, { status: "done", finishedAt: new Date() });
      results.push({ job: def.name, slot, outcome: "ran" });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[job:${def.name}] failed: ${error}`);
      await store.finish(id, { status: "failed", error, finishedAt: new Date() });
      results.push({ job: def.name, slot, outcome: "failed" });
    }
  }
  return results;
}
