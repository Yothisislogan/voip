import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { config } from '../src/config.js';
import { verifyTelnyxWebhook, voiceToken, sipDestination } from '../src/providers/telnyx.js';
import { normalizeTags } from '../src/services/call-organization.js';
import { canAccessCall } from '../src/auth/call-access.js';
import { attachMediaWss } from '../src/realtime/media.js';
import { streamTicket } from '../src/realtime/transcription.js';

test('Telnyx signature requires exact body, valid key, and fresh timestamp', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  config.telnyx.publicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const raw = Buffer.from('{"data":{"id":"event-1"}}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = { 'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), privateKey).toString('base64') };
  assert.equal(verifyTelnyxWebhook(raw, headers), true);
  assert.equal(verifyTelnyxWebhook(Buffer.from('{}'), headers), false);
  assert.equal(verifyTelnyxWebhook(raw, headers, Date.now() + 301000), false);
  assert.equal(verifyTelnyxWebhook(raw, {}), false);
});
test('tags are bounded, normalized, deduplicated and removable; owner gains record access', () => {
  assert.deepEqual(normalizeTags([' Commercial  Auto ', 'commercial auto', 'Follow-up']), ['Commercial Auto','Follow-up']);
  assert.deepEqual(normalizeTags([]), []);
  for (const invalid of [null, 'x', [''], ['a,b'], ['x'.repeat(41)], ['x\u0000'], Array(21).fill('x')]) assert.throws(() => normalizeTags(invalid));
  const call = { agent_identity: 'alice', assigned_to: 'bob', route_targets: ['outsider'] };
  assert.equal(canAccessCall({ identity: 'bob', role: 'agent' }, call), true);
  assert.equal(canAccessCall({ identity: 'outsider', role: 'agent' }, call), false);
  assert.equal(canAccessCall({ identity: 'alice', role: 'agent' }, call), true);
});
test('token and SIP destination only use configured authenticated agent mapping', async () => {
  config.auth.agents = [{ identity: 'alice', role: 'agent', telnyxSipUsername: 'gencredAlice' }];
  assert.equal(sipDestination('alice'), 'sip:gencredAlice@sip.telnyx.com');
  assert.throws(() => sipDestination('mallory'));
  await assert.rejects(voiceToken('mallory'));
});
test('Telnyx media ticket, customer-leg binding, separate audio tracks and reordering', async t => {
  config.voiceProvider = 'telnyx'; config.telnyx.mediaSecret = 'a'.repeat(40);
  config.transcription.provider = 'assemblyai'; config.transcription.apiKey = 'test';
  const root = `tn_${'a'.repeat(32)}`, stream = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const frames = [], states = [];
  const server = http.createServer();
  const bridge = attachMediaWss(server, {
    lookupCall: async () => ({ twilio_call_sid: root, provider: 'telnyx', provider_state: { customer: 'control-customer' } }),
    makeTrack: () => ({ audio: (bytes, timestamp) => frames.push([bytes[0], timestamp]), finish: async () => {} }),
    setState: async (...args) => states.push(args),
  });
  server.listen(0); await once(server, 'listening');
  t.after(async () => { await bridge.close(); await new Promise(r => server.close(r)); config.voiceProvider = 'twilio'; });
  const base = `ws://127.0.0.1:${server.address().port}/voice/media`;
  const invalid = new WebSocket(`${base}?call=${root}&ticket=bad`);
  assert.match((await once(invalid, 'error'))[0].message, /403/);
  const ws = new WebSocket(`${base}?call=${root}&ticket=${encodeURIComponent(streamTicket(root))}`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'start', stream_id: stream, start: { call_control_id: 'control-customer', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
  for (const [track, timestamp, value] of [['inbound',20,2], ['inbound',0,1], ['outbound',0,3]]) ws.send(JSON.stringify({ event: 'media', stream_id: stream,
    media: { track, timestamp, payload: Buffer.alloc(160, value).toString('base64') } }));
  await new Promise(r => setTimeout(r, 160));
  ws.send(JSON.stringify({ event: 'stop', stream_id: stream })); await once(ws, 'close');
  assert.deepEqual(frames, [[1,0],[2,20],[3,0]]);
  assert.equal(states.at(-1)[1], 'stopped');
});
