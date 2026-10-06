import WebSocket from 'ws';

const CHUNK_BYTES = 800; // 100 ms of Twilio's 8 kHz, one-byte mu-law audio.
const MAX_BUFFER = 40_000; // Five seconds per track; never build an unbounded queue.

/** One speaker track per AssemblyAI session. Audio never enters logs or disk. */
export class AssemblyTrack {
  constructor({ apiKey, endpoint, model, onTurn, onFailure, createSocket = (url, opts) => new WebSocket(url, opts) }) {
    this.onTurn = onTurn;
    this.onFailure = onFailure;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.ending = false;
    this.closed = false;
    this.lastTurn = -1;
    this.firstTimestamp = null;
    this.nextTimestamp = null;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ sample_rate: '8000', encoding: 'pcm_mulaw', speech_model: model,
      ...(model.startsWith('universal-streaming-') ? { format_turns: 'false' } : {}) }).toString();
    this.ws = createSocket(url.toString(), { headers: { Authorization: apiKey }, handshakeTimeout: 10_000, maxPayload: 256_000 });
    this.connectTimer = setTimeout(() => this.fail('assemblyai_start_timeout'), 10_000);
    this.connectTimer.unref?.();
    this.ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'Begin') {
          clearTimeout(this.connectTimer);
          this.ready = true;
          this.flush();
          if (this.ending) this.sendTerminate();
        } else if (msg.type === 'Turn' && msg.end_of_turn === true && Number.isInteger(msg.turn_order) &&
          msg.turn_order > this.lastTurn && typeof msg.transcript === 'string' && msg.transcript.trim()) {
          if (msg.transcript.length > 32_000) return this.fail('assemblyai_turn_too_large');
          this.lastTurn = msg.turn_order;
          this.onTurn(msg, (this.firstTimestamp || 0) + (Number(msg.words?.[0]?.start) || 0));
        } else if (msg.type === 'Termination') {
          if (!this.ending) return this.fail('assemblyai_ended_early');
          this.cleanup();
          this.ws.close();
        } else if (msg.type === 'Error' || msg.error) this.fail('assemblyai_provider_error');
      } catch { this.fail('assemblyai_invalid_message'); }
    });
    this.ws.on('error', () => this.fail('assemblyai_connection_error'));
    this.ws.on('close', () => { if (!this.closed) this.fail('assemblyai_disconnected'); });
  }

  audio(payload, timestamp) {
    if (this.closed || this.ending) return;
    if (!Number.isFinite(timestamp) || timestamp < 0) return this.fail('invalid_audio_timestamp');
    if (this.firstTimestamp === null) { this.firstTimestamp = timestamp; this.nextTimestamp = timestamp; }
    // Twilio tracks share a call clock. Pad short gaps so AssemblyAI's word times
    // stay aligned across speakers; do not replay old/duplicate audio frames.
    if (timestamp < this.nextTimestamp - 1) return;
    const gap = Math.max(0, Math.round((timestamp - this.nextTimestamp) * 8));
    if (gap + payload.length + this.buffer.length > MAX_BUFFER) return this.fail('audio_buffer_overflow');
    this.buffer = Buffer.concat([this.buffer, Buffer.alloc(gap, 0xff), payload]);
    this.nextTimestamp = timestamp + payload.length / 8;
    this.flush();
  }

  flush() {
    if (!this.ready || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.buffer.length >= CHUNK_BYTES) {
      if (this.ws.bufferedAmount > MAX_BUFFER) return this.fail('assemblyai_backpressure');
      this.ws.send(this.buffer.subarray(0, CHUNK_BYTES));
      this.buffer = this.buffer.subarray(CHUNK_BYTES);
    }
  }

  finish() {
    if (this.ending || this.closed) return this.done;
    this.ending = true;
    this.finishTimer = setTimeout(() => this.fail('assemblyai_finish_timeout'), 5000);
    this.finishTimer.unref?.();
    if (this.ready) this.sendTerminate();
    return this.done;
  }

  sendTerminate() {
    if (this.closed || this.sentTerminate || this.ws.readyState !== WebSocket.OPEN) return;
    this.sentTerminate = true;
    this.flush();
    if (this.closed) return;
    if (this.buffer.length) {
      // Pad the last sub-100ms frame with mu-law silence instead of losing it.
      const tail = Buffer.alloc(CHUNK_BYTES, 0xff);
      this.buffer.copy(tail);
      this.ws.send(tail);
      this.buffer = Buffer.alloc(0);
    }
    this.ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
    this.ws.send(JSON.stringify({ type: 'Terminate' }));
  }

  fail(code) {
    if (this.closed) return;
    this.cleanup();
    this.ws.terminate();
    this.onFailure(code);
  }

  cleanup() {
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    clearTimeout(this.connectTimer);
    clearTimeout(this.finishTimer);
    this.resolveDone();
  }
}
