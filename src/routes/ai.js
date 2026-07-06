import { Router } from "express";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { csrfProtect } from "../middleware/csrf.js";
import { audit } from "../audit.js";
import { generateCoaching } from "../ai/coach.js";
import { generateRecap } from "../ai/recap.js";
import { generateAutomation, automationEnabled, AUTOMATION_KINDS } from "../ai/automation.js";
import * as crm from "../store/crm.js";

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

/**
 * POST /ai/automate  { callSid, kind }
 * On-demand heavy automation (GPT-OSS 120B via the automation backend). Rebuilds
 * the transcript from the PERSISTENT store, so it works after the call ended.
 * Agent role + CSRF required. Returns 409 when automation runs on local rules.
 */
aiRouter.post("/ai/automate", requireAuth, requireRole("agent"), csrfProtect, async (req, res) => {
  const { callSid, kind } = req.body || {};
  if (!AUTOMATION_KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${AUTOMATION_KINDS.join(", ")}` });
  }
  if (!automationEnabled()) {
    return res.status(409).json({ error: "automation backend is local rules — configure LLM_AUTOMATION_BACKEND (e.g. groq)" });
  }
  if (!crm.crmDbEnabled) return res.status(503).json({ error: "CRM database not configured" });

  const detail = await crm.getCallDetail(callSid);
  if (!detail || !detail.call) return res.status(404).json({ error: "call not found" });

  const transcript = (detail.segments || [])
    .map((s) => `${s.speaker === "agent" ? "Agent" : "Customer"}: ${s.text}`)
    .join("\n");
  if (!transcript.trim()) return res.status(422).json({ error: "no transcript stored for this call" });

  const result = await generateAutomation({ kind, transcript, recap: detail.call.recap || null });
  audit({ req, action: "ai.automate", entityType: "call", entityId: callSid, detail: { kind } });
  res.json({ ok: true, kind, result });
});
