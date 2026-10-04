import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { emitWitnextEvent, witnextEnabled } from '../integrations/witnext.js';
import { enqueueJob } from '../jobs/queue.js';
import { asyncRoute } from '../util/async-route.js';

export const dialpadRouter = Router();
const iso = value => {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
export function formatDialpadTranscript(value) {
  if (typeof value === 'string') return value.trim();
  const lines = Array.isArray(value) ? value : value?.lines;
  if (!Array.isArray(lines)) return '';
  return lines.filter(line => (!line.type || line.type === 'transcript') && typeof line.content === 'string')
    .map(line => `${line.user_id != null ? 'Agent' : line.contact_id ? 'Customer' : line.name || 'Speaker'}: ${line.content}`).join('\n');
}
export function normalizeDialpadEvents(body) {
  const id = String(body.call_id || body.id || '');
  if (!id) return [];
  const external = body.external_number || body.contact?.phone;
  const internal = body.internal_number || body.target?.phone;
  const shared = config.voice.sharedSourceNumbers.includes(external);
  const target = body.operator || (String(body.target?.type).toLowerCase() === 'user' ? body.target : null);
  const base = {
    source: 'dialpad', call_id: `dialpad:${id}`, dialpad_call_id: id,
    direction: ['inbound','outbound'].includes(body.direction) ? body.direction : undefined,
    external_number: shared ? undefined : external,
    from: body.direction === 'outbound' ? internal : shared ? undefined : external,
    to: body.direction === 'outbound' ? external : internal,
    source_number: shared ? external : undefined,
    agent_identity: target?.email || target?.name || undefined,
    agent_external_id: target?.id != null ? String(target.id) : undefined,
    started_at: iso(body.date_started), ended_at: iso(body.date_ended),
    duration_seconds: body.duration != null && Number.isFinite(Number(body.duration)) ? Math.min(86400, Math.max(0, Math.round(Number(body.duration) / 1000))) : undefined,
  };
  const events = [];
  const state = String(body.state || body.call_state || '').toLowerCase();
  if (['hangup','ended','completed','missed','dispositions'].includes(state)) events.push({ type: 'call.completed', payload: { ...base, disposition: typeof body.disposition === 'string' ? body.disposition : state === 'missed' ? 'missed' : undefined } });
  const recap = { ...(body.call_recap || body.recap || {}) };
  for (const [source, field] of [['recap_summary','summary'],['recap_outcome','outcome'],['recap_action_items','action_items']]) {
    if (body[source] != null) recap[field] = body[source];
  }
  if (Object.keys(recap).length) events.push({ type: 'call.recap_available', payload: { ...base, recap } });
  const transcript = formatDialpadTranscript(body.transcript || body.transcription_text);
  if (transcript) events.push({ type: 'call.transcript_available', payload: { ...base, transcript } });
  else if (state === 'call_transcription' || body.transcript_url) events.push({ type: 'hydrate', payload: base });
  const recordings = [body.recording_url, ...(body.admin_recording_urls || []), ...(body.recording_details || []).map(r => r.url)].filter(Boolean);
  if (state === 'voicemail_uploaded' && body.voicemail_link) recordings.push(body.voicemail_link);
  for (const url of new Set(recordings)) events.push({ type: 'call.recording_available', payload: { ...base, recording_reference: url } });
  return events;
}

export async function hydrateDialpadTranscript(payload) {
  if (!config.dialpad.apiKey) throw new Error('DIALPAD_API_KEY required to retrieve call transcript');
  if (!/^\d+$/.test(payload.dialpad_call_id)) throw new Error('Invalid Dialpad call ID');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // Fixed official origin; do not fetch arbitrary URLs from webhook payloads.
    const response = await fetch(`https://dialpad.com/api/v2/transcripts/${payload.dialpad_call_id}`, {
      headers: { Authorization: `Bearer ${config.dialpad.apiKey}` }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Dialpad transcript retrieval returned ${response.status}`);
    const transcript = formatDialpadTranscript(await response.json());
    if (!transcript) throw new Error('Dialpad transcript is not available yet');
    await emitWitnextEvent('call.transcript_available', { ...payload, transcript });
  } finally { clearTimeout(timer); }
}

dialpadRouter.post('/dialpad/events', asyncRoute(async (req, res) => {
  if (!config.dialpad.enabled) return res.sendStatus(404);
  const raw = typeof req.body === 'string' ? req.body.trim() : req.body?.jwt || req.body?.payload;
  let event;
  try { event = jwt.verify(raw, config.dialpad.webhookSecret, { algorithms: ['HS256'] }); }
  catch { return res.status(403).json({ error: 'Valid signed JWT payload required' }); }
  if (witnextEnabled()) {
    for (const normalized of normalizeDialpadEvents(event)) {
      if (normalized.type === 'hydrate') await enqueueJob('dialpadTranscript', `dialpad:transcript:${normalized.payload.dialpad_call_id}`, normalized.payload);
      else await emitWitnextEvent(normalized.type, normalized.payload, { occurredAt: iso(event.event_timestamp || event.date_ended || event.date_started) });
    }
  }
  res.sendStatus(204);
}));
