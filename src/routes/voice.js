import { Router } from "express";
import twilio from "twilio";
import { config, webhookUrl } from "../config.js";
import { recordCall, updateCallStatus } from "../services/calls.js";
import { startSession, identityFromClient } from "../realtime/sessions.js";
import { doScreenPop, onUtterance, onCallComplete } from "../realtime/orchestrator.js";

const { VoiceResponse } = twilio.twiml;
export const voiceRouter = Router();

// Status callback events Twilio should send us for each leg.
const STATUS_EVENTS = "initiated ringing answered completed";

// AI features need a public URL Twilio can POST transcripts to.
const aiPipelineOn =
  Boolean(config.publicBaseUrl) && (config.coachingEnabled || config.recapEnabled);

/**
 * Fork a real-time transcript of the call to /voice/transcription. <Start> is
 * non-blocking, so transcription runs alongside the <Dial> that follows.
 * partialResults=false → we only receive finalized utterances.
 */
function maybeStartTranscription(twiml) {
  if (!aiPipelineOn) return;
  const start = twiml.start();
  start.transcription({
    name: "wit-coaching",
    track: "both_tracks",
    partialResults: false,
    statusCallbackUrl: webhookUrl("/voice/transcription"),
  });
}

/**
 * OUTBOUND — the TwiML App's Voice URL points here.
 * The browser SDK calls device.connect({ params: { To } }); Twilio POSTs
 * that here, and we bridge to the dialed PSTN number.
 */
voiceRouter.post("/voice/outbound", async (req, res) => {
  const to = (req.body.To || "").trim();
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  if (!to) {
    twiml.say("No destination number was provided. Goodbye.");
    return res.type("text/xml").send(twiml.toString());
  }

  // The browser SDK call arrives with From = "client:<identity>".
  const identity = identityFromClient(req.body.From) || config.defaultAgentIdentity;
  startSession(callSid, {
    identity,
    customerNumber: to,
    direction: "outbound",
    from: config.twilio.callerId,
    to,
  });

  maybeStartTranscription(twiml);

  const dial = twiml.dial({
    callerId: config.twilio.callerId,
    answerOnBridge: true,
    record: "record-from-answer-dual",
    recordingStatusCallback: webhookUrl("/recording/status"),
    recordingStatusCallbackEvent: "completed",
  });
  dial.number(
    {
      statusCallback: webhookUrl("/voice/status"),
      statusCallbackEvent: STATUS_EVENTS,
      statusCallbackMethod: "POST",
    },
    to
  );

  await recordCall({
    callSid,
    direction: "outbound",
    from: config.twilio.callerId,
    to,
    status: "queued",
  });

  res.type("text/xml").send(twiml.toString());

  // Pop the customer's CRM record onto the agent's screen (best-effort).
  doScreenPop(callSid).catch((e) => console.error("screen-pop failed:", e.message));
});

/**
 * INBOUND — set a WIT Twilio number's Voice webhook to this URL.
 * Starter routing: ring the default agent's browser client; if unanswered,
 * fall through to /voice/dial-status for voicemail.
 */
voiceRouter.post("/voice/inbound", async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  // Recording + AI transcription are active — disclose for two-party-consent states.
  twiml.say(
    { voice: "Polly.Joanna" },
    "Thank you for calling We Insure Things. This call may be recorded and transcribed for quality and training. Connecting you to an agent."
  );

  startSession(callSid, {
    identity: config.defaultAgentIdentity,
    customerNumber: from,
    direction: "inbound",
    from,
    to,
  });

  maybeStartTranscription(twiml);

  const dial = twiml.dial({
    callerId: from, // show the customer's number to the agent
    timeout: 20,
    action: webhookUrl("/voice/dial-status"),
    method: "POST",
    record: "record-from-answer-dual",
    recordingStatusCallback: webhookUrl("/recording/status"),
    recordingStatusCallbackEvent: "completed",
  });
  // TODO(prod): resolve target from routing_rules + ring_groups in the DB.
  dial.client(
    {
      statusCallback: webhookUrl("/voice/status"),
      statusCallbackEvent: STATUS_EVENTS,
      statusCallbackMethod: "POST",
    },
    config.defaultAgentIdentity
  );

  await recordCall({
    callSid,
    direction: "inbound",
    from,
    to,
    status: "ringing",
  });

  res.type("text/xml").send(twiml.toString());

  // Pop the caller's CRM record onto the agent's screen (best-effort).
  doScreenPop(callSid).catch((e) => console.error("screen-pop failed:", e.message));
});

/**
 * DIAL ACTION — Twilio hits this after a <Dial> finishes. If the agent
 * didn't pick up, take a voicemail (which fires the recording callback).
 */
voiceRouter.post("/voice/dial-status", (req, res) => {
  const dialStatus = req.body.DialCallStatus; // completed | answered | no-answer | busy | failed | canceled
  const twiml = new VoiceResponse();

  if (dialStatus !== "completed" && dialStatus !== "answered") {
    twiml.say(
      { voice: "Polly.Joanna" },
      "Sorry we missed you. Please leave a message after the tone."
    );
    twiml.record({
      maxLength: 120,
      playBeep: true,
      transcribe: false, // production transcription handled by the AI pipeline
      recordingStatusCallback: webhookUrl("/recording/status"),
      recordingStatusCallbackEvent: "completed",
      action: webhookUrl("/voice/voicemail-done"),
    });
    twiml.say({ voice: "Polly.Joanna" }, "We did not receive a recording. Goodbye.");
  }
  // If completed or answered, an empty response ends the call cleanly.
  res.type("text/xml").send(twiml.toString());
});

// Terminal URL for <Record action> — prevents Twilio re-posting to /voice/dial-status after voicemail.
voiceRouter.post("/voice/voicemail-done", (req, res) => {
  res.type("text/xml").send(new VoiceResponse().toString());
});

/**
 * STATUS CALLBACK — per-leg lifecycle events. Updates the calls row.
 */
voiceRouter.post("/voice/status", async (req, res) => {
  await updateCallStatus({
    callSid: req.body.CallSid,
    status: req.body.CallStatus,
    durationSec: req.body.CallDuration ? Number(req.body.CallDuration) : null,
  });
  res.sendStatus(204);
});

/**
 * REAL-TIME TRANSCRIPTION — Twilio POSTs here as <Start><Transcription>
 * produces finalized utterances, and once more when transcription stops.
 *   transcription-content → buffer the utterance + run (throttled) coaching
 *   transcription-stopped → call ended → generate recap + write to CRM
 * Respond fast; AI work runs fire-and-forget so we never delay Twilio.
 */
voiceRouter.post("/voice/transcription", (req, res) => {
  const event = req.body.TranscriptionEvent;
  const callSid = req.body.CallSid;

  if (event === "transcription-content") {
    let transcript = "";
    try {
      transcript = JSON.parse(req.body.TranscriptionData || "{}").transcript || "";
    } catch {
      transcript = "";
    }
    if (transcript) {
      onUtterance(callSid, req.body.Track, transcript).catch((e) =>
        console.error("onUtterance failed:", e.message)
      );
    }
  } else if (event === "transcription-stopped") {
    onCallComplete(callSid).catch((e) =>
      console.error("onCallComplete failed:", e.message)
    );
  }

  res.sendStatus(204);
});
