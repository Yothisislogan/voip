import { db } from "../db.js";
import { log } from "../logger.js";

/**
 * Dead-letter queue for async AI/webhook work. When a fire-and-forget job
 * (transcript persistence, recap, screen-pop, inbound message handling) throws,
 * we stash enough to re-run it in failed_jobs instead of losing it. A retry
 * runner (scripts/retry-jobs.js) drains it with exponential backoff.
 */

// Backoff schedule (minutes) by attempt number. Capped at the last value.
const BACKOFF_MIN = [1, 5, 15, 60, 240];

/** Record a failed job. Best-effort — the DLQ itself must never throw upward. */
export async function recordFailedJob({ kind, payload, error, maxAttempts = 5 }) {
  log.error("job.failed", { kind, err: error });
  if (!db.enabled) return;
  try {
    await db.query(
      `INSERT INTO failed_jobs (kind, payload, error, max_attempts)
       VALUES ($1,$2,$3,$4)`,
      [kind, JSON.stringify(payload ?? {}), String(error || "").slice(0, 2000), maxAttempts]
    );
  } catch (err) {
    log.warn("dlq.insert_failed", { kind, err: err.message });
  }
}

/**
 * Wrap a fire-and-forget async job so any throw lands in the DLQ.
 *   runTracked("onCallComplete", { callSid }, () => onCallComplete(callSid))
 */
export function runTracked(kind, payload, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((err) => recordFailedJob({ kind, payload, error: err.message }));
}

/** Fetch due, unresolved jobs (for the retry runner). */
export async function dueJobs(limit = 50) {
  if (!db.enabled) return [];
  const { rows } = await db.query(
    `SELECT * FROM failed_jobs
      WHERE resolved_at IS NULL
        AND attempts < max_attempts
        AND next_retry_at <= now()
      ORDER BY next_retry_at ASC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Mark a job resolved (a retry succeeded). */
export async function resolveJob(id) {
  if (!db.enabled) return;
  await db.query(`UPDATE failed_jobs SET resolved_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

/** Record a retry failure: bump attempts and schedule the next attempt. */
export async function bumpJob(id, attempts, error) {
  if (!db.enabled) return;
  const delayMin = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
  await db.query(
    `UPDATE failed_jobs
        SET attempts = attempts + 1,
            error = $2,
            updated_at = now(),
            next_retry_at = now() + ($3 || ' minutes')::interval
      WHERE id = $1`,
    [id, String(error || "").slice(0, 2000), String(delayMin)]
  );
}
