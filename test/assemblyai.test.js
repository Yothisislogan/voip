import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { AssemblyTrack } from '../src/realtime/assemblyai.js';
import { attachMediaWss, validMediaSignature } from '../src/realtime/media.js';
import { attachAgentWss } from '../src/realtime/ws.js';
import { streamTicket, verifyStreamTicket, startTranscription } from '../src/realtime/transcription.js';
import { config } from '../src/config.js';
import { resolveSpeaker } from '../src/realtime/orchestrator.js';

const sid = `CA${'1'.repeat(32)}`, streamSid = `MZ${'2'.repeat(32)}`;
const token = 'synthetic-twilio-token';
const account = `AC${'3'.repeat(32)}`;
Object.assign(config.twilio, { authToken: token, accountSid: account });
Object.assign(config.transcription, { provider: 'assemblyai', apiKey: 'synthetic-assembly-key' });
config.publicBaseUrl = 'https://phone.example.test';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } throw new Error('Timed out'); }
function fakeTrack() {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN; socket.bufferedAmount = 0; socket.sent = [];
  socket.send = value => socket.sent.push(value);
  socket.close = socket.terminate = () => { socket.readyState = WebSocket.CLOSED; };
  const turns = [], failures = [];
  const track = new AssemblyTrack({ apiKey: 'test', endpoint: 'wss://streaming.us.assemblyai.com/v3/ws', model: 'universal-streaming-english',
    onTurn: (t, offset) => turns.push({ t, offset }), onFailure: c => failures.push(c),
    createSocket: (url, options) => { socket.url = url; socket.options = options; return socket; } });
  const emit = msg => socket.emit('message', Buffer.from(JSON.stringify(msg)));
  return { socket, track, turns, failures, emit };
}

test('native 8k mu-law is batched after Begin, partial/repeated finals ignored, tail drained before termination', async () => {
  const { socket, track, turns, failures, emit } = fakeTrack();
  assert.equal(new URL(socket.url).searchParams.get('encoding'), 'pcm_mulaw');
  assert.equal(new URL(socket.url).searchParams.get('sample_rate'), '8000');
  assert.equal(socket.options.headers.Authorization, 'test');
  track.audio(Buffer.alloc(160, 1), 120);
  track.audio(Buffer.alloc(640, 2), 140);
  assert.equal(socket.sent.length, 0);
  emit({ type: 'Begin', id: 'session' });
  assert.deepEqual(socket.sent[0], Buffer.concat([Buffer.alloc(160, 1), Buffer.alloc(640, 2)]));
  emit({ type: 'Turn', turn_order: 0, end_of_turn: false, transcript: 'partial' });
  emit({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'final', words: [{ start: 80 }] });
  emit({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'Final.' });
  assert.equal(turns.length, 1); assert.equal(turns[0].offset, 200);
  track.audio(Buffer.alloc(160, 3), 220);
  const finished = track.finish();
  assert.equal(socket.sent[1].length, 800);
  assert.equal(socket.sent[1][159], 3); assert.equal(socket.sent[1][160], 255);
  assert.equal(JSON.parse(socket.sent.at(-1)).type, 'Terminate');
  emit({ type: 'Turn', turn_order: 1, end_of_turn: true, transcript: 'last words' });
  emit({ type: 'Termination' }); await finished;
  assert.equal(turns.length, 2); assert.deepEqual(failures, []);
});

test('startup buffers and provider errors fail visibly and close the paid session', async () => {
  const one = fakeTrack(); one.track.audio(Buffer.alloc(40_001), 0);
  await one.track.done; assert.deepEqual(one.failures, ['audio_buffer_overflow']);
  assert.equal(one.socket.readyState, WebSocket.CLOSED);
  const two = fakeTrack(); two.emit({ type: 'Error', error: 'do not expose credentials or provider text' });
  await two.track.done; assert.deepEqual(two.failures, ['assemblyai_provider_error']);
});

test('media signature uses configured origin and expiring ticket is bound to its call', () => {
  const url = `${config.publicBaseUrl}/voice/media`;
  const signature = twilio.getExpectedTwilioSignature(token, url, {});
  assert.equal(validMediaSignature({ url: '/voice/media', headers: { 'x-twilio-signature': signature, host: 'evil.test' } }), true);
  assert.equal(validMediaSignature({ url: '/voice/media?x=1', headers: { 'x-twilio-signature': signature } }), false);
  assert.equal(validMediaSignature({ url: '/voice/media', headers: {} }), false);
  const ticket = streamTicket(sid);
  assert.equal(verifyStreamTicket(sid, ticket), true);
  assert.equal(verifyStreamTicket(`CA${'9'.repeat(32)}`, ticket), false);
  assert.equal(verifyStreamTicket(sid, streamTicket(sid, Date.now() - 1)), false);
});

