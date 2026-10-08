import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';
import { config, webhookUrl } from '../config.js';
import { telnyxCommand, sipDestination, telnyxRequest } from '../providers/telnyx.js';
import { createCall, loadCall, callPayload } from './call-state.js';
import { selectTargets } from './routing.js';
import { enqueueJob } from '../jobs/queue.js';
import { emitWitnextEvent } from '../integrations/witnext.js';
import { getSession } from '../realtime/sessions.js';
import { publishToAgent } from '../realtime/bus.js';
import { mediaEvents, streamTicket, setTranscriptionState } from '../realtime/transcription.js';

const disclosure = 'This call may be recorded and transcribed for quality and training.';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
function context(root, purpose, identity = null, generation = 0, phase = '') {
  const data = { root, purpose, identity, generation, phase };
  return encode({ ...data, mac: createHmac('sha256', config.telnyx.mediaSecret).update(JSON.stringify(data)).digest('hex') });
}
export function decodeContext(value) {
  try {
    const { mac, ...data } = JSON.parse(Buffer.from(value || '', 'base64').toString());
    const expected = createHmac('sha256', config.telnyx.mediaSecret).update(JSON.stringify(data)).digest('hex');
    return typeof mac === 'string' && mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? data : null;
  } catch { return null; }
}
const action = (root, name, control, body = {}) => telnyxCommand(`${root}:${name}`, `/calls/${encodeURIComponent(control)}/actions/${name.split(':')[0]}`, body);

async function dial(root, purpose, to, identity, generation, tx, timeout = 25) {
  const result = await telnyxCommand(`${root}:dial:${purpose}:${identity || ''}:${generation}`, '/calls', {
    connection_id: config.telnyx.connectionId, from: config.telnyx.callerId, to,
    timeout_secs: timeout, time_limit_secs: 14400,
    client_state: context(root, purpose, identity, generation),
    custom_headers: [{ name: 'X-Wit-Call', value: root }],
    webhook_url: webhookUrl('/telnyx/voice'), webhook_url_method: 'POST',
  });
  if (!result?.call_control_id || !result.call_leg_id) throw new Error('Telnyx dial response missing identifiers');
  await tx.query(`INSERT INTO call_legs(sid,call_sid,agent_identity,status,provider,control_id,purpose,generation)
    VALUES($1,$2,$3,'queued','telnyx',$4,$5,$6) ON CONFLICT(sid) DO NOTHING`,
  [result.call_leg_id, root, identity, result.call_control_id, purpose, generation]);
  return result.call_control_id;
}

export async function startTelnyxOutbound(identity, to, requestId) {
  const root = `tn_${createHmac('sha256', config.telnyx.mediaSecret).update(`${identity}:${to}:${requestId}`).digest('hex').slice(0,32)}`;
  sipDestination(identity);
  await db.transaction(async tx => {
    // Agent lock serializes clicks with different idempotency keys as well.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`telnyx-dial:${identity}`]);
    const prior = (await tx.query('SELECT 1 FROM calls WHERE twilio_call_sid=$1', [root])).rows.length;
    if (prior) return;
    const busy = (await tx.query(`SELECT 1 FROM calls WHERE agent_identity=$1 AND provider='telnyx'
      AND ended_at IS NULL AND created_at>now()-interval '4 hours' LIMIT 1`, [identity])).rows.length;
    if (busy) throw Object.assign(new Error('You already have an active or pending call'), { status: 409 });
    await tx.query(`INSERT INTO calls(twilio_call_sid,direction,from_e164,to_e164,customer_number,agent_identity,assigned_to,status,provider)
      VALUES($1,'outbound',$2,$3,$3,$4,$4,'queued','telnyx')`, [root, config.telnyx.callerId, to, identity]);
    await enqueueJob('telnyxStart', `telnyx-start:${root}`, { root }, { connection: tx });
    await enqueueJob('telnyxTimeout', `telnyx-timeout:${root}`, { root }, { delayMs: 90000, connection: tx });
  });
  return root;
}
export async function runTelnyxStart({ root }) {
  await db.transaction(async tx => {
    const call = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [root])).rows[0];
    if (!call || call.ended_at || call.provider_state.agent) return;
    const agent = await dial(root, 'agent', sipDestination(call.agent_identity), call.agent_identity, 0, tx);
    await tx.query("UPDATE calls SET provider_state=$2,status='ringing' WHERE twilio_call_sid=$1", [root, JSON.stringify({ phase: 'agent_ringing', agent, generation: 0 })]);
  });
}

