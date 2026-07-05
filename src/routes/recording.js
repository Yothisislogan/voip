import { Router } from "express";
import { recordRecording } from "../services/calls.js";
import { recordRecordingState } from "../store/consent.js";

export const recordingRouter = Router();

// POST /recording/status — Twilio posts here when a recording completes.
recordingRouter.post("/recording/status", async (req, res) => {
  await recordRecording({
    callSid: req.body.CallSid,
    recordingSid: req.body.RecordingSid,
    url: req.body.RecordingUrl, // append .mp3/.wav when fetching
    durationSec: req.body.RecordingDuration
      ? Number(req.body.RecordingDuration)
      : null,
  });
  // Track recording lifecycle for compliance. Twilio's recordingStatusCallback
  // is configured for "completed", so a post here means the recording stopped.
  const status = (req.body.RecordingStatus || "completed").toLowerCase();
  recordRecordingState(req.body.CallSid, status === "in-progress" ? "recording" : "stopped").catch(() => {});
  res.sendStatus(204);
});