test('provider switch emits both-track Media Streams or legacy Twilio transcription, never both', () => {
  config.transcription.provider = 'assemblyai';
  const xml = new twilio.twiml.VoiceResponse(); startTranscription(xml, sid);
  assert.match(xml.toString(), /<Stream .*track="both_tracks"/);
  assert.match(xml.toString(), /wss:\/\/phone.example.test\/voice\/media/);
  assert.doesNotMatch(xml.toString(), /<Transcription/);
  config.transcription.provider = 'twilio';
  const legacy = new twilio.twiml.VoiceResponse(); startTranscription(legacy, sid);
  assert.match(legacy.toString(), /<Transcription/); assert.doesNotMatch(legacy.toString(), /<Stream /);
  config.transcription.provider = 'assemblyai';
  assert.equal(resolveSpeaker('inbound', 'inbound_track'), 'customer');
  assert.equal(resolveSpeaker('outbound', 'inbound_track'), 'agent');
  assert.equal(resolveSpeaker('outbound', 'outbound_track'), 'customer');
});

test('signed real WebSockets coexist with agent socket and retain both tracks and final words at stop', async t => {
  const upstream = new WebSocketServer({ port: 0 }); await once(upstream, 'listening');
  const sessions = [], saved = [], states = [];
  upstream.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, 'synthetic-assembly-key');
    const session = { audio: [], socket }; sessions.push(session);
    socket.send(JSON.stringify({ type: 'Begin', id: String(sessions.length) }));
    socket.on('message', (raw, binary) => {
      if (binary) session.audio.push(Buffer.from(raw));
      else if (JSON.parse(raw.toString()).type === 'Terminate') {
        socket.send(JSON.stringify({ type: 'Turn', turn_order: 0, end_of_turn: true, transcript: 'final test words' }));
        socket.send(JSON.stringify({ type: 'Termination' }));
      }
    });
  });
  const server = http.createServer(); attachAgentWss(server);
  const bridge = attachMediaWss(server, {
    makeTrack: opts => new AssemblyTrack({ ...opts, endpoint: `ws://127.0.0.1:${upstream.address().port}/v3/ws` }),
    lookupCall: async callSid => { await tick(); return { twilio_call_sid: callSid }; },
    saveTurn: async turn => { await tick(); saved.push(turn); },
    setState: async (...args) => states.push(args),
  });
  server.listen(0); await once(server, 'listening');
  t.after(async () => { await bridge.close(); await new Promise(r => server.close(r)); for (const x of upstream.clients) x.terminate(); await new Promise(r => upstream.close(r)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/voice/media`, { headers: {
    'x-twilio-signature': twilio.getExpectedTwilioSignature(token, `${config.publicBaseUrl}/voice/media`, {}),
  } });
  await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'start', streamSid, start: { accountSid: account, callSid: sid, streamSid,
    tracks: ['inbound', 'outbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    customParameters: { ticket: streamTicket(sid) } } }));
  // Send immediately: start and media can arrive in the same TCP packet.
  for (const track of ['inbound', 'outbound']) ws.send(JSON.stringify({ event: 'media', streamSid,
    media: { track, timestamp: '0', payload: Buffer.alloc(160, track === 'inbound' ? 1 : 2).toString('base64') } }));
  await until(() => sessions.length === 2);
  ws.send(JSON.stringify({ event: 'stop', streamSid }));
  await once(ws, 'close');
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map(s => s.track).sort(), ['inbound', 'outbound']);
  assert.ok(saved.every(s => s.callSid === sid && s.turn.transcript === 'final test words'));
  assert.equal(sessions[0].audio[0][0], 1); assert.equal(sessions[1].audio[0][0], 2);
  assert.equal(states.at(-1)[1], 'stopped'); assert.equal(bridge.activeCalls, 0);
});

test('unsigned media upgrade is rejected before any provider session opens', async t => {
  const server = http.createServer(); let opened = 0;
  const bridge = attachMediaWss(server, { makeTrack: () => { opened++; } });
  server.listen(0); await once(server, 'listening');
  t.after(async () => { await bridge.close(); await new Promise(r => server.close(r)); });
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/voice/media`);
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/); assert.equal(opened, 0);
});
