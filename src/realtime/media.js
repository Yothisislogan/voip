import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { config, webhookUrl } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';
import { loadCall } from '../services/call-state.js';
import { AssemblyTrack } from './assemblyai.js';
import { mediaEvents, MEDIA_PATH, verifyStreamTicket, saveAssemblyTurn, setTranscriptionState } from './transcription.js';

export function validMediaSignature(req) {
  if (config.voiceProvider === 'telnyx') {
    const url = new URL(req.url, 'https://media.invalid');
    return url.pathname === MEDIA_PATH && /^tn_[a-zA-Z0-9-]{16,64}$/.test(url.searchParams.get('call') || '') && verifyStreamTicket(url.searchParams.get('call'), url.searchParams.get('ticket'));
  }
  if (!config.twilio.authToken || !config.publicBaseUrl.startsWith('https://') || req.url !== MEDIA_PATH) return false;
  const signature = req.headers['x-twilio-signature'];
  if (typeof signature !== 'string') return false;
  // Providers/proxies may canonicalize the secure upgrade scheme differently.
  // Both candidates use OUR configured origin, never Host/Forwarded headers.
  const url = webhookUrl(MEDIA_PATH);
  return [url, url.replace(/^https:/, 'wss:')].some(value => twilio.validateRequest(config.twilio.authToken, signature, value, {}));
}

