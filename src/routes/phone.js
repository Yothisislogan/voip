import { Router } from 'express';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import twilio from 'twilio';
import { config, webhookUrl } from '../config.js';
import { db } from '../db.js';
import { client } from '../twilio.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { csrfProtect } from '../middleware/csrf.js';
import { asyncRoute } from '../util/async-route.js';
import { loadCall, callPayload } from '../services/call-state.js';
import { findLeadCandidates, matchCallLead, upsertLeadSignal } from '../services/lead-matching.js';
import { doScreenPop } from '../realtime/orchestrator.js';
import { enqueueJob } from '../jobs/queue.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { audit } from '../audit.js';
import { canAccessCall } from '../auth/call-access.js';

export const phoneRouter = Router();
const DISPOSITIONS = ['quote_requested','follow_up','callback','sale','not_interested','wrong_number','spam','other'];

// Machine-to-machine normalized intake. A dedicated secret is required in all
// environments; never accept caller-supplied IDs without authentication.
phoneRouter.post('/integrations/lead-signals', asyncRoute(async (req, res) => {
  const expected = config.voice.signalToken;
  const provided = req.get('authorization')?.replace(/^Bearer /, '') || '';
  if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(provided) ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return res.sendStatus(401);
  if (!db.enabled) return res.sendStatus(503);
  const signal = await upsertLeadSignal(req.body);
  // Reconcile either ordering: email before call, or email after completion.
  const { rows } = await db.query(`SELECT twilio_call_sid FROM calls WHERE source_number IS NOT NULL
    AND identity_state<>'matched' AND created_at BETWEEN $1::timestamptz-$2*interval '1 minute' AND $1::timestamptz+$2*interval '1 minute'`,
  [signal.received_at, config.voice.matchWindowMinutes]);
  for (const row of rows) await enqueueJob('screenPop', `match:${row.twilio_call_sid}`, { callSid: row.twilio_call_sid }, { refresh: true });
  res.status(202).json({ id: signal.id });
}));

phoneRouter.use('/api/phone', requireAuth, csrfProtect, (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!db.enabled) return res.status(503).json({ error: 'Phone database not configured' });
  next();
});
phoneRouter.get('/api/phone/config', (req, res) => res.json({
  identity: req.agent.identity, role: req.agent.role,
  calling: !!(client && config.twilio.twimlAppSid && config.twilio.callerId) && req.agent.role !== 'viewer',
  dispositions: DISPOSITIONS,
  agents: config.auth.agents.filter(a => a.role !== 'viewer').map(a => ({ identity: a.identity, name: a.name || a.identity })),
  capabilities: { mute: true, dtmf: true, inboundBlindTransfer: true, hold: false, warmTransfer: false, conference: false },
}));

phoneRouter.post('/api/phone/presence', requireRole('agent'), asyncRoute(async (req, res) => {
  const status = req.body.status;
  if (!['available','busy','away','dnd','offline','wrapup'].includes(status)) return res.status(400).json({ error: 'Invalid presence status' });
  await db.query(`INSERT INTO agent_presence(identity,status) VALUES($1,$2)
    ON CONFLICT(identity) DO UPDATE SET status=$2,heartbeat_at=now(),
      idle_since=CASE WHEN $2='available' AND agent_presence.status<>'available' THEN now() ELSE agent_presence.idle_since END`, [req.agent.identity, status]);
  res.json({ status });
}));

phoneRouter.get('/api/phone/calls', asyncRoute(async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const q = String(req.query.q || '').slice(0, 200);
  const { rows } = await db.query(`SELECT c.*,coalesce(nullif(concat_ws(' ',p.first_name,p.last_name),''),p.company) AS customer_name,
    p.email AS customer_email FROM calls c LEFT JOIN contacts p ON p.id=c.contact_id
    WHERE ($1 OR c.agent_identity=$2 OR (c.agent_identity IS NULL AND c.route_targets ? $2))
      AND ($3='' OR concat_ws(' ',c.customer_number,c.from_e164,c.to_e164,p.first_name,p.last_name,p.company) ILIKE '%'||$3||'%')
      AND ($4='' OR ($4='voicemail' AND c.is_voicemail) OR ($4='missed' AND c.status IN ('missed','abandoned')) OR c.status=$4)
    ORDER BY c.created_at DESC LIMIT $5 OFFSET $6`,
  [req.agent.role === 'admin', req.agent.identity, q, String(req.query.status || ''), limit, offset]);
  res.json({ calls: rows, offset, limit });
}));

