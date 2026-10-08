import { Router } from "express";
import { generateVoiceToken } from "../twilio.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

import { config } from '../config.js';
import { voiceToken } from '../providers/telnyx.js';

export const tokenRouter = Router();

// GET /token
// Identity is derived from the authenticated session (requireAuth), never from
// a client-supplied value — an agent cannot mint a token for someone else.
tokenRouter.get("/token", requireAuth, requireRole('agent'), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const identity = req.agent.identity;
  if (!identity) {
    return res.status(403).json({ error: "no identity for this account" });
  }
  try {
    const token = config.voiceProvider === 'telnyx' ? await voiceToken(identity) : generateVoiceToken(identity);
    res.json({ identity, token, provider: config.voiceProvider });
  } catch (err) {
    console.error("token error:", err.message);
    res.status(500).json({ error: "Could not mint token. Check the voice provider configuration." });
  }
});
