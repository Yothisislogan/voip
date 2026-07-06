import { config } from "../config.js";
import { transcripts } from "../ai/transcript.js";
import { generateCoaching } from "../ai/coach.js";
import { generateRecap, formatRecapNote } from "../ai/recap.js";
import { scoreCall } from "../ai/score.js";
import { extractLeadFields } from "../ai/extract.js";
import { extractLeadFieldsAI, mergeAiExtraction } from "../ai/extract-ai.js";
import * as crm from "../store/crm.js";
import * as erpnext from "../crm/erpnext.js";
import { recordDisclosure } from "../store/consent.js";
import { maybeSendSurvey } from "./survey.js";
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
 * Screen-pop: match/create the caller in the Postgres CRM (primary), falling
 * back to ERPNext when Postgres isn't configured, and push the record to the
 * agent. Safe to call fire-and-forget after responding to a webhook.
 */
export async function doScreenPop(callSid) {
  const session = getSession(callSid);
  if (!session?.identity || !session.customerNumber) return;

  let contact = null;
  if (crm.crmDbEnabled) {
    const row = await crm.findOrCreateContactByPhone(session.customerNumber, {
      source: session.direction === "outbound" ? "call_outbound" : "call_inbound",
    });
    if (row) {
      session.contactId = row.id;
      contact = crm.shapeContactForUi(row);
      await crm.recordCall({
        callSid,
        contactId: row.id,
        direction: session.direction,
        from: session.from,
        to: session.to,
        status: "in_progress",
      });
      // Record the recording/transcription disclosure now that the call row
      // exists (inbound plays the IVR disclosure at answer time).
      if (session.direction === "inbound") {
        await recordDisclosure(callSid, row.id);
      }
    }
  } else {
    contact = await erpnext.findContactByPhone(session.customerNumber);
  }

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

  // Persist the utterance (best-effort) so transcripts survive process restarts.
  crm.insertTranscriptSegment({
    callSid,
    contactId: session.contactId,
    seq: session.segSeq++,
    speaker,
    text,
  }).catch(() => {});

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

    // Score the call and persist it (Postgres).
    const scored = scoreCall({ recap, transcript: full });
    await crm.insertCallScore({
      callSid,
      contactId: session.contactId,
      score: scored.score,
      sentiment: scored.sentiment,
      outcome: scored.outcome,
      factors: scored.factors,
      summary: scored.summary,
    });

    // Extract lead fields. Deterministic regex extraction is the guaranteed
    // baseline (auto-applied); the LLM extractor (Groq 70B) adds high-confidence
    // fields and proposes the rest for the agent to confirm ("Apply?").
    let proposedUpdates = [];
    if (session.contactId) {
      const fields = extractLeadFields(full, recap);

      const aiResult = await extractLeadFieldsAI(full).catch(() => null);
      const { applied, proposed, nextAction } = mergeAiExtraction(aiResult);
      proposedUpdates = proposed;
      if (nextAction) recap.nextSteps = dedupePrepend(recap.nextSteps, nextAction);

      // Deterministic fields first, then overlay high-confidence AI fields.
      const merged = { ...fields, ...applied };
      if (Object.keys(merged).length) await crm.updateContactFields(session.contactId, merged);
    }

    await crm.completeCall({ callSid, durationSeconds: durationSec, recap });

    // Optional ERPNext mirror (independent lookup; PG ids don't map to ERPNext).
    let mirroredToErp = false;
    if (erpnext.crmEnabled) {
      const note = formatRecapNote(recap, { from: session.from, to: session.to, durationSec });
      const erpContact = await erpnext.findContactByPhone(session.customerNumber);
      if (note) {
        const noteId = await erpnext.writeRecapNote({ contact: erpContact, subject: note.subject, description: note.description });
        await erpnext.logCallActivity({ contact: erpContact, callSid, from: session.from, to: session.to, durationSec, direction: session.direction });
        mirroredToErp = Boolean(noteId);
      }
    }

    // Post-call survey SMS (best-effort; no-op if messaging/DB disabled).
    maybeSendSurvey({ callSid, session }).catch(() => {});

    if (session.identity) {
      publishToAgent(session.identity, "recap", {
        callSid,
        recap,
        score: scored,
        contact: session.contact,
        contactId: session.contactId || null,
        proposedUpdates, // low-confidence AI fields for "AI found these updates. Apply?"
        savedToCrm: crm.crmDbEnabled || mirroredToErp,
      });
    }
  } catch (err) {
    console.error("onCallComplete failed:", err.message);
  } finally {
    transcripts.clear(callSid);
    endSession(callSid);
  }
}

// Prepend a next step from AI extraction without duplicating an existing one.
function dedupePrepend(list, item) {
  const arr = Array.isArray(list) ? list : [];
  if (arr.some((x) => String(x).trim().toLowerCase() === item.trim().toLowerCase())) return arr;
  return [item, ...arr];
}
