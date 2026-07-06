import { structuredCompletion, automationBackend } from "./client.js";

/**
 * Heavy, ON-DEMAND automation — the only place GPT-OSS 120B (the automation
 * backend) is used. Deliberately NOT part of onCallComplete: recap/extraction
 * run on every call (Groq 70B), but automation is invoked explicitly by an agent
 * for a specific task, so the expensive model runs rarely.
 *
 * Supported kinds:
 *   followup_plan   — multi-step follow-up plan
 *   task_creation   — concrete tasks/reminders to create
 *   email_draft     — a follow-up email draft
 *   sms_draft       — a short follow-up SMS draft
 *   coverage_gap    — coverage-gap analysis vs. what was discussed
 *   manager_summary — a manager-facing coaching summary of the call
 */

export const AUTOMATION_KINDS = [
  "followup_plan",
  "task_creation",
  "email_draft",
  "sms_draft",
  "coverage_gap",
  "manager_summary",
];

const SYSTEM = {
  followup_plan:
    "You are a sales operations assistant for We Insure Things. Produce a concrete, ordered multi-step follow-up plan for the agent based on the call.",
  task_creation:
    "You create actionable CRM tasks for We Insure Things agents. From the call, produce specific tasks with clear next actions and suggested timing.",
  email_draft:
    "You draft professional, compliant follow-up emails for We Insure Things. Write a ready-to-send email based on the call. No invented quotes or coverage.",
  sms_draft:
    "You draft short, compliant follow-up SMS messages for We Insure Things. Keep under 320 characters, friendly and specific to the call.",
  coverage_gap:
    "You are a licensed-insurance coverage analyst. Identify likely coverage gaps and cross-sell opportunities implied by what the customer said. Flag assumptions clearly; never state coverage as fact.",
  manager_summary:
    "You write concise manager-facing coaching summaries. Summarize the agent's performance, what went well, risks/objections handled, and one coaching tip.",
};

export function automationEnabled() {
  return automationBackend !== "rules";
}

/**
 * @param {{kind:string, transcript:string, recap?:object, context?:string}} args
 * @returns {Promise<object|null>} { title, steps[], draft, notes } or null when
 *   the automation backend is local rules / inputs are empty / the model failed.
 */
export async function generateAutomation({ kind, transcript, recap = null, context = "" }) {
  if (!AUTOMATION_KINDS.includes(kind)) throw new Error(`unknown automation kind: ${kind}`);
  if (!transcript?.trim()) return null;
  if (!automationEnabled()) return null; // never run heavy reasoning on the local fallback

  const recapBlock = recap ? `\n\nCall recap (structured):\n${JSON.stringify(recap)}` : "";
  const ctxBlock = context ? `\n\nAdditional context:\n${context}` : "";

  return structuredCompletion({
    system: SYSTEM[kind],
    user: `Call transcript:\n\n${transcript}${recapBlock}${ctxBlock}\n\nProduce the ${kind.replace(/_/g, " ")}.`,
    schema: null,
    schemaName: `automation_${kind}`,
    maxTokens: 2000,
  });
}
