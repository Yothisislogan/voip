import { db } from "../db.js";
import { log } from "../logger.js";

/**
 * Consent + recording state tracking. Two-party-consent states require proof of
 * disclosure/consent; this records both the current state on the call row and a
 * full transition history in consent_events. All best-effort (no-op without a DB).
 *
 * recording_state: none | recording | stopped | deleted
 * consent_state:   unknown | disclosed | granted | declined
 */

/** Record a consent/recording transition and update the call's current state. */
export async function recordConsentEvent({ callSid, contactId = null, kind, state, method = null, detail = null }) {
  if (!db.enabled) return;
  try {
    await db.query(
      `INSERT INTO consent_events (call_sid, contact_id, kind, state, method, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [callSid || null, contactId, kind, state, method, detail ? JSON.stringify(detail) : null]
    );

    // Roll the current-state columns forward on the call row.
    if (kind === "recording" || kind === "deletion") {
      await db.query(
        `UPDATE calls SET recording_state = $2 WHERE twilio_call_sid = $1`,
        [callSid, kind === "deletion" ? "deleted" : state]
      );
    } else if (kind === "consent" || kind === "disclosure") {
      await db.query(
        `UPDATE calls
           SET consent_state = $2,
               consent_at    = COALESCE(consent_at, now())
         WHERE twilio_call_sid = $1`,
        [callSid, state]
      );
    }
  } catch (err) {
    log.warn("consent.record_failed", { callSid, kind, err: err.message });
  }
}

/** Convenience: the IVR disclosure played at call start ("this call may be recorded"). */
export function recordDisclosure(callSid, contactId) {
  return recordConsentEvent({
    callSid,
    contactId,
    kind: "disclosure",
    state: "disclosed",
    method: "ivr_disclosure",
  });
}

/** Convenience: recording lifecycle transitions. */
export function recordRecordingState(callSid, state, method = null) {
  return recordConsentEvent({ callSid, kind: "recording", state, method });
}

/** Read the consent/recording state + history for a call. */
export async function getConsentForCall(callSid) {
  if (!db.enabled) return { state: null, events: [] };
  const call = (
    await db.query(
      `SELECT recording_state, consent_state, consent_at FROM calls WHERE twilio_call_sid = $1`,
      [callSid]
    )
  ).rows[0] || null;
  const events = (
    await db.query(`SELECT * FROM consent_events WHERE call_sid = $1 ORDER BY at ASC`, [callSid])
  ).rows;
  return { state: call, events };
}
