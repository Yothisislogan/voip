import { db } from '../db.js';
import { config } from '../config.js';
import { normalizePhone } from '../util/phone.js';
import { isSharedNumber, callPayload, loadCall } from './call-state.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { enqueueJob } from '../jobs/queue.js';

// Time proximity proposes a candidate, never proves a person's identity.
// An exact provider call ID or verified real phone is authoritative. A shared
// transfer line is explicitly excluded from every customer phone comparison.
export function chooseLead(call, candidates) {
  const usable = candidates.filter(c => !c.claimed_call_sid || c.claimed_call_sid === call.twilio_call_sid);
  const exact = usable.filter(c => c.provider_call_id === call.twilio_call_sid ||
    (call.customer_number && !isSharedNumber(call.customer_number) && c.customer_phone === call.customer_number));
  if (exact.length === 1) return { state: 'matched', candidate: exact[0], reason: 'verified_identifier' };
  if (exact.length > 1) return { state: 'ambiguous', candidates: exact, reason: 'multiple_identifier_matches' };
  const windowMs = config.voice.matchWindowMinutes * 60000;
  const recent = usable.filter(c => c.source === 'smartfinancial' &&
    Math.abs(new Date(c.received_at) - new Date(call.created_at)) <= windowMs &&
    (!c.destination_number || c.destination_number === call.to_e164) &&
    (!c.agent_identity || !call.agent_identity || c.agent_identity === call.agent_identity))
    .sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
  if (recent.length === 1) return { state: 'suggested', candidate: recent[0], reason: 'recent_email_needs_confirmation' };
  return { state: recent.length ? 'ambiguous' : 'awaiting_lead', candidates: recent, reason: recent.length ? 'overlapping_leads' : 'no_email_yet' };
}

export async function upsertLeadSignal(input) {
  if (!db.enabled) throw new Error('Lead signals require the database');
  if (!input.source_id || String(input.source_id).length > 400) throw Object.assign(new Error('source_id is required (maximum 400 characters)'), { status: 400 });
  const phone = normalizePhone(input.customer_phone || '');
  const destination = normalizePhone(input.destination_number || '');
  for (const [raw, normalized] of [[input.customer_phone, phone], [input.destination_number, destination]]) {
    if (raw && !/^\+[1-9]\d{7,14}$/.test(normalized)) throw Object.assign(new Error('Phone numbers must be valid international numbers'), { status: 400 });
  }
  if (phone && isSharedNumber(phone)) throw Object.assign(new Error('A transfer number cannot be a customer phone'), { status: 400 });
  const received = input.received_at ? new Date(input.received_at) : new Date();
  if (!Number.isFinite(received.getTime()) || received.getTime() > Date.now() + 60000) throw Object.assign(new Error('Invalid received_at'), { status: 400 });
  const text = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) || null : null;
  const { rows } = await db.query(`INSERT INTO lead_signals(source,source_id,customer_phone,customer_email,customer_name,
    business_name,destination_number,agent_identity,provider_call_id,received_at,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(source,source_id) DO UPDATE SET
      customer_phone=coalesce(EXCLUDED.customer_phone,lead_signals.customer_phone),
      customer_email=coalesce(EXCLUDED.customer_email,lead_signals.customer_email),
      customer_name=coalesce(EXCLUDED.customer_name,lead_signals.customer_name),
      business_name=coalesce(EXCLUDED.business_name,lead_signals.business_name),
      provider_call_id=coalesce(EXCLUDED.provider_call_id,lead_signals.provider_call_id)
    RETURNING *`,
  [text(input.source || 'smartfinancial', 40), String(input.source_id), phone || null,
    text(input.customer_email, 320), text(input.customer_name, 200), text(input.business_name, 200),
    destination || null, text(input.agent_identity, 120),
    text(input.provider_call_id, 200), received, JSON.stringify(input.metadata || {})]);
  return rows[0];
}

export async function findLeadCandidates(call) {
  if (!db.enabled || !call) return [];
  return (await db.query(`SELECT * FROM lead_signals WHERE
    provider_call_id=$1 OR (customer_phone=$2 AND $2 IS NOT NULL) OR
    (source='smartfinancial' AND (destination_number IS NULL OR destination_number=$5)
      AND (agent_identity IS NULL OR $6::text IS NULL OR agent_identity=$6) AND received_at BETWEEN $3::timestamptz-$4*interval '1 minute' AND $3::timestamptz+$4*interval '1 minute')
    ORDER BY received_at DESC LIMIT 100`,
  [call.twilio_call_sid, call.customer_number, call.created_at, config.voice.matchWindowMinutes, call.to_e164, call.agent_identity])).rows;
}

export async function matchCallLead(sid, { signalId, actor } = {}) {
  const call = await loadCall(sid);
  if (!call?.source_number || call.identity_state === 'matched') return null;
  const candidates = await findLeadCandidates(call);
  const decision = signalId ? { state: 'matched', candidate: candidates.find(c => String(c.id) === String(signalId)), reason: 'agent_confirmed' } : chooseLead(call, candidates);
  if (signalId && !decision.candidate) throw Object.assign(new Error('Lead candidate not found for this call'), { status: 404 });
  if (decision.state !== 'matched') {
    await db.query(`UPDATE calls SET identity_state=$2,identity_evidence=$3 WHERE twilio_call_sid=$1 AND identity_state<>'matched'`,
    [sid, decision.state, JSON.stringify({ reason: decision.reason, candidateIds: (decision.candidates || [decision.candidate]).filter(Boolean).map(c => c.id) })]);
    return decision;
  }
  const signal = decision.candidate;
  await db.transaction(async tx => {
    const fresh = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [sid])).rows[0];
    if (fresh.identity_state === 'matched') return;
    const claimed = await tx.query(`UPDATE lead_signals SET claimed_call_sid=$2 WHERE id=$1
      AND (claimed_call_sid IS NULL OR claimed_call_sid=$2) RETURNING *`, [signal.id, sid]);
    if (!claimed.rows.length) throw Object.assign(new Error('Lead already linked to another call'), { status: 409 });
    let contactId = signal.contact_id;
    if (!contactId && signal.customer_phone) {
      const names = (signal.customer_name || '').split(/\s+/);
      contactId = (await tx.query(`INSERT INTO contacts(phone_e164,first_name,last_name,email,company,source)
        VALUES($1,$2,$3,$4,$5,'smartfinancial') ON CONFLICT(phone_e164) DO UPDATE
        SET first_name=coalesce(contacts.first_name,EXCLUDED.first_name),last_name=coalesce(contacts.last_name,EXCLUDED.last_name),
        email=coalesce(contacts.email,EXCLUDED.email),company=coalesce(contacts.company,EXCLUDED.company) RETURNING id`,
      [signal.customer_phone, names[0] || null, names.slice(1).join(' ') || null, signal.customer_email, signal.business_name])).rows[0].id;
    }
    const evidence = { sourceId: signal.source_id, signalId: signal.id, reason: decision.reason, confirmedBy: actor || null };
    const updated = (await tx.query(`UPDATE calls SET customer_number=$2,contact_id=$3,identity_state='matched',identity_evidence=$4,recap_fingerprint=NULL
      WHERE twilio_call_sid=$1 RETURNING *`, [sid, signal.customer_phone, contactId, JSON.stringify(evidence)])).rows[0];
    if (updated.ended_at) await emitWitnextEvent('call.completed', callPayload(updated), { connection: tx });
    if (updated.ended_at || updated.transcript_stopped_at) await enqueueJob('recap', `recap:${sid}`, { callSid: sid }, { refresh: true, connection: tx });
  });
  return decision;
}