async function prepareInbound(payload) {
  if (payload.connection_id !== config.telnyx.connectionId || payload.direction !== 'incoming' || payload.to !== config.telnyx.callerId) return null;
  const root = `tn_${payload.call_session_id}`;
  const route = await selectTargets(root);
  await createCall({ callSid: root, direction: 'inbound', from: payload.from, to: payload.to, targets: route.targets });
  await db.query(`UPDATE calls SET provider='telnyx',provider_session_id=$2,
    provider_state=CASE WHEN provider_state='{}' THEN $3::jsonb ELSE provider_state END WHERE twilio_call_sid=$1`,
  [root, payload.call_session_id, JSON.stringify({ phase: 'new', customer: payload.call_control_id, generation: 0, timeout: route.timeout })]);
  await db.query(`INSERT INTO call_legs(sid,call_sid,status,provider,control_id,purpose) VALUES($1,$2,'queued','telnyx',$3,'customer') ON CONFLICT DO NOTHING`,
    [payload.call_leg_id, root, payload.call_control_id]);
  await enqueueJob('telnyxTimeout', `telnyx-timeout:${root}`, { root }, { delayMs: 90000 });
  return root;
}

export async function handleTelnyxEvent(event) {
  const p = event.payload;
  let leg = (await db.query('SELECT * FROM call_legs WHERE control_id=$1 AND provider=\'telnyx\'', [p.call_control_id])).rows[0];
  const ctx = decodeContext(p.client_state);
  let root = leg?.call_sid;
  if (!root && ctx?.purpose === 'transfer') {
    const owner = await loadCall(ctx.root);
    if (owner?.provider === 'telnyx' && owner.provider_state.generation === ctx.generation &&
        owner.route_targets.includes(ctx.identity)) {
      await db.query(`INSERT INTO call_legs(sid,call_sid,agent_identity,status,provider,control_id,purpose,generation)
        VALUES($1,$2,$3,'queued','telnyx',$4,'agent',$5) ON CONFLICT DO NOTHING`,
      [p.call_leg_id, ctx.root, ctx.identity, p.call_control_id, ctx.generation]);
      root = ctx.root;
    }
  }
  if (!root && ctx) throw new Error('Telnyx dial context not committed yet');
  if (!root && event.event_type === 'call.initiated') root = await prepareInbound(p);
  if (!root && p.connection_id === config.telnyx.connectionId && !['call.initiated','streaming.started','streaming.stopped'].includes(event.event_type)) throw new Error('Telnyx call context not committed yet');
  if (!root) return;
  await db.transaction(async tx => {
    const call = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [root])).rows[0];
    if (!call) return;
    leg = (await tx.query('SELECT * FROM call_legs WHERE control_id=$1', [p.call_control_id])).rows[0];
    if (!leg) throw new Error('Telnyx leg not committed yet');
    const s = call.provider_state;
    const type = event.event_type;
    const customer = leg.purpose === 'customer';
    const generation = leg.generation;
    const speak = (phase, text) => action(root, `speak:${phase}:${s.generation}`, s.customer, {
      payload: text, voice: 'female', language: 'en-US', service_level: 'basic',
      client_state: context(root, 'customer', null, s.generation, phase),
    });
    const voicemail = async () => {
      s.phase = 'voicemail_greeting';
      await speak('voicemail', 'Sorry we missed you. Please leave your name, callback number, and message after the tone.');
      await tx.query('UPDATE calls SET is_voicemail=true WHERE twilio_call_sid=$1', [root]);
    };
    const hangup = async (control, suffix) => {
      if (!control) return;
      const ended = (await tx.query("SELECT 1 FROM call_legs WHERE control_id=$1 AND status='completed'", [control])).rows.length;
      if (!ended) await enqueueJob('telnyxHangup', `telnyx-hangup:${root}:${suffix}`, { root, control, suffix }, { connection: tx });
    };
    if (type === 'call.recording.saved') {
      if (!/^[a-f0-9-]{36}$/i.test(p.recording_id || '')) return;
      const duration = Math.max(0, Math.round((Date.parse(p.recording_ended_at) - Date.parse(p.recording_started_at)) / 1000)) || 0;
      await tx.query(`INSERT INTO call_recordings(recording_sid,call_sid,duration_seconds,status,kind,provider)
        VALUES($1,$2,$3,'completed',$4,'telnyx') ON CONFLICT(recording_sid) DO NOTHING`,
      [p.recording_id, root, duration, call.is_voicemail ? 'voicemail' : 'call']);
      await tx.query("UPDATE calls SET recording_state='stopped' WHERE twilio_call_sid=$1", [root]);
      await emitWitnextEvent('call.recording_available', { ...callPayload(call), recording_id: p.recording_id,
        recording_reference: `${config.publicBaseUrl}/api/phone/calls/${encodeURIComponent(root)}/recordings/${p.recording_id}` }, { connection: tx });
      if (s.phase === 'voicemail' && !call.ended_at) await hangup(s.customer, 'voicemail-done');
      return;
    }
    if (call.ended_at) {
      // Cancel any late answered legs after caller cancellation or a restart.
      if (['call.answered','call.initiated'].includes(type)) await hangup(p.call_control_id, `late:${leg.sid}`);
      return;
    }
    if (type === 'call.initiated' && customer && call.direction === 'inbound' && s.phase === 'new') {
      await action(root, 'answer', s.customer, { client_state: context(root, 'customer') });
      s.phase = 'answering';
    }
    if (type === 'call.answered') {
      if (leg.status === 'completed') return;
      await tx.query("UPDATE call_legs SET status='in_progress' WHERE sid=$1", [leg.sid]);
      if (customer && ['answering','customer_ringing','new'].includes(s.phase)) {
        s.phase = 'disclosure';
        await speak('disclosure', `${call.direction === 'inbound' ? 'Thank you for calling We Insure Things. ' : ''}${disclosure}`);
      } else if (!customer && call.direction === 'outbound' && s.phase === 'agent_ringing') {
        s.agent = p.call_control_id;
        s.customer = await dial(root, 'customer', call.to_e164, null, 0, tx, 45);
        s.phase = 'customer_ringing';
      } else if (!customer && generation === s.generation && ['ringing','transferring'].includes(s.phase)) {
        s.agent = p.call_control_id; s.phase = 'bridging';
        if (ctx?.purpose !== 'transfer') await action(root, `bridge:${s.generation}`, s.customer, { call_control_id: s.agent, prevent_double_bridge: true });
        // A single winner owns the audio; other ringing agents are cancelled.
        const others = (await tx.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent' AND control_id<>$2 AND status<>'completed'", [root, s.agent])).rows;
        for (const other of others) await hangup(other.control_id, `loser:${other.sid}`);
        await tx.query(`UPDATE calls SET agent_identity=$2,assigned_to=CASE WHEN assignment_explicit THEN assigned_to ELSE $2 END WHERE twilio_call_sid=$1`, [root, leg.agent_identity]);
      } else if (!customer && p.call_control_id !== s.agent) await hangup(p.call_control_id, `loser:${leg.sid}`);
    }
    if (type === 'call.speak.ended' && customer && ctx?.phase === 'disclosure' && s.phase === 'disclosure') {
      await tx.query("UPDATE calls SET consent_state='disclosed',consent_at=now() WHERE twilio_call_sid=$1", [root]);
      await tx.query("INSERT INTO consent_events(call_sid,kind,state,method) VALUES($1,'disclosure','disclosed','ivr_disclosure')", [root]);
      if (call.direction === 'outbound') {
        await action(root, 'bridge:0', s.customer, { call_control_id: s.agent, prevent_double_bridge: true });
        s.phase = 'bridging';
      } else {
        const targets = call.route_targets.filter(id => config.auth.agents.some(a => a.identity === id && a.telnyxSipUsername && a.role !== 'viewer'));
        if (!targets.length) await voicemail();
        else {
          for (const identity of targets) await dial(root, 'agent', sipDestination(identity), identity, s.generation, tx, s.timeout);
          s.phase = 'ringing';
          await tx.query("UPDATE calls SET status='ringing' WHERE twilio_call_sid=$1", [root]);
        }
      }
    }
    if (type === 'call.speak.ended' && ctx?.phase === 'disclosure' && ['new','answering','customer_ringing'].includes(s.phase)) throw new Error('Disclosure event arrived before answered event');
    if (type === 'call.bridged' && ['ringing','transferring','disclosure'].includes(s.phase)) throw new Error('Bridge event arrived before call setup');
    if (type === 'call.bridged' && ['bridging','active'].includes(s.phase)) {
      s.phase = 'active';
      await tx.query("UPDATE calls SET status='in_progress',answered_at=coalesce(answered_at,now()) WHERE twilio_call_sid=$1", [root]);
      if (config.voice.recordingEnabled) await action(root, 'record_start:conversation', s.customer, { format: 'mp3', channels: 'dual', recording_track: 'both' });
      await enqueueJob('telnyxMedia', `telnyx-media:${root}`, { root }, { connection: tx });
      await enqueueJob('screenPop', `screenpop:${root}:${s.generation}`, { callSid: root }, { connection: tx });
    }
    if (type === 'call.speak.ended' && ctx?.phase === 'voicemail' && s.phase === 'voicemail_greeting') {
      s.phase = 'voicemail';
      await action(root, `record_start:voicemail:${s.generation}`, s.customer, { format: 'mp3', channels: 'single', recording_track: 'inbound', play_beep: true, max_length: 120 });
    }
    if (type === 'call.hangup') {
      await tx.query("UPDATE call_legs SET status='completed' WHERE sid=$1", [leg.sid]);
      const remaining = (await tx.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent' AND generation=$2 AND status<>'completed'", [root, s.generation])).rows;
      if (!customer && ['ringing','transferring'].includes(s.phase) && !remaining.length) await voicemail();
      else if (customer || (p.call_control_id === s.agent && !['transferring','ringing'].includes(s.phase))) {
        const others = (await tx.query("SELECT * FROM call_legs WHERE call_sid=$1 AND status<>'completed'", [root])).rows;
        for (const other of others) await hangup(other.control_id, `end:${other.sid}`);
        s.phase = 'ended';
        const updated = (await tx.query(`UPDATE calls SET status=CASE WHEN answered_at IS NOT NULL THEN 'completed'
          WHEN direction='outbound' THEN 'missed' WHEN is_voicemail THEN 'missed' ELSE 'abandoned' END,
          ended_at=now(),duration_seconds=CASE WHEN answered_at IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM now()-answered_at)::int) END
          WHERE twilio_call_sid=$1 RETURNING *`, [root])).rows[0];
        await emitWitnextEvent('call.completed', callPayload(updated), { connection: tx });
        await enqueueJob('recap', `recap:${root}`, { callSid: root }, { delayMs: 2500, refresh: true, connection: tx });
        await tx.query('UPDATE agent_presence SET reserved_call_sid=NULL,reserved_until=NULL WHERE reserved_call_sid=$1', [root]);
      }
    }
    await tx.query('UPDATE calls SET provider_state=$2,updated_at=now() WHERE twilio_call_sid=$1', [root, JSON.stringify(s)]);
  });
  const current = await loadCall(root);
  const session = getSession(root);
  if (session && current?.agent_identity) session.identity = current.agent_identity;
  if (current?.ended_at || event.event_type === 'streaming.stopped') mediaEvents.emit('stop', root);
  if (event.event_type === 'streaming.failed') await setTranscriptionState(root, 'error', 'telnyx_stream_failed');
  for (const identity of new Set([current?.agent_identity, current?.assigned_to, ...(current?.route_targets || [])].filter(Boolean))) {
    publishToAgent(identity, 'call_status', { callSid: root, status: current.status });
  }
}

