import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { log } from '../logger.js';

// Persist before acknowledging a webhook. Dedupe keys belong to the business
// event, not the HTTP attempt. Refresh is only for recomputable recap jobs.
export async function enqueueJob(kind, key, payload, { delayMs = 0, refresh = false, connection = db } = {}) {
  if (!db.enabled) throw new Error('Durable jobs require DATABASE_URL');
  await connection.query(
    `INSERT INTO service_jobs(kind, job_key, payload, run_after)
     VALUES ($1,$2,$3,now() + $4 * interval '1 millisecond')
     ON CONFLICT(job_key) DO UPDATE SET
       payload = CASE WHEN $5 THEN EXCLUDED.payload ELSE service_jobs.payload END,
       requested_at = CASE WHEN $5 THEN now() ELSE service_jobs.requested_at END,
       state = CASE WHEN $5 AND service_jobs.state IN ('done','failed') THEN 'pending' ELSE service_jobs.state END,
       attempts = CASE WHEN $5 AND service_jobs.state IN ('done','failed') THEN 0 ELSE service_jobs.attempts END,
       run_after = CASE WHEN $5 THEN EXCLUDED.run_after ELSE service_jobs.run_after END,
       updated_at = now()`,
    [kind, key, JSON.stringify(payload), delayMs, refresh]
  );
}

export async function claimJob(kinds = null) {
  const token = randomUUID();
  const { rows } = await db.query(
    `UPDATE service_jobs SET state='running', attempts=attempts+1,
       lease_until=now()+interval '5 minutes', lease_token=$1, claimed_at=now(), updated_at=now()
     WHERE id=(SELECT id FROM service_jobs
       WHERE ((state='pending' AND run_after<=now()) OR (state='running' AND lease_until<now()))
         AND attempts < max_attempts AND ($2::text[] IS NULL OR kind=ANY($2))
       ORDER BY run_after,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [token, kinds]
  );
  return rows[0] || null;
}

export async function finishJob(job, error) {
  // Lease token fences a stale worker from marking a reclaimed job complete.
  await db.query(
    `UPDATE service_jobs SET
       state=CASE WHEN $3::text IS NOT NULL THEN CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END
                  WHEN requested_at>claimed_at THEN 'pending' ELSE 'done' END,
       error=$3, lease_until=NULL, lease_token=NULL, updated_at=now(),
       run_after=CASE WHEN $3::text IS NOT NULL THEN now()+$4 * interval '1 second' ELSE run_after END
     WHERE id=$1 AND lease_token=$2`,
    [job.id, job.lease_token, error ? String(error.message || error).slice(0, 1000) : null,
      Math.min(3600, 5 * 2 ** Math.min(job.attempts, 10))]
  );
}

export async function drainJobs(handlers, limit = 20) {
  if (!db.enabled) return 0;
  // Recover exhausted jobs left running if the process died on its last try.
  await db.query(`UPDATE service_jobs SET state='failed', error='Worker lease expired on final attempt'
    WHERE state='running' AND lease_until<now() AND attempts>=max_attempts`);
  let count = 0;
  while (count < limit) {
    const job = await claimJob(Object.keys(handlers));
    if (!job) break;
    const heartbeat = setInterval(() => {
      db.query(`UPDATE service_jobs SET lease_until=now()+interval '5 minutes'
        WHERE id=$1 AND lease_token=$2 AND state='running'`, [job.id, job.lease_token])
        .catch(error => log.error('service.lease_renewal_failed', { id: job.id, err: error.message }));
    }, 30000);
    heartbeat.unref();
    try {
      if (!handlers[job.kind]) throw new Error(`No handler for ${job.kind}`);
      await handlers[job.kind](job.payload);
      await finishJob(job);
    } catch (error) {
      await finishJob(job, error);
      log.warn('service.job_failed', { id: job.id, kind: job.kind, attempt: job.attempts, err: error.message });
    } finally {
      clearInterval(heartbeat);
    }
    count++;
  }
  return count;
}

export function startWorker(handlers, intervalMs = 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await drainJobs(handlers); }
    catch (error) { log.error('service.worker_failed', { err: error.message }); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
