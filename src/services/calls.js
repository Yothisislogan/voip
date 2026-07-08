import { db } from "../db.js";

/**
 * Map Twilio webhook events onto the Postgres CRM `calls` table
 * (db/migrations/0001+). Contact linking happens in the screen-pop path
 * (store/crm.js findOrCreateContactByPhone + recordCall), so these writers only
 * maintain the call row's lifecycle fields. All writes are best-effort: a DB
 * hiccup must never break the TwiML response that keeps the live call
 * connected, so errors are swallowed after logging.
 */

// Upsert a call row keyed on the Twilio Call SID.
export async function recordCall({ callSid, direction, from, to, status }) {
  if (!db.enabled || !callSid) return;
  try {
    await db.query(
      `INSERT INTO calls (twilio_call_sid, direction, status, from_e164, to_e164)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (twilio_call_sid) DO UPDATE
         SET status = EXCLUDED.status`,
      [callSid, direction, mapStatus(status) || status, from, to]
    );
  } catch (err) {
    console.error("recordCall failed:", err.message);
  }
}

// Apply a Twilio status callback to the call row.
export async function updateCallStatus({ callSid, status, durationSec }) {
  if (!db.enabled || !callSid) return;
  try {
    const mapped = mapStatus(status);
    await db.query(
      `UPDATE calls
         SET status           = COALESCE($2, status),
             answered_at      = CASE WHEN $2 = 'in_progress' AND answered_at IS NULL
                                     THEN now() ELSE answered_at END,
             ended_at         = CASE WHEN $2 IN ('completed','missed','failed','abandoned')
                                     THEN now() ELSE ended_at END,
             duration_seconds = COALESCE($3, duration_seconds)
       WHERE twilio_call_sid = $1`,
      [callSid, mapped, durationSec ?? null]
    );
  } catch (err) {
    console.error("updateCallStatus failed:", err.message);
  }
}

// Persist a completed recording's URL onto the call row. The consent/recording
// state transition is tracked separately (store/consent.js via the webhook).
export async function recordRecording({ callSid, url, durationSec }) {
  if (!db.enabled || !callSid || !url) return;
  try {
    await db.query(
      `UPDATE calls
         SET recording_url    = $2,
             duration_seconds = COALESCE(duration_seconds, $3)
       WHERE twilio_call_sid = $1`,
      [callSid, url, durationSec ?? null]
    );
  } catch (err) {
    console.error("recordRecording failed:", err.message);
  }
}

// Twilio call status -> our status vocabulary.
function mapStatus(twilioStatus) {
  switch (twilioStatus) {
    case "queued":
    case "initiated":
      return "queued";
    case "ringing":
      return "ringing";
    case "in-progress":
    case "answered":
      return "in_progress";
    case "completed":
      return "completed";
    case "no-answer":
      return "missed";
    case "busy":
    case "failed":
      return "failed";
    case "canceled":
      return "abandoned";
    default:
      return null;
  }
}
