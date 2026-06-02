import { db } from "../db.js";

/**
 * These map Twilio webhook events onto the wit_connect_schema.sql tables.
 * All writes are best-effort: a DB hiccup must never break the TwiML
 * response that keeps the live call connected, so callers swallow errors.
 */

// Find an existing customer by phone, or create a lightweight stub.
// Uses INSERT … ON CONFLICT to avoid a race condition when two concurrent
// calls arrive from the same new number.
async function findOrCreateCustomer(e164) {
  if (!db.enabled || !e164) return null;
  await db.query(
    "INSERT INTO customers (primary_phone) VALUES ($1) ON CONFLICT (primary_phone) DO NOTHING",
    [e164]
  );
  const r = await db.query(
    "SELECT id FROM customers WHERE primary_phone = $1 LIMIT 1",
    [e164]
  );
  return r.rows[0]?.id || null;
}

// Resolve a WIT phone_numbers row from the dialed E.164.
async function findPhoneNumberId(e164) {
  if (!db.enabled || !e164) return null;
  const r = await db.query(
    "SELECT id FROM phone_numbers WHERE e164 = $1 LIMIT 1",
    [e164]
  );
  return r.rows[0]?.id || null;
}

// Upsert a call row keyed on the Twilio Call SID.
export async function recordCall({ callSid, direction, from, to, status }) {
  if (!db.enabled) return;
  try {
    const customerId =
      direction === "inbound"
        ? await findOrCreateCustomer(from)
        : await findOrCreateCustomer(to);
    const phoneNumberId = await findPhoneNumberId(
      direction === "inbound" ? to : from
    );

    await db.query(
      `INSERT INTO calls
         (twilio_call_sid, direction, status, from_e164, to_e164,
          phone_number_id, customer_id, queued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (twilio_call_sid) DO UPDATE
         SET status = EXCLUDED.status`,
      [callSid, direction, status, from, to, phoneNumberId, customerId]
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
         SET status      = COALESCE($2, status),
             answered_at = CASE WHEN $2 = 'in_progress' THEN now() ELSE answered_at END,
             ended_at    = CASE WHEN $2 IN ('completed','missed','failed','abandoned')
                                THEN now() ELSE ended_at END,
             talk_seconds= COALESCE($3, talk_seconds)
       WHERE twilio_call_sid = $1`,
      [callSid, mapped, durationSec ?? null]
    );
  } catch (err) {
    console.error("updateCallStatus failed:", err.message);
  }
}

// Persist a completed recording.
export async function recordRecording({ callSid, recordingSid, url, durationSec }) {
  if (!db.enabled || !callSid) return;
  try {
    const call = await db.query(
      "SELECT id FROM calls WHERE twilio_call_sid = $1 LIMIT 1",
      [callSid]
    );
    const callId = call.rows[0]?.id;
    if (!callId) return;

    await db.query(
      `INSERT INTO call_recordings
         (call_id, twilio_recording_sid, storage_url, duration_seconds,
          consent, retention_status, retention_until)
       VALUES ($1,$2,$3,$4,'disclosed','active', (now() + interval '13 months')::date)
       ON CONFLICT (twilio_recording_sid) DO NOTHING`,
      [callId, recordingSid, url, durationSec ?? null]
    );
  } catch (err) {
    console.error("recordRecording failed:", err.message);
  }
}

// Twilio call status -> schema call_status enum.
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