export async function startTelnyxMedia({ root }) {
  const call = await loadCall(root);
  if (!call || call.ended_at || (!config.coachingEnabled && !config.recapEnabled)) return;
  const url = new URL(webhookUrl('/voice/media').replace(/^https:/, 'wss:'));
  url.search = new URLSearchParams({ call: root, ticket: streamTicket(root) }).toString();
  try {
    await action(root, 'streaming_start', call.provider_state.customer, { stream_url: url.toString(), stream_track: 'both_tracks', stream_codec: 'PCMU' });
  } catch (error) {
    await setTranscriptionState(root, 'error', 'telnyx_stream_start_failed');
    throw error;
  }
}

export async function transferTelnyx(call, identity, token) {
  await db.transaction(async tx => {
    const current = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [call.twilio_call_sid])).rows[0];
    const receipt = await tx.query('INSERT INTO service_receipts(receipt_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING receipt_key', [`telnyx-transfer:${call.twilio_call_sid}:${token}`]);
    if (!receipt.rows.length) throw Object.assign(new Error('Transfer already requested; inspect call before retrying'), { status: 409 });
    if (current.provider_state.phase !== 'active') throw Object.assign(new Error('Call is not ready to transfer'), { status: 409 });
    const s = current.provider_state;
    const generation = (s.generation || 0) + 1;
    await action(call.twilio_call_sid, `transfer:${generation}`, s.customer, {
      to: sipDestination(identity), from: config.telnyx.callerId, timeout_secs: 25,
      target_leg_client_state: context(call.twilio_call_sid, 'transfer', identity, generation),
      custom_headers: [{ name: 'X-Wit-Call', value: call.twilio_call_sid }],
      webhook_url: webhookUrl('/telnyx/voice'),
    });
    s.generation = generation; s.phase = 'transferring'; s.transferRequest = token; s.agent = null;
    await tx.query("UPDATE calls SET provider_state=$2,disposition='transferring',route_targets=$3 WHERE twilio_call_sid=$1", [call.twilio_call_sid, JSON.stringify(s), JSON.stringify([identity])]);
  });
}

