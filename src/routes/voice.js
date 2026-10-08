import { Router } from 'express';
import twilio from 'twilio';
import { config, webhookUrl } from '../config.js';
import { db } from '../db.js';
import { startSession, identityFromClient, getSession } from '../realtime/sessions.js';
import { doScreenPop, onUtterance, resolveSpeaker, restoreSession } from '../realtime/orchestrator.js';
import { runTracked } from '../jobs/deadletter.js';
import { enqueueJob } from '../jobs/queue.js';
import { createCall, applyStatus, loadCall, persistUtterance } from '../services/call-state.js';
import { selectTargets } from '../services/routing.js';
import { normalizePhone } from '../util/phone.js';
import { asyncRoute } from '../util/async-route.js';
import { publishToAgent } from '../realtime/bus.js';
import { startTranscription, setTranscriptionState } from '../realtime/transcription.js';

const { VoiceResponse } = twilio.twiml;
export const voiceRouter = Router();
const STATUS_EVENTS = 'initiated ringing answered completed';
const DISCLOSURE = 'This call may be recorded and transcribed for quality and training.';

function recordingOptions() {
  return config.voice.recordingEnabled ? { record: 'record-from-answer-dual',
    recordingStatusCallback: webhookUrl('/recording/status'), recordingStatusCallbackEvent: 'completed absent' } : {};
}
function statusUrl(root, identity) {
  return webhookUrl(`/voice/status?parent=${encodeURIComponent(root)}${identity ? `&agent=${encodeURIComponent(identity)}` : ''}`);
}
function sendXml(res, twiml) { return res.type('text/xml').send(twiml.toString()); }
async function queueScreenPop(callSid) {
  if (db.enabled) await enqueueJob('screenPop', `screenpop:${callSid}`, { callSid }, { refresh: true });
  else runTracked('screenPop', { callSid }, () => doScreenPop(callSid));
}
async function recordDisclosure(sid) {
  if (!db.enabled || (!config.voice.recordingEnabled && !config.coachingEnabled && !config.recapEnabled)) return;
  await db.query(`INSERT INTO consent_events(call_sid,kind,state,method)
    SELECT $1,'disclosure','disclosed','ivr_disclosure'
    WHERE NOT EXISTS(SELECT 1 FROM consent_events WHERE call_sid=$1 AND kind='disclosure')`, [sid]);
  await db.query("UPDATE calls SET consent_state='disclosed',consent_at=coalesce(consent_at,now()) WHERE twilio_call_sid=$1", [sid]);
}
export function validDestination(raw) {
  if (typeof raw !== 'string' || !/^[+\d\s().-]+$/.test(raw)) return null;
  const n = normalizePhone(raw);
  return /^\+[1-9]\d{7,14}$/.test(n) && config.voice.allowedPrefixes.some(prefix => n.startsWith(prefix)) ? n : null;
}
export function voicemail(twiml) {
  twiml.say('Sorry we missed you. Please leave your name, callback number, and message after the tone.');
  twiml.record({ maxLength: 120, playBeep: true, transcribe: false,
    recordingStatusCallback: webhookUrl('/recording/status?kind=voicemail'), recordingStatusCallbackEvent: 'completed absent',
    action: webhookUrl('/voice/voicemail-done'), method: 'POST' });
  twiml.hangup();
}

