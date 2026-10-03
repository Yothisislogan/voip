import pg from "pg";
import { config } from "../src/config.js";
import { log } from "../src/logger.js";
import { client as twilioClient } from "../src/twilio.js";
import { recordConsentEvent } from "../src/store/consent.js";

/**
 * Data-retention purge. Deletes PII older than the configured windows:
 *
 *   RETENTION_TRANSCRIPT_DAYS   → transcript_segments
 *   RETENTION_RECORDING_DAYS    → recording_url on calls (+ optional Twilio-side
 *                                 recording deletion when
 *                                 RETENTION_DELETE_TWILIO_RECORDINGS=true)
 *   RETENTION_AUDIT_DAYS        → audit_log (keep long for compliance; 0 = forever)
 *
 * 0 (the default) means "keep forever" for that class. Run on a schedule:
 * `npm run purge-retention`. Idempotent and safe to re-run.
 */

const { transcriptDays, recordingDays, auditDays, messageDays, jobDays, deleteTwilioRecordings } = config.retention;

async function main() {
  if (!config.databaseUrl) {
    log.warn("purge.no_db", { msg: "DATABASE_URL not set — nothing to purge" });
    return;
  }
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    if (messageDays > 0) await c.query(`DELETE FROM conversation_messages WHERE created_at<now()-$1*interval '1 day'`, [messageDays]);
    if (jobDays > 0) await c.query(`UPDATE service_jobs SET payload='{}'::jsonb WHERE state='done'
      AND updated_at<now()-$1*interval '1 day'`, [jobDays]);
    if (transcriptDays > 0) {
      const r = await c.query(
        `DELETE FROM transcript_segments WHERE spoken_at < now() - ($1 || ' days')::interval`,
        [String(transcriptDays)]
      );
      log.info("purge.transcripts", { olderThanDays: transcriptDays, deleted: r.rowCount });
    }

    if (recordingDays > 0) {
      const { rows } = await c.query(
        `SELECT recording_sid,call_sid,url FROM call_recordings
          WHERE created_at < now() - ($1 || ' days')::interval AND status <> 'deleted'`,
        [String(recordingDays)]
      );
      let twilioDeleted = 0;
      for (const row of rows) {
        let providerDeleted = false;
        if (deleteTwilioRecordings && twilioClient) {
          try {
            await twilioClient.recordings(row.recording_sid).remove();
            providerDeleted = true;
            twilioDeleted++;
          } catch (err) {
            if (err.status === 404) providerDeleted = true;
            else log.warn("purge.twilio_delete_failed", { sid: row.recording_sid, err: err.message });
          }
        }
        // Expire local playback immediately. Keep the SID so failed provider
        // deletions are retried on the next run, including every transfer leg.
        await c.query('UPDATE call_recordings SET url=NULL,status=$2 WHERE recording_sid=$1',
          [row.recording_sid, providerDeleted ? 'deleted' : 'expired']);
        await recordConsentEvent({ callSid: row.call_sid, kind: 'deletion', state: 'deleted',
          method: 'retention', detail: { providerDeleted } });
      }
      // Legacy calls without a recording row retain their original cleanup path.
      const legacy = (await c.query(`SELECT twilio_call_sid,recording_url FROM calls
        WHERE recording_url IS NOT NULL AND created_at<now()-($1 || ' days')::interval
          AND NOT EXISTS(SELECT 1 FROM call_recordings r WHERE r.call_sid=calls.twilio_call_sid)`, [String(recordingDays)])).rows;
      for (const row of legacy) {
        const sid = extractRecordingSid(row.recording_url);
        if (deleteTwilioRecordings && twilioClient && sid) {
          try { await twilioClient.recordings(sid).remove(); twilioDeleted++; }
          catch (err) { if (err.status !== 404) { log.warn('purge.twilio_delete_failed', { sid }); continue; } }
        }
        await c.query("UPDATE calls SET recording_url=NULL,recording_state='deleted' WHERE twilio_call_sid=$1", [row.twilio_call_sid]);
      }
      await c.query(`UPDATE calls SET recording_url=NULL,recording_state='deleted'
        WHERE created_at<now()-($1 || ' days')::interval
          AND EXISTS(SELECT 1 FROM call_recordings r WHERE r.call_sid=calls.twilio_call_sid)`, [String(recordingDays)]);
      log.info('purge.recordings', { olderThanDays: recordingDays, processed: rows.length + legacy.length, twilioDeleted });
    }

    if (auditDays > 0) {
      const r = await c.query(
        `DELETE FROM audit_log WHERE at < now() - ($1 || ' days')::interval`,
        [String(auditDays)]
      );
      log.info("purge.audit", { olderThanDays: auditDays, deleted: r.rowCount });
    }

    if (!transcriptDays && !recordingDays && !auditDays && !messageDays && !jobDays) {
      log.info("purge.noop", { msg: "no retention windows configured (all 0)" });
    }
  } finally {
    await c.end();
  }
}

// Twilio RecordingUrl looks like .../Recordings/RE0123... — pull the RE… SID.
function extractRecordingSid(url) {
  const m = String(url).match(/\/(RE[0-9a-f]{32})/i);
  return m ? m[1] : null;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error("purge.crashed", { err: err.message });
    process.exit(1);
  });
