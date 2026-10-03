import { client as twilioClient } from "../twilio.js";
import { config } from "../config.js";
import { createSurvey } from "../store/crm.js";

/**
 * Post-call survey SMS follow-up. Sends a short CSAT/NPS text to the customer
 * after a call and records it so the inbound reply can be matched back (see the
 * messaging orchestrator). Opt-in via SURVEY_ENABLED=true; best-effort.
 */

export async function maybeSendSurvey({ callSid, session }) {
  if (!config.survey.enabled) return false;
  if (!twilioClient || !session?.customerNumber || !config.twilio.callerId) return false;
  // Only survey real customer numbers (E.164), never the agent's browser client.
  if (!/^\+?[1-9]\d{6,15}$/.test(session.customerNumber)) return false;

  try {
    await twilioClient.messages.create({
      to: session.customerNumber,
      from: config.twilio.callerId,
      body: config.survey.text,
    });
    const survey = await createSurvey({
      callSid,
      contactId: session.contactId,
      question: config.survey.text,
      channel: "sms",
    });
    if (!survey) throw new Error('Survey was sent but local tracking was not saved');
    return true;
  } catch (err) {
    console.error("survey send failed:", err.message);
    return false;
  }
}

/** Parse a 1–5 rating from a survey reply, or null. */
export function parseSurveyRating(text) {
  const m = String(text || "").match(/\b([1-5])\b/);
  return m ? Number(m[1]) : null;
}