voiceRouter.post('/voice/outbound', asyncRoute(async (req, res) => {
  const twiml = new VoiceResponse();
  const to = validDestination(req.body.To);
  const identity = identityFromClient(req.body.From);
  const allowed = config.auth.agents.some(a => a.identity === identity && a.role !== 'viewer');
  if (!to || !identity || (config.auth.required && !allowed)) {
    twiml.say('This destination or calling account is not enabled.'); twiml.hangup();
    return sendXml(res, twiml);
  }
  const callSid = req.body.CallSid;
  await createCall({ callSid, direction: 'outbound', from: config.twilio.callerId, to, identity });
  startSession(callSid, { identity, customerNumber: to, direction: 'outbound', from: config.twilio.callerId, to });
  startTranscription(twiml, callSid);
  const dial = twiml.dial({ callerId: config.twilio.callerId, answerOnBridge: true,
    action: webhookUrl('/voice/outbound-done'), method: 'POST', ...recordingOptions() });
  dial.number({ statusCallback: statusUrl(callSid), statusCallbackEvent: STATUS_EVENTS, statusCallbackMethod: 'POST',
    // Runs on the called party after answer, before the bridge opens.
    url: webhookUrl(`/voice/disclosure?parent=${encodeURIComponent(callSid)}`), method: 'POST' }, to);
  await queueScreenPop(callSid);
  sendXml(res, twiml);
}));

voiceRouter.post('/voice/disclosure', asyncRoute(async (req, res) => {
  const twiml = new VoiceResponse();
  if (config.voice.recordingEnabled || config.coachingEnabled || config.recapEnabled) twiml.say(DISCLOSURE);
  await recordDisclosure(req.query.parent || req.body.ParentCallSid || req.body.CallSid);
  sendXml(res, twiml);
}));

voiceRouter.post('/voice/inbound', asyncRoute(async (req, res) => {
  const { CallSid: callSid, From: from, To: to } = req.body;
  const twiml = new VoiceResponse();
  const route = await selectTargets(callSid);
  await createCall({ callSid, direction: 'inbound', from, to,
    identity: route.targets.length === 1 ? route.targets[0] : null, targets: route.targets });
  startSession(callSid, { identity: route.targets.length === 1 ? route.targets[0] : null,
    customerNumber: from, direction: 'inbound', from, to });
  twiml.say(`Thank you for calling We Insure Things. ${config.voice.recordingEnabled || config.coachingEnabled || config.recapEnabled ? DISCLOSURE : ''}`);
  startTranscription(twiml, callSid);
  if (route.targets.length) {
    const dial = twiml.dial({ callerId: from, timeout: route.timeout, answerOnBridge: true,
      action: webhookUrl('/voice/dial-status'), method: 'POST', ...recordingOptions() });
    for (const identity of route.targets) {
      const target = dial.client({ statusCallback: statusUrl(callSid, identity), statusCallbackEvent: STATUS_EVENTS, statusCallbackMethod: 'POST' });
      target.identity(identity);
      target.parameter({ name: 'rootCallSid', value: callSid });
    }
  } else voicemail(twiml);
  if (db.enabled) {
    await db.query(`UPDATE calls SET is_voicemail=$2,consent_state=$3,consent_at=now() WHERE twilio_call_sid=$1`,
      [callSid, !route.targets.length, config.voice.recordingEnabled || config.coachingEnabled || config.recapEnabled ? 'disclosed' : 'unknown']);
  }
  await recordDisclosure(callSid);
  await queueScreenPop(callSid);
  sendXml(res, twiml);
}));

voiceRouter.post('/voice/dial-status', asyncRoute(async (req, res) => {
  const twiml = new VoiceResponse();
  const call = await loadCall(req.body.CallSid);
  // A redirected call (transfer) must not execute the original Dial's fallback.
  if (call?.disposition === 'transferring') return sendXml(res, twiml);
  if (req.body.DialCallStatus === 'completed' || req.body.DialCallStatus === 'answered') {
    await applyStatus({ CallSid: req.body.CallSid, CallStatus: 'completed', CallDuration: req.body.DialCallDuration }, { terminal: true });
  } else {
    if (db.enabled) await db.query('UPDATE calls SET is_voicemail=true WHERE twilio_call_sid=$1', [req.body.CallSid]);
    voicemail(twiml);
  }
  sendXml(res, twiml);
}));

