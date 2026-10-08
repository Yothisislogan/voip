import { createHash } from 'node:crypto';
import { db } from '../db.js';
import { enqueueJob } from '../jobs/queue.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { config } from '../config.js';

export const TERMINAL = new Set(['completed', 'missed', 'failed', 'abandoned']);
const RANK = { queued: 0, ringing: 1, in_progress: 2, completed: 3, missed: 3, failed: 3, abandoned: 3 };
export function mapStatus(status) {
  return ({ initiated: 'queued', 'in-progress': 'in_progress', answered: 'in_progress',
    'no-answer': 'missed', busy: 'missed', canceled: 'abandoned' })[status] || (status in RANK ? status : null);
}
export function nextStatus(current, incoming) {
  const next = mapStatus(incoming);
  if (!next || TERMINAL.has(current)) return current;
  return (RANK[next] ?? -1) >= (RANK[current] ?? -1) ? next : current;
}
export function validDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 86400 ? n : null;
}
export function isSharedNumber(phone) { return config.voice.sharedSourceNumbers.includes(phone); }

export async function loadCall(sid, connection = db) {
  if (!db.enabled || !sid) return null;
  const { rows } = await connection.query(`SELECT * FROM calls WHERE twilio_call_sid=$1 OR
    twilio_call_sid=(SELECT call_sid FROM call_legs WHERE sid=$1) LIMIT 1`, [sid]);
  return rows[0] || null;
}

export async function createCall({ callSid, direction, from, to, identity, targets = [] }) {
  if (!db.enabled) return null;
  const external = direction === 'outbound' ? to : from;
  const shared = isSharedNumber(external);
  const { rows } = await db.query(`INSERT INTO calls
    (twilio_call_sid,direction,from_e164,to_e164,customer_number,source_number,agent_identity,status,identity_state,route_targets)
    VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)
    ON CONFLICT(twilio_call_sid) DO UPDATE SET
      direction=coalesce(calls.direction,EXCLUDED.direction),from_e164=coalesce(calls.from_e164,EXCLUDED.from_e164),
      to_e164=coalesce(calls.to_e164,EXCLUDED.to_e164),customer_number=coalesce(calls.customer_number,EXCLUDED.customer_number),
      source_number=coalesce(calls.source_number,EXCLUDED.source_number),agent_identity=coalesce(calls.agent_identity,EXCLUDED.agent_identity),
      identity_state=CASE WHEN calls.direction IS NULL THEN EXCLUDED.identity_state ELSE calls.identity_state END,
      route_targets=CASE WHEN calls.direction IS NULL THEN EXCLUDED.route_targets ELSE calls.route_targets END,updated_at=now() RETURNING *`,
  [callSid, direction, from, to, shared ? null : external, shared ? external : null, identity || null,
    shared ? 'awaiting_lead' : 'unmatched', JSON.stringify(targets)]);
  if (identity) await db.query('UPDATE calls SET assigned_to=coalesce(assigned_to,$2) WHERE twilio_call_sid=$1 AND NOT assignment_explicit', [callSid, identity]);
  return rows[0];
}

export function callPayload(call) {
  return {
    source: call.provider || 'twilio', call_id: call.twilio_call_sid, direction: call.direction,
    // Never send a vendor transfer line as the CRM customer caller number.
    from: call.direction === 'inbound' ? call.customer_number : call.from_e164,
    to: call.to_e164, external_number: call.customer_number,
    source_number: call.source_number, agent_identity: call.agent_identity,
    assigned_to: call.assigned_to, tags: call.tags || [],
    duration_seconds: call.duration_seconds,
    started_at: call.created_at?.toISOString?.() || call.created_at,
    ended_at: call.ended_at?.toISOString?.() || call.ended_at,
    disposition: call.disposition || call.status,
    identity_state: call.identity_state, identity_evidence: call.identity_evidence,
  };
}

