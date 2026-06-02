import { Router } from "express";
import { recordRecording } from "../services/calls.js";

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
  res.sendStatus(204);
});