phoneRouter.use('/api/phone/calls/:sid', asyncRoute(async (req, res, next) => {
  const call = await loadCall(req.params.sid);
  if (!call || !canAccessCall(req.agent, call)) return res.status(404).json({ error: 'Call not found' });
  req.call = call;
  next();
}));
phoneRouter.get('/api/phone/calls/:sid', asyncRoute(async (req, res) => {
  const sid = req.call.twilio_call_sid;
  const segments = (await db.query('SELECT speaker,text,spoken_at FROM transcript_segments WHERE call_sid=$1 ORDER BY spoken_at,seq', [sid])).rows;
  const recordings = (await db.query('SELECT recording_sid,kind,status,duration_seconds FROM call_recordings WHERE call_sid=$1 ORDER BY created_at', [sid])).rows;
  const candidates = req.call.source_number && req.call.identity_state !== 'matched' ? await findLeadCandidates(req.call) : [];
  audit({ req, action: 'call.view', entityType: 'call', entityId: sid });
  res.json({ call: req.call, segments, recordings, candidates });
}));
phoneRouter.patch('/api/phone/calls/:sid', requireRole('agent'), asyncRoute(async (req, res) => {
  if (req.body.notes !== undefined && (typeof req.body.notes !== 'string' || req.body.notes.length > 10000)) return res.status(400).json({ error: 'Notes must be text under 10,000 characters' });
  if (req.body.disposition !== undefined && !DISPOSITIONS.includes(req.body.disposition)) return res.status(400).json({ error: 'Invalid disposition' });
  const call = (await db.query(`UPDATE calls SET notes=coalesce($2,notes),disposition=coalesce($3,disposition),updated_at=now()
    WHERE twilio_call_sid=$1 RETURNING *`, [req.call.twilio_call_sid, req.body.notes ?? null, req.body.disposition ?? null])).rows[0];
  if (call.ended_at) await emitWitnextEvent('call.completed', callPayload(call));
  audit({ req, action: 'call.update', entityType: 'call', entityId: call.twilio_call_sid, detail: { fields: Object.keys(req.body) } });
  res.json({ call });
}));
phoneRouter.post('/api/phone/calls/:sid/match', requireRole('agent'), asyncRoute(async (req, res) => {
  if (!req.body.signalId) return res.status(400).json({ error: 'signalId is required' });
  await matchCallLead(req.call.twilio_call_sid, { signalId: req.body.signalId, actor: req.agent.identity });
  await doScreenPop(req.call.twilio_call_sid);
  audit({ req, action: 'call.identity_confirmed', entityType: 'call', entityId: req.call.twilio_call_sid, detail: { signalId: req.body.signalId } });
  res.json({ ok: true });
}));
phoneRouter.post('/api/phone/calls/:sid/recap', requireRole('agent'), asyncRoute(async (req, res) => {
  if (!req.call.ended_at && !req.call.transcript_stopped_at) return res.status(409).json({ error: 'Call is still active' });
  await db.query('UPDATE calls SET recap_fingerprint=NULL WHERE twilio_call_sid=$1', [req.call.twilio_call_sid]);
  await enqueueJob('recap', `recap:${req.call.twilio_call_sid}`, { callSid: req.call.twilio_call_sid }, { refresh: true });
  res.status(202).json({ queued: true });
}));
phoneRouter.post('/api/phone/calls/:sid/transfer', requireRole('agent'), asyncRoute(async (req, res) => {
  const call = req.call;
  if (!client) return res.status(503).json({ error: 'Telephony provider not configured' });
  if (call.direction !== 'inbound' || call.status !== 'in_progress') return res.status(409).json({ error: 'Blind transfer currently requires an active inbound call' });
  const target = config.auth.agents.find(a => a.identity === req.body.identity && a.role !== 'viewer');
  if (!target || target.identity === call.agent_identity) return res.status(400).json({ error: 'Choose a different calling-enabled agent' });
  const token = req.get('Idempotency-Key');
  if (!token || !/^[a-zA-Z0-9-]{16,100}$/.test(token)) return res.status(400).json({ error: 'Idempotency-Key required' });
  const reserved = await db.transaction(async tx => {
    const receipt = await tx.query(`INSERT INTO service_receipts(receipt_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING receipt_key`, [`transfer:${req.agent.identity}:${token}`]);
    if (!receipt.rows.length) return false;
    const changed = await tx.query(`UPDATE calls SET disposition='transferring' WHERE twilio_call_sid=$1
      AND status='in_progress' AND disposition IS DISTINCT FROM 'transferring' RETURNING id`, [call.twilio_call_sid]);
    return changed.rows.length > 0;
  });
  if (!reserved) return res.status(409).json({ error: 'Transfer already requested; inspect call before retrying' });
  const xml = new twilio.twiml.VoiceResponse();
  xml.say('Please hold while we transfer your call.');
  const dial = xml.dial({ timeout: 25, action: webhookUrl('/voice/transfer-result'), method: 'POST',
    ...(config.voice.recordingEnabled ? { record: 'record-from-answer-dual', recordingStatusCallback: webhookUrl('/recording/status'), recordingStatusCallbackEvent: 'completed absent' } : {}) });
  const targetClient = dial.client({ statusCallback: webhookUrl(`/voice/status?parent=${encodeURIComponent(call.twilio_call_sid)}&agent=${encodeURIComponent(target.identity)}`),
    statusCallbackEvent: 'initiated ringing answered completed' });
  targetClient.identity(target.identity);
  targetClient.parameter({ name: 'rootCallSid', value: call.twilio_call_sid });
  try { await client.calls(call.twilio_call_sid).update({ twiml: xml.toString() }); }
  catch {
    // A timeout can mean Twilio accepted the command. Leave the receipt and
    // transferring state visible; never automatically issue a second transfer.
    return res.status(502).json({ error: 'Provider did not confirm transfer. Check the live call before trying again.' });
  }
  await db.query(`UPDATE calls SET agent_identity=$2,route_targets=$3 WHERE twilio_call_sid=$1`, [call.twilio_call_sid, target.identity, JSON.stringify([target.identity])]);
  audit({ req, action: 'call.transfer', entityType: 'call', entityId: call.twilio_call_sid, detail: { target: target.identity } });
  res.json({ requested: true });
}));

