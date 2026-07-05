import { db } from "../db.js";

/**
 * Postgres CRM store — the app's operational data layer (contacts/leads, calls,
 * transcript segments, call scores, surveys, email intake). Every function is
 * best-effort and no-ops when DATABASE_URL is unset (db.enabled === false), so a
 * missing database never breaks a live call. See db/schema.sql.
 */

export const crmDbEnabled = db.enabled;

// Columns AI extraction / manual edits may write to a contact.
const CONTACT_FIELDS = new Set([
  "first_name", "last_name", "email", "company", "title",
  "lifecycle_stage", "source", "policy_type", "carrier", "premium",
  "policy_number", "effective_date", "renewal_date", "coverage_status",
  "address", "notes",
]);

// ── contacts / leads ──────────────────────────────────────────────
/** Upsert a contact by phone; bumps last_contacted_at. Returns the row or null. */
export async function findOrCreateContactByPhone(e164, { source } = {}) {
  if (!db.enabled || !e164) return null;
  try {
    const r = await db.query(
      `INSERT INTO contacts (phone_e164, source)
         VALUES ($1, $2)
       ON CONFLICT (phone_e164) DO UPDATE SET last_contacted_at = now()
       RETURNING *`,
      [e164, source || null]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error("findOrCreateContactByPhone failed:", err.message);
    return null;
  }
}

/** Insert a new contact from whitelisted fields (used for email leads with no phone). */
export async function createContact(fields = {}) {
  if (!db.enabled) return null;
  const cols = ["phone_e164", ...CONTACT_FIELDS].filter(
    (c) => fields[c] !== undefined && fields[c] !== null && fields[c] !== ""
  );
  if (!cols.length) return null;
  try {
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const values = cols.map((c) => fields[c]);
    const r = await db.query(
      `INSERT INTO contacts (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
      values
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error("createContact failed:", err.message);
    return null;
  }
}

export async function getContactByPhone(e164) {
  if (!db.enabled || !e164) return null;
  try {
    const r = await db.query("SELECT * FROM contacts WHERE phone_e164 = $1 LIMIT 1", [e164]);
    return r.rows[0] || null;
  } catch (err) {
    console.error("getContactByPhone failed:", err.message);
    return null;
  }
}

/** Update whitelisted contact columns. Ignores unknown/empty fields. Returns the row. */
export async function updateContactFields(contactId, fields = {}) {
  if (!db.enabled || !contactId) return null;
  const entries = Object.entries(fields).filter(
    ([k, v]) => CONTACT_FIELDS.has(k) && v !== undefined && v !== null && v !== ""
  );
  if (!entries.length) return null;
  try {
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`);
    const values = entries.map(([, v]) => v);
    const r = await db.query(
      `UPDATE contacts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      [contactId, ...values]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error("updateContactFields failed:", err.message);
    return null;
  }
}

/** Shape a contact row for the agent UI (matches the ERPNext screen-pop shape). */
export function shapeContactForUi(row) {
  if (!row) return null;
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ");
  return {
    id: row.id,
    doctype: "Contact",
    fullName: full || "(no name)",
    accountName: row.company || "",
    title: row.title || "",
    email: row.email || "",
    phone: row.phone_e164 || "",
    policyType: row.policy_type || "",
    carrier: row.carrier || "",
    lifecycleStage: row.lifecycle_stage || "lead",
    url: null,
  };
}

// ── calls ─────────────────────────────────────────────────────────
export async function recordCall({ callSid, contactId, direction, from, to, status }) {
  if (!db.enabled || !callSid) return;
  try {
    await db.query(
      `INSERT INTO calls (twilio_call_sid, contact_id, direction, from_e164, to_e164, status)
         VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (twilio_call_sid) DO UPDATE
         SET status = EXCLUDED.status,
             contact_id = COALESCE(calls.contact_id, EXCLUDED.contact_id)`,
      [callSid, contactId || null, direction || null, from || null, to || null, status || null]
    );
  } catch (err) {
    console.error("recordCall failed:", err.message);
  }
}

export async function completeCall({ callSid, durationSeconds, recordingUrl }) {
  if (!db.enabled || !callSid) return;
  try {
    await db.query(
      `UPDATE calls
         SET status = 'completed', ended_at = now(),
             duration_seconds = COALESCE($2, duration_seconds),
             recording_url = COALESCE($3, recording_url)
       WHERE twilio_call_sid = $1`,
      [callSid, durationSeconds ?? null, recordingUrl || null]
    );
  } catch (err) {
    console.error("completeCall failed:", err.message);
  }
}

// ── transcript_segments ───────────────────────────────────────────
export async function insertTranscriptSegment({ callSid, contactId, seq, speaker, text }) {
  if (!db.enabled || !callSid || !text) return;
  try {
    await db.query(
      `INSERT INTO transcript_segments (call_sid, contact_id, seq, speaker, text)
         VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (call_sid, seq) DO NOTHING`,
      [callSid, contactId || null, seq, speaker, text]
    );
  } catch (err) {
    console.error("insertTranscriptSegment failed:", err.message);
  }
}

// ── call_scores ───────────────────────────────────────────────────
export async function insertCallScore({ callSid, contactId, score, sentiment, outcome, factors, summary }) {
  if (!db.enabled || !callSid) return;
  try {
    await db.query(
      `INSERT INTO call_scores (call_sid, contact_id, score, sentiment, outcome, factors, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (call_sid) DO UPDATE
         SET score = EXCLUDED.score, sentiment = EXCLUDED.sentiment,
             outcome = EXCLUDED.outcome, factors = EXCLUDED.factors, summary = EXCLUDED.summary`,
      [callSid, contactId || null, score ?? null, sentiment || null, outcome || null,
       JSON.stringify(factors || []), summary || null]
    );
  } catch (err) {
    console.error("insertCallScore failed:", err.message);
  }
}

// ── surveys ───────────────────────────────────────────────────────
export async function createSurvey({ callSid, contactId, conversationId, question, channel = "sms" }) {
  if (!db.enabled) return null;
  try {
    const r = await db.query(
      `INSERT INTO surveys (call_sid, contact_id, conversation_id, question, channel)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [callSid || null, contactId || null, conversationId || null, question || null, channel]
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error("createSurvey failed:", err.message);
    return null;
  }
}

/** Most recent still-open survey for a contact (to attach an inbound reply to). */
export async function findOpenSurveyByContact(contactId) {
  if (!db.enabled || !contactId) return null;
  try {
    const r = await db.query(
      `SELECT * FROM surveys WHERE contact_id = $1 AND status = 'sent'
         ORDER BY sent_at DESC LIMIT 1`,
      [contactId]
    );
    return r.rows[0] || null;
  } catch (err) {
    console.error("findOpenSurveyByContact failed:", err.message);
    return null;
  }
}

export async function recordSurveyResponse({ surveyId, rating, responseText }) {
  if (!db.enabled || !surveyId) return;
  try {
    await db.query(
      `UPDATE surveys
         SET status = 'responded', responded_at = now(),
             rating = COALESCE($2, rating), response_text = $3
       WHERE id = $1`,
      [surveyId, rating ?? null, responseText || null]
    );
  } catch (err) {
    console.error("recordSurveyResponse failed:", err.message);
  }
}

// ── email_intake ──────────────────────────────────────────────────
export async function insertEmailIntake({ messageId, fromEmail, fromName, subject, body, phone, contactId, parsed }) {
  if (!db.enabled) return null;
  try {
    const r = await db.query(
      `INSERT INTO email_intake (message_id, from_email, from_name, subject, body, phone_e164, contact_id, parsed)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [messageId || null, fromEmail || null, fromName || null, subject || null,
       body || null, phone || null, contactId || null, JSON.stringify(parsed || {})]
    );
    return r.rows[0]?.id || null;
  } catch (err) {
    console.error("insertEmailIntake failed:", err.message);
    return null;
  }
}