export async function cancelTelnyx(call) {
  await db.transaction(async tx => {
    const current = (await tx.query('SELECT * FROM calls WHERE twilio_call_sid=$1 FOR UPDATE', [call.twilio_call_sid])).rows[0];
    if (current.ended_at) return;
    const control = current.provider_state.agent || current.provider_state.customer;
    if (control) await enqueueJob('telnyxHangup', `telnyx-cancel:${call.twilio_call_sid}`, { root: call.twilio_call_sid, control, suffix: 'user' }, { connection: tx });
    else await tx.query("UPDATE calls SET status='abandoned',ended_at=now() WHERE twilio_call_sid=$1", [call.twilio_call_sid]);
  });
}
export async function stopTelnyxLeg({ root, control, suffix }) {
  const leg = (await db.query('SELECT status FROM call_legs WHERE control_id=$1', [control])).rows[0];
  if (leg?.status === 'completed') return;
  try { await action(root, `hangup:${suffix}`, control); }
  catch (error) {
    // A racing provider hangup is already the desired state. Any other outcome
    // stays visible in the job queue for reconciliation.
    const status = await telnyxRequest(`/calls/${encodeURIComponent(control)}`);
    if (status?.is_alive !== false) throw error;
  }
}

export async function expireTelnyxSetup({ root }) {
  const call = await loadCall(root);
  if (!call || call.ended_at || call.answered_at || ['voicemail','voicemail_greeting'].includes(call.provider_state.phase)) return;
  const legs = (await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND status<>'completed'", [root])).rows;
  for (const leg of legs) await action(root, `hangup:setup-timeout:${leg.sid}`, leg.control_id);
  await db.query("UPDATE calls SET status='failed',ended_at=now(),disposition='setup_failed' WHERE twilio_call_sid=$1 AND answered_at IS NULL", [root]);
  for (const identity of new Set([call.agent_identity, ...call.route_targets].filter(Boolean))) publishToAgent(identity, 'call_status', { callSid: root, status: 'failed' });
}
