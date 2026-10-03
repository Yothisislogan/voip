/**
 * Active call-session registry, keyed by Twilio CallSid.
 *
 * Twilio's transcription and status webhooks arrive keyed by CallSid only, but
 * to route coaching cues and write the recap we need to know which agent is on
 * the call and which customer number is involved. We capture that when the call
 * is first set up (in the voice routes) and look it up later.
 *
 * Process-local; back with Redis for a multi-instance deployment.
 */

/** @type {Map<string, {identity: string, customerNumber: string, direction: string, from: string, to: string, contact: object|null, throttledAt: number}>} */
const sessions = new Map();

export function startSession(callSid, data) {
  if (!callSid) return;
  if (sessions.has(callSid)) return sessions.get(callSid);
  sessions.set(callSid, {
    identity: data.identity || null,
    customerNumber: data.customerNumber || null,
    direction: data.direction || null,
    from: data.from || null,
    to: data.to || null,
    contact: null,
    contactId: null, // Postgres contacts.id, once matched
    segSeq: 0, // next transcript_segments.seq for this call
    throttledAt: 0,
    startedAt: Date.now(),
  });
}

export function getSession(callSid) {
  return sessions.get(callSid) || null;
}

export function setContact(callSid, contact) {
  const s = sessions.get(callSid);
  if (s) s.contact = contact;
}

export function endSession(callSid) {
  sessions.delete(callSid);
}

/**
 * Strip Twilio's "client:" prefix from an outbound caller identity.
 * Outbound browser calls arrive with From = "client:marisol.vega".
 */
export function identityFromClient(from) {
  if (!from) return null;
  return from.startsWith("client:") ? from.slice("client:".length) : null;
}
