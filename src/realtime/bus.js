import { EventEmitter } from "node:events";

/**
 * Tiny pub/sub for pushing real-time events (screen-pop, coaching cues, recap
 * status) to a specific agent's browser. Channels are keyed by agent identity
 * (the same identity used for the Twilio Voice token), so an agent only ever
 * receives events for their own calls.
 *
 * The WebSocket layer (src/realtime/ws.js) subscribes; the voice + transcription
 * routes publish. Process-local; for multi-instance use a Redis pub/sub fan-out.
 */
const emitter = new EventEmitter();
// Many concurrent agents may subscribe; lift the default 10-listener warning.
emitter.setMaxListeners(0);

const channel = (identity) => `agent:${identity}`;

/** Publish an event to one agent. `type` is e.g. "screenpop" | "coaching" | "recap". */
export function publishToAgent(identity, type, payload) {
  if (!identity) return;
  emitter.emit(channel(identity), { type, ...payload, at: Date.now() });
}

/** Subscribe an agent's connection. Returns an unsubscribe function. */
export function subscribeAgent(identity, handler) {
  const ch = channel(identity);
  emitter.on(ch, handler);
  return () => emitter.off(ch, handler);
}
