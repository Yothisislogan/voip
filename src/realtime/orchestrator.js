import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import { transcripts } from '../ai/transcript.js';
import { generateCoaching } from '../ai/coach.js';
import { generateRecap } from '../ai/recap.js';
import { scoreCall } from '../ai/score.js';
import { extractLeadFields } from '../ai/extract.js';
import { extractLeadFieldsAI, mergeAiExtraction } from '../ai/extract-ai.js';
import * as crm from '../store/crm.js';
import * as erpnext from '../crm/erpnext.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { getSession, setContact, endSession, startSession } from './sessions.js';
import { publishToAgent } from './bus.js';
import { callPayload, isSharedNumber, loadCall } from '../services/call-state.js';
import { schedulePostCall } from '../services/post-call.js';
import { matchCallLead } from '../services/lead-matching.js';

export function resolveSpeaker(direction, track) {
  const callerIsAgent = direction === 'outbound';
  if (track === 'inbound_track') return callerIsAgent ? 'agent' : 'customer';
  if (track === 'outbound_track') return callerIsAgent ? 'customer' : 'agent';
  return 'customer';
}

export async function restoreSession(callSid) {
  let session = getSession(callSid);
  if (session) return session;
  const call = await loadCall(callSid);
  if (!call) return null;
  startSession(callSid, { identity: call.agent_identity, customerNumber: call.customer_number,
    direction: call.direction, from: call.from_e164, to: call.to_e164 });
  session = getSession(callSid);
  session.contactId = call.contact_id;
  session.startedAt = new Date(call.created_at).getTime();
  return session;
}

export async function doScreenPop(callSid) {
  let call = await loadCall(callSid);
  const session = await restoreSession(callSid);
  if (!session) return;
  if (call?.source_number) {
    await matchCallLead(callSid);
    call = await loadCall(callSid);
    session.customerNumber = call.customer_number;
    session.contactId = call.contact_id;
  }
  let contact = null;
  const number = call?.customer_number || session.customerNumber;
  if (number && !isSharedNumber(number)) {
    if (db.enabled) {
      const row = await crm.findOrCreateContactByPhone(number, { source: session.direction === 'outbound' ? 'call_outbound' : 'call_inbound' });
      if (!row) throw new Error('Contact lookup failed');
      session.contactId = row.id;
      contact = crm.shapeContactForUi(row);
      await db.query('UPDATE calls SET contact_id=$2 WHERE twilio_call_sid=$1', [callSid, row.id]);
    } else contact = await erpnext.findContactByPhone(number);
  }
  setContact(callSid, contact);
  const identities = call?.agent_identity ? [call.agent_identity] : call?.route_targets || [session.identity];
  for (const identity of identities.filter(Boolean)) publishToAgent(identity, 'screenpop', {
    callSid, phone: number, contact, sourceNumber: call?.source_number,
    identityState: call?.identity_state, identityEvidence: call?.identity_evidence,
  });
}

// Persistence occurs in the webhook before acknowledgement. Live coaching is
// optional; failure must not erase a successfully stored utterance.
export async function onUtterance(callSid, track, text, at = Date.now()) {
  const session = await restoreSession(callSid);
  if (!session) return;
  const speaker = resolveSpeaker(session.direction, track);
  transcripts.append(callSid, speaker, text, at);
  if (session.identity) publishToAgent(session.identity, 'transcript', { callSid, speaker, text });
  if (!config.coachingEnabled || at - session.throttledAt < config.coachingThrottleMs) return;
  session.throttledAt = at;
  const coaching = await generateCoaching(transcripts.formatRecent(callSid));
  if (coaching && session.identity) publishToAgent(session.identity, 'coaching', { callSid, ...coaching });
}

// A replayable DB job: no dependence on the original server's memory. Late
// segments refresh the job and change the fingerprint, generating a new recap.
export async function onCallComplete(callSid) {
  const call = await loadCall(callSid);
  if (!call) throw new Error('Call not found for recap');
  const segments = (await db.query(`SELECT speaker,text FROM transcript_segments WHERE call_sid=$1
    ORDER BY spoken_at,seq`, [callSid])).rows;
  const full = segments.map(s => `${s.speaker === 'agent' ? 'Agent' : 'Customer'}: ${s.text}`).join('\n');
  if (!full) {
    await db.query("UPDATE calls SET recap_state='no_transcript' WHERE twilio_call_sid=$1", [callSid]);
    if (call.ended_at) { transcripts.clear(callSid); endSession(callSid); }
    return;
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([full, call.contact_id, call.customer_number])).digest('hex');
  // Transcripts and lifecycle travel independently of AI availability.
  await emitWitnextEvent('call.transcript_available', { ...callPayload(call), transcript: full });
  if (!config.recapEnabled) {
    await db.query("UPDATE calls SET recap_state='disabled' WHERE twilio_call_sid=$1", [callSid]);
    if (call.ended_at) { transcripts.clear(callSid); endSession(callSid); }
    return;
  }
  if (call.recap_fingerprint === fingerprint && call.recap_state === 'ready') {
    await schedulePostCall(call);
    return;
  }
  await db.query("UPDATE calls SET recap_state='processing' WHERE twilio_call_sid=$1", [callSid]);
  try {
    const recap = await generateRecap(full);
    if (!recap) throw new Error('Recap provider returned no result');
    const scored = scoreCall({ recap, transcript: full });
    let proposedUpdates = [];
    if (call.contact_id) {
      const fields = extractLeadFields(full, recap);
      const aiResult = await extractLeadFieldsAI(full).catch(() => null);
      const { applied, proposed, nextAction } = mergeAiExtraction(aiResult);
      proposedUpdates = proposed;
      if (nextAction) recap.nextSteps = [...new Set([nextAction, ...(recap.nextSteps || [])])];
      const merged = { ...fields, ...applied };
      if (Object.keys(merged).length) {
        const updated = await crm.updateContactFields(call.contact_id, merged);
        if (!updated) throw new Error('Could not persist extracted contact fields');
      }
    }
    // Save recap, score and outbound event in one transaction. A crash before
    // commit retries all three; one after commit finds the same fingerprint.
    await db.transaction(async tx => {
      await tx.query(`INSERT INTO call_scores(call_sid,contact_id,score,sentiment,outcome,factors,summary)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(call_sid) DO UPDATE SET
        score=EXCLUDED.score,sentiment=EXCLUDED.sentiment,outcome=EXCLUDED.outcome,factors=EXCLUDED.factors,summary=EXCLUDED.summary`,
      [callSid, call.contact_id, scored.score, scored.sentiment, scored.outcome, JSON.stringify(scored.factors), scored.summary]);
      await tx.query(`UPDATE calls SET recap=$2,recap_state='ready',recap_fingerprint=$3,updated_at=now()
        WHERE twilio_call_sid=$1`, [callSid, JSON.stringify(recap), fingerprint]);
      await schedulePostCall(call, tx);
      await emitWitnextEvent('call.recap_available', { ...callPayload(call), recap, score: scored, proposed_updates: proposedUpdates }, { connection: tx });
    });
    if (call.agent_identity) publishToAgent(call.agent_identity, 'recap', {
      callSid, recap, score: scored, contactId: call.contact_id, proposedUpdates, savedToCrm: true,
    });
    transcripts.clear(callSid);
    endSession(callSid);
  } catch (error) {
    await db.query("UPDATE calls SET recap_state='failed' WHERE twilio_call_sid=$1", [callSid]);
    if (call.ended_at) { transcripts.clear(callSid); endSession(callSid); }
    throw error;
  }
}