phoneRouter.get('/api/phone/calls/:sid/recordings/:recordingSid', asyncRoute(async (req, res) => {
  const sid = req.params.recordingSid;
  if (!/^RE[0-9a-f]{32}$/i.test(sid)) return res.sendStatus(400);
  const row = (await db.query(`SELECT * FROM call_recordings WHERE recording_sid=$1 AND call_sid=$2 AND status='completed'`, [sid, req.call.twilio_call_sid])).rows[0];
  if (!row || !config.twilio.accountSid || !config.twilio.apiKeySid) return res.sendStatus(404);
  // Construct from validated IDs; never fetch a webhook-supplied arbitrary URL.
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Recordings/${sid}.mp3`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from(`${config.twilio.apiKeySid}:${config.twilio.apiKeySecret}`).toString('base64')}` },
      signal: controller.signal, redirect: 'error' });
    if (!upstream.ok) return res.status(502).json({ error: 'Recording unavailable at provider' });
    res.type('audio/mpeg');
    audit({ req, action: 'recording.play', entityType: 'call', entityId: req.call.twilio_call_sid });
    await pipeline(Readable.fromWeb(upstream.body), res);
  } finally { clearTimeout(timer); }
}));

phoneRouter.get('/api/phone/operations', requireRole('admin'), asyncRoute(async (_req, res) => {
  const metrics = (await db.query(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE status='in_progress')::int AS live,
    count(*) FILTER(WHERE status IN ('missed','abandoned'))::int AS missed,
    count(*) FILTER(WHERE is_voicemail)::int AS voicemail,
    count(*) FILTER(WHERE identity_state IN ('awaiting_lead','ambiguous','suggested'))::int AS identity_pending,
    count(*) FILTER(WHERE recap_state IN ('failed','no_transcript','transcription_error'))::int AS recap_attention,
    round(avg(duration_seconds)) AS average_seconds FROM calls WHERE created_at>now()-interval '24 hours'`)).rows[0];
  const jobs = (await db.query(`SELECT id,kind,state,attempts,error,created_at,updated_at FROM service_jobs
    WHERE state<>'done' ORDER BY created_at LIMIT 100`)).rows;
  const agents = (await db.query(`SELECT identity,
    CASE WHEN heartbeat_at<now()-interval '75 seconds' THEN 'offline' ELSE status END AS status,
    heartbeat_at FROM agent_presence ORDER BY identity`)).rows;
  res.json({ metrics, jobs, agents, bridgeConfigured: !!(config.witnext.enabled && config.witnext.integrationId) });
}));
phoneRouter.post('/api/phone/jobs/:id/retry', requireRole('admin'), asyncRoute(async (req, res) => {
  const { rows } = await db.query(`UPDATE service_jobs SET state='pending',attempts=0,run_after=now(),error=NULL
    WHERE id=$1 AND state='failed' RETURNING id`, [req.params.id]);
  if (!rows.length) return res.status(409).json({ error: 'Only exhausted jobs can be manually retried' });
  res.json({ queued: true });
}));
