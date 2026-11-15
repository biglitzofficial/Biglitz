import { describe, expect, it, vi } from "vitest";
import { runDueJobs, type JobRunStore } from "./runner.js";

function memoryStore(): JobRunStore & { ids: Set<string> } {
  const ids = new Set<string>();
  return {
    ids,
    async claim(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    },
    async finish() {},
  };
}

describe("runDueJobs (idempotency)", () => {
  it("running the dispatcher twice in a row never runs a job twice", async () => {
    const store = memoryStore();
    const handler = vi.fn(async () => {});
    const handlers = {
      lateAlerts: handler,
      morningSummary: handler,
      followUpReminder: handler,
      recurringTasks: handler,
      dayClose: handler,
      payrollDraft: handler,
      monthlyRewards: handler,
    };
    const now = new Date("2026-12-01T05:00:00Z"); // 10:30 IST on the 1st: every job is due
    const first = await runDueJobs(now, store, handlers);
    const callsAfterFirst = handler.mock.calls.length;
    const second = await runDueJobs(now, store, handlers);

    expect(first.every((r) => r.outcome === "ran")).toBe(true);
    expect(callsAfterFirst).toBe(7);
    expect(second.every((r) => r.outcome === "skipped-already-run")).toBe(true);
    expect(handler.mock.calls.length).toBe(callsAfterFirst);
  });

  it("records a failure and continues with the other jobs", async () => {
    const store = memoryStore();
    const results = await runDueJobs(new Date("2026-11-16T05:00:00Z"), store, {
      dayClose: async () => {
        throw new Error("boom");
      },
      morningSummary: async () => {},
    });
    expect(results.find((r) => r.job === "dayClose")?.outcome).toBe("failed");
    expect(results.find((r) => r.job === "morningSummary")?.outcome).toBe("ran");
  });
});
