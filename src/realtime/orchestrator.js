import { config } from "../config.js";
import { transcripts } from "../ai/transcript.js";
import { generateCoaching } from "../ai/coach.js";
import { generateRecap, formatRecapNote } from "../ai/recap.js";
import { findContactByPhone, writeRecapNote, logCallActivity } from "../crm/suitecrm.js";
import { getSession, setContact, endSession } from "./sessions.js";
import { publishToAgent } from "./bus.js";

/**
 * Glue between Twilio events, the AI services, and the agent's screen.
 * Everything here is best-effort and self-contained: a failure must never
 * disrupt the live call.
 */

/**
 * Map a Twilio transcription track to a speaker, given the call direction.
 *  - inbound:  caller is the customer  → inbound_track = customer
 *  - outbound: caller is the agent     → inbound_track = agent
 */
export function resolveSpeaker(direction, track) {
  const callerIsAgent = direction === "outbound";
  if (track === "inbound_track") return callerIsAgent ? "agent" : "customer";
  if (track === "outbound_track") return callerIsAgent ? "customer" : "agent";
  return "customer"; // sensible default
}

/**
 * Screen-pop: resolve the caller in SuiteCRM and push the record to the agent.
 * Safe to call fire-and-forget after responding to a webhook.
 */
export async function doScreenPop(callSid) {
  const session = getSession(callSid);
  if (!session?.identity || !session.customerNumber) return;
  const contact = await findContactByPhone(session.customerNumber);
  setContact(callSid, contact);
  publishToAgent(session.identity, "screenpop", {
    callSid,
    phone: session.customerNumber,
    contact, // null if not found / CRM disabled — UI shows "new caller"
  });
}

/**
 * Handle one finalized transcription utterance: buffer it, then (throttled)
 * run a coaching pass and push cues to the agent.
 */
export async function onUtterance(callSid, track, text, at = Date.now()) {
  const session = getSession(callSid);
  if (!session) return;

  const speaker = resolveSpeaker(session.direction, track);
  transcripts.append(callSid, speaker, text, at);

  if (!config.coachingEnabled) return;

  // Throttle coaching calls per-call to bound latency/cost on a chatty line.
  if (at - session.throttledAt < config.coachingThrottleMs) return;
  session.throttledAt = at;

  const recent = transcripts.formatRecent(callSid);
  const coaching = await generateCoaching(recent);
  if (!coaching) return;

  publishToAgent(session.identity, "coaching", { callSid, ...coaching });
}

/**
 * Call completed: generate the recap, write it to the customer's CRM record,
 * notify the agent, and clean up buffers.
 */
export async function onCallComplete(callSid, durationSec) {
  const session = getSession(callSid);
  try {
    if (!session || !config.recapEnabled || !transcripts.has(callSid)) return;

    if (durationSec == null && session.startedAt) {
      durationSec = Math.round((Date.now() - session.startedAt) / 1000);
    }

    const full = transcripts.format(callSid);
    const recap = await generateRecap(full);
    if (!recap) return;

    const note = formatRecapNote(recap, {
      from: session.from,
      to: session.to,
      durationSec,
    });

    // Resolve the contact if screen-pop didn't already (e.g. recap-only flow).
    let contact = session.contact;
    if (contact === null) contact = await findContactByPhone(session.customerNumber);

    let noteId = null;
    if (note) {
      noteId = await writeRecapNote({
        contactId: contact?.id || null,
        subject: note.subject,
        description: note.description,
      });
      // Also log it as a Call activity for CRM reporting (best-effort).
      await logCallActivity({
        contactId: contact?.id || null,
        subject: note.subject,
        description: note.description,
        durationSec,
      });
    }

    if (session.identity) {
      publishToAgent(session.identity, "recap", {
        callSid,
        recap,
        contact,
        savedToCrm: Boolean(noteId),
      });
    }
  } catch (err) {
    console.error("onCallComplete failed:", err.message);
  } finally {
    transcripts.clear(callSid);
    endSession(callSid);
  }
}
