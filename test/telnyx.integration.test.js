import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const enabled = !!process.env.VOIP_TEST_DATABASE_URL;
if (enabled) process.env.DATABASE_URL = process.env.VOIP_TEST_DATABASE_URL;
const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { startTelnyxOutbound, runTelnyxStart, handleTelnyxEvent, transferTelnyx } = await import('../src/services/telnyx-voice.js');
const { telnyxCommand } = await import('../src/providers/telnyx.js');
const { loadCall, createCall } = await import('../src/services/call-state.js');
const { updateOrganization } = await import('../src/services/call-organization.js');
const { restoreSession } = await import('../src/realtime/orchestrator.js');
const { getSession } = await import('../src/realtime/sessions.js');
const { saveAssemblyTurn } = await import('../src/realtime/transcription.js');
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const originalFetch = globalThis.fetch;
const requests = [];
const prefix = randomUUID();
before(() => {
  if (!enabled) return;
  config.voiceProvider = 'telnyx';
  Object.assign(config.telnyx, { apiKey: 'test', mediaSecret: 'x'.repeat(40), connectionId: 'app-test', callerId: '+12025550100' });
  config.publicBaseUrl = 'https://phone.test'; config.defaultAgentIdentity = `alice-${prefix}`;
  config.auth.agents = ['alice','bob'].map(name => ({ identity: `${name}-${prefix}`, role: 'agent', telnyxSipUsername: `gencred${name}`, telnyxCredentialId: name }));
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body || '{}'); requests.push({ url, body });
    const data = url.endsWith('/v2/calls') ? { call_control_id: `v3:${randomUUID()}`, call_leg_id: randomUUID(), call_session_id: randomUUID() } : {};
    requests.at(-1).response = data;
    return new globalThis.Response(JSON.stringify({ data }), { status: 200 });
  };
});
after(async () => { globalThis.fetch = originalFetch; await db.close(); });
const agent = name => ({ identity: `${name}-${prefix}`, role: 'agent' });
async function event(control, type, extra = {}) {
  const leg = (await db.query('SELECT * FROM call_legs WHERE control_id=$1', [control])).rows[0];
  const req = [...requests].reverse().find(r => r.response.call_control_id === control);
  await handleTelnyxEvent({ id: randomUUID(), event_type: type, occurred_at: new Date().toISOString(),
    payload: { call_control_id: control, call_leg_id: leg?.sid || req?.response.call_leg_id,
      connection_id: 'app-test', client_state: req?.body.client_state, ...extra } });
}
integration('outbound native flow binds two legs, gates disclosure, records and keeps history stable', async () => {
  const key = randomUUID(), alice = agent('alice').identity;
  const root = await startTelnyxOutbound(alice, '+12025550111', key);
  assert.equal(await startTelnyxOutbound(alice, '+12025550111', key), root);
  await assert.rejects(startTelnyxOutbound(alice, '+12025550112', randomUUID()), /active or pending/);
  await runTelnyxStart({ root }); await runTelnyxStart({ root });
  let call = await loadCall(root); const a = call.provider_state.agent;
  assert.equal(requests.filter(r => r.url.endsWith('/v2/calls')).length, 1);
  await event(a, 'call.answered');
  call = await loadCall(root); const customer = call.provider_state.customer;
  await event(customer, 'call.answered');
  const speak = requests.find(r => r.url.includes('/speak'));
  assert.ok(speak); assert.ok(!requests.some(r => r.url.includes('/bridge')));
  await event(customer, 'call.speak.ended', { client_state: speak.body.client_state });
  assert.equal(requests.find(r => r.url.endsWith('/bridge')).body.call_control_id, a);
  await event(customer, 'call.bridged');
  assert.equal((await loadCall(root)).status, 'in_progress');
  await saveAssemblyTurn({ callSid: root, streamSid: 'media', track: 'inbound', turn: { turn_order: 0, transcript: 'Customer words' }, timestamp: Date.now() });
  await saveAssemblyTurn({ callSid: root, streamSid: 'media', track: 'outbound', turn: { turn_order: 0, transcript: 'Agent words' }, timestamp: Date.now() });
  assert.deepEqual((await db.query('SELECT speaker FROM transcript_segments WHERE call_sid=$1 ORDER BY seq', [root])).rows.map(r => r.speaker), ['customer','agent']);
  await event(customer, 'call.hangup');
  await event(customer, 'call.answered');
  assert.equal((await loadCall(root)).status, 'completed');
  assert.equal((await loadCall(root)).provider, 'telnyx');
});
integration('inbound browser routing, transfer identity and voicemail recording are durable', async () => {
  const customer = `v3:${randomUUID()}`, session = randomUUID();
  await handleTelnyxEvent({ id: randomUUID(), event_type: 'call.initiated', payload: {
    call_control_id: customer, call_leg_id: randomUUID(), call_session_id: session, connection_id: 'app-test',
    direction: 'incoming', from: '+12025550122', to: config.telnyx.callerId,
  } });
  const root = `tn_${session}`;
  await event(customer, 'call.answered');
  const disclosure = [...requests].reverse().find(r => r.url.includes('/speak'));
  await event(customer, 'call.speak.ended', { client_state: disclosure.body.client_state });
  let leg = (await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent'", [root])).rows[0];
  await event(leg.control_id, 'call.answered'); await event(customer, 'call.bridged');
  assert.equal((await loadCall(root)).agent_identity, agent('alice').identity);
  await restoreSession(root);
  await transferTelnyx(await loadCall(root), agent('bob').identity, randomUUID());
  const transfer = requests.at(-1);
  assert.ok(transfer.url.endsWith('/transfer'));
  const target = `v3:${randomUUID()}`, targetId = randomUUID();
  await handleTelnyxEvent({ id: randomUUID(), event_type: 'call.answered', payload: { connection_id: 'app-test', call_control_id: target,
    call_leg_id: targetId, client_state: transfer.body.target_leg_client_state } });
  await event(customer, 'call.bridged');
  assert.equal((await loadCall(root)).agent_identity, agent('bob').identity);
  assert.equal(getSession(root).identity, agent('bob').identity);
  const recordingId = randomUUID();
  await event(customer, 'call.recording.saved', { recording_id: recordingId, recording_started_at: '2026-01-01T00:00:00Z', recording_ended_at: '2026-01-01T00:00:30Z' });
  assert.equal((await db.query('SELECT provider FROM call_recordings WHERE recording_sid=$1', [recordingId])).rows[0].provider, 'telnyx');
  await event(customer, 'call.hangup');
});
integration('unknown provider command outcome cannot create a duplicate paid call', async () => {
  const saved = globalThis.fetch; let attempts = 0;
  globalThis.fetch = async () => { attempts++; throw new Error('connection lost after provider accepted'); };
  try {
    const key = `uncertain:${prefix}`;
    await assert.rejects(telnyxCommand(key, '/calls', { to: '+12025550111' }));
    await assert.rejects(telnyxCommand(key, '/calls', { to: '+12025550111' }), /reconciliation/);
    assert.equal(attempts, 1);
  } finally { globalThis.fetch = saved; }
});
integration('simultaneous agent answers select one winner and preserve explicit ownership', async () => {
  const customer = `v3:${randomUUID()}`, session = randomUUID(), root = `tn_${session}`;
  const identities = [agent('alice').identity, agent('bob').identity];
  config.voice.routing = { agents: identities, strategy: 'simultaneous' };
  for (const identity of identities) await db.query(`INSERT INTO agent_presence(identity,status) VALUES($1,'available')
    ON CONFLICT(identity) DO UPDATE SET status='available',heartbeat_at=now(),reserved_until=NULL`, [identity]);
  try {
    await handleTelnyxEvent({ id: randomUUID(), event_type: 'call.initiated', payload: {
      call_control_id: customer, call_leg_id: randomUUID(), call_session_id: session, connection_id: 'app-test',
      direction: 'incoming', from: '+12025550124', to: config.telnyx.callerId,
    } });
    await event(customer, 'call.answered');
    const disclosure = [...requests].reverse().find(r => r.url.includes('/speak'));
    await event(customer, 'call.speak.ended', { client_state: disclosure.body.client_state });
    const legs = (await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent' ORDER BY agent_identity", [root])).rows;
    assert.equal(legs.length, 2);
    await updateOrganization(root, { identity: 'supervisor', role: 'admin' }, { assignedTo: agent('bob').identity, tags: ['Review'], version: 0 });
    await Promise.all(legs.map(l => event(l.control_id, 'call.answered')));
    const call = await loadCall(root);
    assert.equal(call.provider_state.phase, 'bridging');
    assert.ok(legs.some(l => l.control_id === call.provider_state.agent && l.agent_identity === call.agent_identity));
    assert.equal(call.assigned_to, agent('bob').identity);
    assert.equal((await db.query("SELECT count(*)::int n FROM telnyx_commands WHERE command_key=$1", [`${root}:bridge:0`])).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int n FROM service_jobs WHERE kind='telnyxHangup' AND payload->>'root'=$1", [root])).rows[0].n, 1);
    await event(customer, 'call.hangup');
  } finally { config.voice.routing = null; }
});
integration('unanswered inbound call reaches voicemail and recording completion queues hangup', async () => {
  const customer = `v3:${randomUUID()}`, session = randomUUID(), root = `tn_${session}`;
  await handleTelnyxEvent({ id: randomUUID(), event_type: 'call.initiated', payload: {
    call_control_id: customer, call_leg_id: randomUUID(), call_session_id: session, connection_id: 'app-test',
    direction: 'incoming', from: '+12025550125', to: config.telnyx.callerId,
  } });
  await event(customer, 'call.answered');
  const disclosure = [...requests].reverse().find(r => r.url.includes('/speak'));
  await event(customer, 'call.speak.ended', { client_state: disclosure.body.client_state });
  const leg = (await db.query("SELECT * FROM call_legs WHERE call_sid=$1 AND purpose='agent'", [root])).rows[0];
  await event(leg.control_id, 'call.hangup');
  const greeting = [...requests].reverse().find(r => r.url.includes('/speak'));
  await event(customer, 'call.speak.ended', { client_state: greeting.body.client_state });
  assert.equal((await loadCall(root)).provider_state.phase, 'voicemail');
  assert.equal(requests.at(-1).body.max_length, 120);
  const recording = randomUUID();
  await event(customer, 'call.recording.saved', { recording_id: recording });
  assert.equal((await db.query('SELECT kind FROM call_recordings WHERE recording_sid=$1', [recording])).rows[0].kind, 'voicemail');
  assert.equal((await db.query("SELECT count(*)::int n FROM service_jobs WHERE job_key=$1", [`telnyx-hangup:${root}:voicemail-done`])).rows[0].n, 1);
  await event(customer, 'call.hangup');
  assert.equal((await loadCall(root)).status, 'missed');
});
integration('owner and multiple tags persist atomically, reject stale edits and unauthorized access', async () => {
  const root = `organization-${prefix}`;
  await createCall({ callSid: root, direction: 'inbound', from: '+12025550123', to: '+12025550100', identity: agent('alice').identity });
  const body = { assignedTo: agent('bob').identity, tags: ['Commercial Auto','Follow-up','commercial auto'], version: 0 };
  const outcomes = await Promise.allSettled([updateOrganization(root, agent('alice'), body), updateOrganization(root, agent('alice'), body)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const call = await loadCall(root);
  assert.equal(call.agent_identity, agent('alice').identity); assert.equal(call.assigned_to, agent('bob').identity);
  assert.deepEqual(call.tags, ['Commercial Auto','Follow-up']);
  await assert.rejects(updateOrganization(root, { identity: 'outsider', role: 'agent' }, { ...body, version: 1 }), /not found/);
  await assert.rejects(updateOrganization(root, { ...agent('bob'), role: 'viewer' }, { ...body, version: 1 }), /not found/);
  await updateOrganization(root, agent('bob'), { assignedTo: null, tags: [], version: 1 });
  const cleared = await loadCall(root); assert.equal(cleared.assigned_to, null); assert.deepEqual(cleared.tags, []);
});
