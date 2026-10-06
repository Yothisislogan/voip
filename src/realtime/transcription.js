import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, webhookUrl } from '../config.js';
import { db } from '../db.js';
import { loadCall, persistUtterance } from '../services/call-state.js';
import { enqueueJob } from '../jobs/queue.js';
import { onUtterance, resolveSpeaker } from './orchestrator.js';
import { getSession } from './sessions.js';
import { publishToAgent } from './bus.js';
import { runTracked } from '../jobs/deadletter.js';

export const MEDIA_PATH = '/voice/media';
const sign = value => createHmac('sha256', config.twilio.authToken).update(value).digest('base64url');

export function streamTicket(callSid, expires = Date.now() + 300_000) {
  return `${expires}.${sign(`${callSid}:${expires}`)}`;
}
export function verifyStreamTicket(callSid, ticket) {
  if (!config.twilio.authToken || typeof ticket !== 'string') return false;
  const [expires, signature] = ticket.split('.');
  const remaining = Number(expires) - Date.now();
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 300_000 || !signature) return false;
  const expected = sign(`${callSid}:${expires}`);
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function startTranscription(twiml, callSid) {
  if (!config.publicBaseUrl || (!config.coachingEnabled && !config.recapEnabled)) return;
  if (config.transcription.provider === 'assemblyai') {
    const stream = twiml.start().stream({ name: 'wit-assemblyai', track: 'both_tracks',
      url: webhookUrl(MEDIA_PATH).replace(/^https:/, 'wss:'),
      statusCallback: webhookUrl('/voice/media-status'), statusCallbackMethod: 'POST' });
    stream.parameter({ name: 'ticket', value: streamTicket(callSid) });
  } else {
    twiml.start().transcription({ name: 'wit-coaching', track: 'both_tracks', partialResults: false,
      statusCallbackUrl: webhookUrl('/voice/transcription') });
  }
}

export async function saveAssemblyTurn({ callSid, streamSid, track, turn, timestamp }) {
  const call = await loadCall(callSid);
  const providerTrack = `${track}_track`;
  const speaker = resolveSpeaker(call?.direction || getSession(callSid)?.direction, providerTrack);
  if (db.enabled) {
    const result = await persistUtterance({ CallSid: callSid, Track: providerTrack,
      TranscriptionSid: `assemblyai:${streamSid}:${track}`, SequenceId: turn.turn_order,
      Timestamp: new Date(timestamp).toISOString() }, speaker, turn.transcript.trim());
    if (!result.inserted) return;
  }
  // Coaching failure never blocks persistence or the next audio frame.
  runTracked('onUtterance', { callSid, track: providerTrack, transcript: turn.transcript.trim() },
    () => onUtterance(callSid, providerTrack, turn.transcript.trim(), timestamp));
}

export async function setTranscriptionState(callSid, state, error = null) {
  if (db.enabled) {
    await db.query(`UPDATE calls SET transcription_provider='assemblyai',
      transcription_state=CASE WHEN transcription_state='error' THEN 'error'
        WHEN transcription_state='stopped' AND $2='streaming' THEN 'stopped' ELSE $2 END,
      transcription_error=coalesce(transcription_error,$3),updated_at=now() WHERE twilio_call_sid=$1`,
    [callSid, state, error]);
    if (state === 'stopped' || state === 'error') await db.transaction(async tx => {
      await tx.query('UPDATE calls SET transcript_stopped_at=now() WHERE twilio_call_sid=$1', [callSid]);
      await enqueueJob('recap', `recap:${callSid}`, { callSid }, { delayMs: 1500, refresh: true, connection: tx });
    });
  }
  const call = await loadCall(callSid);
  const identity = call?.agent_identity || getSession(callSid)?.identity;
  if (identity) publishToAgent(identity, 'transcription_status', { callSid, provider: 'assemblyai',
    state: call?.transcription_state || state, error: call?.transcription_error || error });
}

// Single-instance pilot: sockets cannot survive a process restart. Never leave
// an old call labeled as actively transcribing after a crash or forced deploy.
export async function recoverInterruptedStreams() {
  if (!db.enabled) return;
  await db.transaction(async tx => {
    const { rows } = await tx.query(`UPDATE calls SET transcription_state='error',
      transcription_error='server_restart',transcript_stopped_at=now(),updated_at=now()
      WHERE transcription_provider='assemblyai' AND transcription_state='streaming'
      RETURNING twilio_call_sid`);
    for (const call of rows) await enqueueJob('recap', `recap:${call.twilio_call_sid}`,
      { callSid: call.twilio_call_sid }, { delayMs: 1500, refresh: true, connection: tx });
  });
}
