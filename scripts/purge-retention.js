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

const { transcriptDays, recordingDays, auditDays, deleteTwilioRecordings } = config.retention;

async function main() {
  if (!config.databaseUrl) {
    log.warn("purge.no_db", { msg: "DATABASE_URL not set — nothing to purge" });
    return;
  }
  const c = new pg.Client({ connectionString: config.databaseUrl });
  await c.connect();
  try {
    if (transcriptDays > 0) {
      const r = await c.query(
        `DELETE FROM transcript_segments WHERE spoken_at < now() - ($1 || ' days')::interval`,
        [String(transcriptDays)]
      );
      log.info("purge.transcripts", { olderThanDays: transcriptDays, deleted: r.rowCount });
    }

    if (recordingDays > 0) {
      // Find calls whose recordings are past retention and still referenced.
      const { rows } = await c.query(
        `SELECT twilio_call_sid, recording_url
           FROM calls
          WHERE recording_url IS NOT NULL
            AND created_at < now() - ($1 || ' days')::interval`,
        [String(recordingDays)]
      );
      let twilioDeleted = 0;
      for (const row of rows) {
        if (deleteTwilioRecordings && twilioClient) {
          const sid = extractRecordingSid(row.recording_url);
          if (sid) {
            try {
              await twilioClient.recordings(sid).remove();
              twilioDeleted++;
            } catch (err) {
              log.warn("purge.twilio_delete_failed", { sid, err: err.message });
            }
          }
        }
        await recordConsentEvent({
          callSid: row.twilio_call_sid,
          kind: "deletion",
          state: "deleted",
          method: "retention",
        });
      }
      const r = await c.query(
        `UPDATE calls
            SET recording_url = NULL, recording_state = 'deleted'
          WHERE recording_url IS NOT NULL
            AND created_at < now() - ($1 || ' days')::interval`,
        [String(recordingDays)]
      );
      log.info("purge.recordings", {
        olderThanDays: recordingDays,
        cleared: r.rowCount,
        twilioDeleted,
        twilioDeletionEnabled: deleteTwilioRecordings,
      });
    }

    if (auditDays > 0) {
      const r = await c.query(
        `DELETE FROM audit_log WHERE at < now() - ($1 || ' days')::interval`,
        [String(auditDays)]
      );
      log.info("purge.audit", { olderThanDays: auditDays, deleted: r.rowCount });
    }

    if (!transcriptDays && !recordingDays && !auditDays) {
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
