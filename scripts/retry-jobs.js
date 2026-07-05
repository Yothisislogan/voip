import { config } from "../src/config.js";
import { log } from "../src/logger.js";
import { dueJobs, resolveJob, bumpJob } from "../src/jobs/deadletter.js";
import { handleInbound } from "../src/messaging/orchestrator.js";

/**
 * Dead-letter retry runner. Drains due jobs from failed_jobs with exponential
 * backoff. Run on a schedule (cron / systemd timer): `npm run retry-jobs`.
 *
 * NOTE: session-bound jobs (onUtterance / onCallComplete / screenPop) depend on
 * in-memory call state that only exists in the live server process, so they
 * cannot be replayed from a separate process — they will fail here and back off
 * until max_attempts, remaining visible for manual inspection. Stateless jobs
 * (handleInbound) replay cleanly. This is intentional: the DLQ's first job is to
 * make sure nothing is lost silently.
 */

const HANDLERS = {
  handleInbound: (payload) => handleInbound(payload.body),
  // Session-bound kinds have no replayable handler here (see note above).
};

async function main() {
  if (!config.databaseUrl) {
    log.warn("retry.no_db", { msg: "DATABASE_URL not set — nothing to retry" });
    return;
  }
  const jobs = await dueJobs(100);
  if (!jobs.length) {
    log.info("retry.idle", { due: 0 });
    return;
  }
  log.info("retry.start", { due: jobs.length });

  let ok = 0, failed = 0, skipped = 0;
  for (const job of jobs) {
    const handler = HANDLERS[job.kind];
    if (!handler) {
      skipped++;
      await bumpJob(job.id, job.attempts, "no replayable handler (session-bound job)");
      continue;
    }
    try {
      await handler(job.payload);
      await resolveJob(job.id);
      ok++;
      log.info("retry.ok", { id: job.id, kind: job.kind });
    } catch (err) {
      failed++;
      await bumpJob(job.id, job.attempts, err.message);
      log.warn("retry.failed", { id: job.id, kind: job.kind, attempts: job.attempts + 1, err: err.message });
    }
  }
  log.info("retry.done", { ok, failed, skipped });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error("retry.crashed", { err: err.message });
    process.exit(1);
  });