// Child-leg failure must not end the parent: another agent may answer or the
// caller may still be leaving voicemail. Only root callbacks / Dial action end it.
export async function applyStatus(body, { parentSid, agentIdentity, terminal = false } = {}) {
  if (!db.enabled) return null;
  return db.transaction(async tx => {
    const rootSid = parentSid || body.ParentCallSid || body.CallSid;
    await tx.query(`INSERT INTO calls(twilio_call_sid,status) VALUES($1,'queued') ON CONFLICT DO NOTHING`, [rootSid]);
    const call = (await tx.query(`SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE`, [rootSid])).rows[0];
    const child = body.CallSid !== rootSid;
    let status = mapStatus(body.CallStatus);
    if (!child && status === 'completed' && call.direction === 'inbound' && !call.answered_at && !terminal) {
      status = call.is_voicemail ? 'missed' : 'abandoned';
    }
    if (child) {
      const leg = await tx.query(`INSERT INTO call_legs(sid,call_sid,agent_identity,status,sequence_number) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(sid) DO UPDATE SET status=EXCLUDED.status,
          agent_identity=coalesce(EXCLUDED.agent_identity,call_legs.agent_identity),
          sequence_number=EXCLUDED.sequence_number,updated_at=now()
        WHERE EXCLUDED.sequence_number>call_legs.sequence_number RETURNING sid`,
      [body.CallSid, rootSid, agentIdentity || null, status, Number(body.SequenceNumber) || 0]);
      if (!leg.rows.length) return call;
    }
    let next = nextStatus(call.status, status);
    if (child && TERMINAL.has(status) && !terminal) next = call.status;
    const answered = (child && status === 'in_progress') || (terminal && status === 'completed');
    // The root leg being answered means Twilio began our greeting/TwiML, not
    // that an agent or the called party answered the bridged conversation.
    if (!child && status === 'in_progress' && !call.answered_at) next = call.status;
    const winner = answered && agentIdentity ? agentIdentity : null;
    // A root hangup can arrive before the child's answered callback. Preserve
    // the terminal lifecycle while correcting an apparent missed/abandoned call.
    if (answered && call.ended_at && ['missed','abandoned'].includes(call.status)) next = 'completed';
    const ended = TERMINAL.has(next);
    const result = (await tx.query(`UPDATE calls SET status=$2,
      agent_identity=coalesce($3,agent_identity),
      assigned_to=CASE WHEN assignment_explicit THEN assigned_to ELSE coalesce($3,assigned_to,agent_identity) END,
      answered_at=CASE WHEN $6 THEN coalesce(answered_at,now()) ELSE answered_at END,
      ended_at=CASE WHEN $4 THEN coalesce(ended_at,now()) ELSE ended_at END,
      duration_seconds=CASE WHEN $4 THEN coalesce($5,duration_seconds) ELSE duration_seconds END,
      updated_at=now() WHERE twilio_call_sid=$1 RETURNING *`,
    [rootSid, next, winner, ended, !child || terminal ? validDuration(body.CallDuration) : null, answered])).rows[0];
    if (ended) {
      await emitWitnextEvent('call.completed', callPayload(result), { connection: tx });
      await enqueueJob('recap', `recap:${rootSid}`, { callSid: rootSid }, { delayMs: 1500, refresh: true, connection: tx });
      await tx.query(`UPDATE agent_presence SET reserved_call_sid=NULL,reserved_until=NULL
        WHERE reserved_call_sid=$1`, [rootSid]);
    }
    return result;
  });
}

export function transcriptionEventKey(body) {
  if (body.TranscriptionSid && body.SequenceId != null) return `${body.TranscriptionSid}:${body.SequenceId}`;
  return createHash('sha256').update(JSON.stringify([body.CallSid, body.Track, body.Timestamp, body.TranscriptionData])).digest('hex');
}

export async function persistUtterance(body, speaker, text) {
  return db.transaction(async tx => {
    let call = await loadCall(body.CallSid, tx);
    if (!call) throw new Error('Call context not yet available; retry transcription');
    call = (await tx.query('SELECT * FROM calls WHERE id=$1 FOR UPDATE', [call.id])).rows[0];
    const seq = (await tx.query(`SELECT coalesce(max(seq),-1)+1 AS seq FROM transcript_segments WHERE call_sid=$1`, [call.twilio_call_sid])).rows[0].seq;
    const { rows } = await tx.query(`INSERT INTO transcript_segments(call_sid,contact_id,seq,speaker,text,spoken_at,provider_event_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
    [call.twilio_call_sid, call.contact_id, seq, speaker, text,
      body.Timestamp && Number.isFinite(Date.parse(body.Timestamp)) ? new Date(body.Timestamp) : new Date(), transcriptionEventKey(body)]);
    if (rows.length && (call.ended_at || call.transcript_stopped_at)) {
      await enqueueJob('recap', `recap:${call.twilio_call_sid}`, { callSid: call.twilio_call_sid }, { delayMs: 1500, refresh: true, connection: tx });
    }
    return { call, inserted: rows.length > 0 };
  });
}
