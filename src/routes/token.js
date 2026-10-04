import { Router } from "express";
import { generateVoiceToken } from "../twilio.js";
import { requireAuth, requireRole } from "../auth/middleware.js";

export const tokenRouter = Router();

// GET /token
// Identity is derived from the authenticated session (requireAuth), never from
// a client-supplied value — an agent cannot mint a token for someone else.
tokenRouter.get("/token", requireAuth, requireRole('agent'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const identity = req.agent.identity;
  if (!identity) {
    return res.status(403).json({ error: "no identity for this account" });
  }
  try {
    const token = generateVoiceToken(identity);
    res.json({ identity, token });
  } catch (err) {
    console.error("token error:", err.message);
    res.status(500).json({ error: "Could not mint token. Check Twilio env vars." });
  }
});
