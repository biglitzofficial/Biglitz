import { buildContext } from "../bootstrap.js";
import { buildHandlers } from "./jobs.js";
import { runDueJobs, type JobRunStore } from "./runner.js";

export function firestoreJobStore(db: FirebaseFirestore.Firestore): JobRunStore {
  return {
    async claim(id, data) {
      try {
        // create() fails if the doc exists, so two dispatchers can never both claim a slot.
        await db.collection("jobRuns").doc(id).create({ ...data, status: "running" });
        return true;
      } catch (err) {
        const code = (err as { code?: number | string }).code;
        if (code === 6 || code === "already-exists") return false;
        throw err;
      }
    },
    async finish(id, data) {
      await db.collection("jobRuns").doc(id).update(data);
    },
  };
}

// Railway cron: run once and exit.
const ctx = buildContext();
runDueJobs(ctx.clock(), firestoreJobStore(ctx.db), buildHandlers(ctx))
  .then((results) => {
    console.log(JSON.stringify({ dispatcher: "done", results }));
    process.exit(results.some((r) => r.outcome === "failed") ? 1 : 0);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
