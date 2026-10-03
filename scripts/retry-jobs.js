import { config } from "../src/config.js";
import { log } from "../src/logger.js";
import { dueJobs, resolveJob, bumpJob } from "../src/jobs/deadletter.js";
import { handleInbound } from "../src/messaging/orchestrator.js";
import { sendWitnextEvent } from "../src/integrations/witnext.js";
import { doScreenPop, onCallComplete, onUtterance } from '../src/realtime/orchestrator.js';

/**
 * Dead-letter retry runner. Drains due jobs from failed_jobs with exponential
 * backoff. Run on a schedule (cron / systemd timer): `npm run retry-jobs`.
 *
 * Legacy failed_jobs only. New service_jobs are drained by the server worker.
 * Voice handlers now reconstruct durable call context from PostgreSQL.
 */

const HANDLERS = {
  screenPop: ({ callSid }) => doScreenPop(callSid),
  onCallComplete: ({ callSid }) => onCallComplete(callSid),
  onUtterance: ({ callSid, track, transcript }) => onUtterance(callSid, track, transcript),
  handleInbound: (payload) => handleInbound(payload.body),
  // WiTNext deliveries replay with their ORIGINAL event_id so the receiver
  // dedupes; timestamp/nonce/signature are regenerated per attempt.
  witnextEvent: (payload) => {
    if (!config.witnext.enabled) throw new Error('WiTnext bridge disabled; delivery remains pending');
    return sendWitnextEvent(payload.eventType, payload.payload, {
      eventId: payload.eventId,
      occurredAt: payload.occurredAt,
    });
  },
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
      await bumpJob(job.id, job.attempts, "no registered replay handler");
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