voiceRouter.post('/voice/outbound-done', asyncRoute(async (req, res) => {
  await applyStatus({ CallSid: req.body.CallSid, CallStatus: req.body.DialCallStatus || 'completed', CallDuration: req.body.DialCallDuration });
  sendXml(res, new VoiceResponse());
}));
voiceRouter.post('/voice/transfer-result', asyncRoute(async (req, res) => {
  const xml = new VoiceResponse();
  if (req.body.DialCallStatus === 'completed') {
    await db.query("UPDATE calls SET disposition='transferred' WHERE twilio_call_sid=$1", [req.body.CallSid]);
    await applyStatus({ CallSid: req.body.CallSid, CallStatus: 'completed', CallDuration: req.body.DialCallDuration }, { terminal: true });
  } else {
    await db.query("UPDATE calls SET disposition='transfer_unanswered',is_voicemail=true WHERE twilio_call_sid=$1", [req.body.CallSid]);
    voicemail(xml);
  }
  sendXml(res, xml);
}));
voiceRouter.post('/voice/voicemail-done', asyncRoute(async (req, res) => {
  await applyStatus({ CallSid: req.body.CallSid, CallStatus: 'completed' });
  sendXml(res, new VoiceResponse());
}));

voiceRouter.post('/voice/status', asyncRoute(async (req, res) => {
  const call = await applyStatus(req.body, { parentSid: req.query.parent, agentIdentity: req.query.agent });
  if (call?.agent_identity) {
    const session = await restoreSession(call.twilio_call_sid);
    if (session) session.identity = call.agent_identity;
    publishToAgent(call.agent_identity, 'call_status', { callSid: call.twilio_call_sid, status: call.status });
    if (req.body.CallStatus === 'in-progress') await queueScreenPop(call.twilio_call_sid);
  }
  res.sendStatus(204);
}));

voiceRouter.post('/voice/media-status', asyncRoute(async (req, res) => {
  // Signature middleware protects this route. A failed handshake may never
  // reach our WebSocket handler, so preserve Twilio's error callback as well.
  if (config.transcription.provider === 'assemblyai' && req.body.StreamEvent === 'stream-error') {
    await setTranscriptionState(req.body.CallSid, 'error', 'media_stream_error');
  }
  res.sendStatus(204);
}));

voiceRouter.post('/voice/transcription', asyncRoute(async (req, res) => {
  const body = req.body;
  const callSid = body.CallSid;
  if (body.TranscriptionEvent === 'transcription-content') {
    let data;
    try { data = JSON.parse(body.TranscriptionData || '{}'); }
    catch { return res.status(400).json({ error: 'Invalid transcription data' }); }
    if (body.Final === 'false' || data.is_final === false) return res.sendStatus(204);
    const text = typeof data.transcript === 'string' ? data.transcript.trim() : '';
    if (text) {
      const call = await loadCall(callSid);
      const session = getSession(callSid);
      if (db.enabled) {
        const result = await persistUtterance(body, resolveSpeaker(call?.direction || session?.direction, body.Track), text);
        if (!result.inserted) return res.sendStatus(204);
      }
      runTracked('onUtterance', { callSid, track: body.Track, transcript: text }, () => onUtterance(callSid, body.Track, text));
    }
  } else if (body.TranscriptionEvent === 'transcription-stopped' && db.enabled) {
    // Stop can precede hangup (including an explicit Stop verb). Do not invent
    // a completed lifecycle here; use root status / Dial action for that.
    await db.transaction(async tx => {
      await tx.query('UPDATE calls SET transcript_stopped_at=now() WHERE twilio_call_sid=$1', [callSid]);
      await enqueueJob('recap', `recap:${callSid}`, { callSid }, { delayMs: 1500, refresh: true, connection: tx });
    });
  } else if (body.TranscriptionEvent === 'transcription-error' && db.enabled) {
    await db.query("UPDATE calls SET recap_state='transcription_error' WHERE twilio_call_sid=$1", [callSid]);
  }
  res.sendStatus(204);
}));