export function attachMediaWss(server, { makeTrack = opts => new AssemblyTrack(opts),
  saveTurn = saveAssemblyTurn, setState = setTranscriptionState,
  lookupCall = async sid => db.enabled ? loadCall(sid) : { twilio_call_sid: sid } } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const calls = new Set();
  const finishing = new Set();
  let draining = false;
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== MEDIA_PATH) return;
    let status = null;
    if (draining || config.transcription.provider !== 'assemblyai' || !config.transcription.apiKey) status = '503 Service Unavailable';
    else if (!validMediaSignature(req)) status = '403 Forbidden';
    else if (wss.clients.size + finishing.size >= config.transcription.maxCalls) status = '503 Service Unavailable';
    if (status) { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const telnyx = config.voiceProvider === 'telnyx';
    const expectedCall = telnyx ? new URL(req.url, 'https://media.invalid').searchParams.get('call') : null;
    const reordered = new Map([['inbound', []], ['outbound', []]]);
    const reorderTimers = new Map();
    const flushTrack = track => {
      clearTimeout(reorderTimers.get(track));
      const frames = reordered.get(track).splice(0).sort((a,b) => Number(a.timestamp) - Number(b.timestamp));
      for (const frame of frames) tracks.get(track)?.audio(Buffer.from(frame.payload, 'base64'), Number(frame.timestamp));
    };
    const stopSignal = root => { if (root === callSid) void stop(); };
    mediaEvents.on('stop', stopSignal);
    let started = false, streamReady = false, stopping = false, errorCode = null, callSid, streamSid, epoch;
    let earlyFrames = [], earlyBytes = 0;
    let queue = Promise.resolve(), pending = 0, lastMedia = Date.now();
    const tracks = new Map();
    const timer = setTimeout(() => fail('media_start_timeout'), 5000);
    timer.unref?.();
    const idle = setInterval(() => {
      if (Date.now() - lastMedia > 60_000) fail('media_idle_timeout');
      if (epoch && Date.now() - epoch > 4 * 60 * 60 * 1000) fail('media_duration_limit');
    }, 10_000);
    idle.unref?.();
    function enqueue(fn) {
      if (pending >= 100) { fail('transcript_queue_overflow'); return; }
      pending++;
      queue = queue.then(fn).catch(() => { fail('transcript_persistence_error'); })
        .finally(() => { pending--; });
    }
    function fail(code) {
      errorCode ||= code;
      if (!stopping) void stop();
    }
    async function stop() {
      if (stopping) return;
      stopping = true;
      earlyFrames = [];
      mediaEvents.off('stop', stopSignal);
      for (const track of reordered.keys()) flushTrack(track);
      clearTimeout(timer); clearInterval(idle);
      const done = (async () => {
        await Promise.all([...tracks.values()].map(track => track.finish()));
        await queue;
        if (callSid) {
          try { await setState(callSid, errorCode ? 'error' : 'stopped', errorCode); }
          catch { log.error('transcription.state_failed', { code: 'persistence_error' }); }
          calls.delete(callSid);
        }
        if (errorCode) log.warn('transcription.interrupted', { code: errorCode });
        if (ws.readyState === ws.OPEN) ws.close(errorCode ? 1011 : 1000, errorCode ? 'Transcription interrupted' : 'Stream complete');
      })();
      finishing.add(done);
      try { await done; } finally { finishing.delete(done); }
    }
    ws.stopTranscription = () => fail('server_shutdown');
    ws.on('message', (raw, binary) => {
      if (stopping) return;
      let msg;
      try { if (binary) throw new Error(); msg = JSON.parse(raw.toString()); }
      catch { return fail('invalid_media_message'); }
      if (msg.event === 'connected') return;
      if (msg.event === 'start') {
        if (started) return fail('duplicate_media_start');
        started = true;
        const rawStart = msg.start || {};
        const s = telnyx ? { ...rawStart, callSid: expectedCall, streamSid: msg.stream_id,
          mediaFormat: { encoding: rawStart.media_format?.encoding === 'PCMU' ? 'audio/x-mulaw' : '',
            sampleRate: rawStart.media_format?.sample_rate, channels: rawStart.media_format?.channels },
        } : rawStart;
        if (telnyx ? (!/^[-a-zA-Z0-9]{16,128}$/.test(s.streamSid || '') || !s.call_control_id ||
          s.mediaFormat.encoding !== 'audio/x-mulaw' || s.mediaFormat.sampleRate !== 8000 || s.mediaFormat.channels !== 1 || calls.has(s.callSid)) : (s.accountSid !== config.twilio.accountSid || !/^CA[a-fA-F0-9]{32}$/.test(s.callSid || '') ||
          !/^MZ[a-fA-F0-9]{32}$/.test(s.streamSid || '') ||
          s.mediaFormat?.encoding !== 'audio/x-mulaw' || s.mediaFormat.sampleRate !== 8000 || s.mediaFormat.channels !== 1 ||
          !Array.isArray(s.tracks) || !['inbound', 'outbound'].every(t => s.tracks.includes(t)) ||
          !verifyStreamTicket(s.callSid, s.customParameters?.ticket) || calls.has(s.callSid))) return fail('invalid_media_start');
        callSid = s.callSid; streamSid = s.streamSid; epoch = Date.now();
        calls.add(callSid);
        // ws.pause() alone cannot stop frames already decoded from one TCP
        // packet. Hold a bounded startup queue until the DB lookup completes.
        void (async () => {
          const call = await lookupCall(callSid);
          if (stopping) return;
          if (!call || call.twilio_call_sid !== callSid || (telnyx && (call.provider !== 'telnyx' || call.provider_state?.customer !== s.call_control_id || call.ended_at))) return fail('unknown_media_call');
          await setState(callSid, 'streaming');
          if (stopping) return;
          for (const track of ['inbound', 'outbound']) {
            tracks.set(track, makeTrack({ ...config.transcription,
              onTurn: (turn, offset) => enqueue(() => saveTurn({ callSid, streamSid, track, turn, timestamp: epoch + offset })),
              onFailure: fail }));
          }
          clearTimeout(timer);
          streamReady = true;
          for (const frame of earlyFrames) receiveAudio(frame);
          earlyFrames = [];
        })().catch(() => fail('media_setup_error'));
      } else if (msg.event === 'media') {
        if (telnyx) msg.streamSid = msg.stream_id;
        if (!streamReady) {
          if (!callSid || earlyBytes + raw.length > 110_000) return fail('audio_buffer_overflow');
          earlyFrames.push(msg); earlyBytes += raw.length;
        } else receiveAudio(msg);
      } else if (msg.event === 'stop') {
        if ((telnyx ? msg.stream_id : msg.streamSid) !== streamSid) return fail('invalid_media_stop');
        void stop();
      }
    });
    function receiveAudio(msg) {
      if (stopping) return;
      const m = msg.media;
      if (!callSid || msg.streamSid !== streamSid || !tracks.has(m?.track) || typeof m.payload !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(m.payload) || m.payload.length > 11_000 || m.payload.length % 4 !== 0 ||
        m.timestamp == null || !Number.isFinite(Number(m.timestamp)) || Number(m.timestamp) < 0) return fail('invalid_media_frame');
      lastMedia = Date.now();
      if (telnyx) {
        const buffer = reordered.get(m.track);
        if (buffer.length >= 64) return fail('audio_reorder_overflow');
        buffer.push(m);
        if (!reorderTimers.get(m.track)) reorderTimers.set(m.track, setTimeout(() => { reorderTimers.delete(m.track); flushTrack(m.track); }, 120));
      } else tracks.get(m.track).audio(Buffer.from(m.payload, 'base64'), Number(m.timestamp));
    }
    ws.on('close', code => { if (!stopping) { if (telnyx && code === 1000) void stop(); else fail('media_disconnected'); } });
    ws.on('error', () => fail('media_connection_error'));
  });
  return {
    get activeCalls() { return calls.size; },
    async close() {
      draining = true;
      for (const ws of wss.clients) ws.stopTranscription();
      await Promise.all([...finishing]);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
