import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { generateCoaching } from "../ai/coach.js";
import { generateRecap } from "../ai/recap.js";

export const aiRouter = Router();

/**
 * POST /ai/test-coaching
 * Authenticated smoke test for the AI provider without placing a Twilio call.
 * Body:
 *   { "transcript": "Agent: ...\nCustomer: ...", "recap": false }
 */
aiRouter.post("/ai/test-coaching", requireAuth, async (req, res) => {
  const transcript = String(req.body?.transcript || "").trim();
  if (!transcript) return res.status(400).json({ error: "transcript is required" });

  const coaching = await generateCoaching(transcript);
  const recap = req.body?.recap ? await generateRecap(transcript) : null;

  res.json({ ok: true, coaching, recap });
});
