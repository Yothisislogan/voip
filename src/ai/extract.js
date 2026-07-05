/**
 * Deterministic lead-field extraction from a call transcript (+ recap). Pulls
 * insurance-relevant fields into the shape used by the contacts table. Local and
 * dependency-free; runs regardless of AI backend. An LLM pass can enrich this
 * later, but the rules here keep it working offline.
 *
 * Returns a partial object of contact columns (only fields it's confident about).
 */

const CARRIERS = [
  ["geico", "GEICO"], ["progressive", "Progressive"], ["state farm", "State Farm"],
  ["allstate", "Allstate"], ["usaa", "USAA"], ["farmers", "Farmers"],
  ["nationwide", "Nationwide"], ["liberty mutual", "Liberty Mutual"],
  ["travelers", "Travelers"], ["american family", "American Family"],
];

const POLICY_TYPES = [
  [["auto", "car ", "vehicle", "vin"], "Auto"],
  [["homeowners", "home ", "house"], "Home"],
  [["renters", "apartment"], "Renters"],
  [["life insurance", "term life", "whole life"], "Life"],
  [["commercial auto", "box truck", "tow truck"], "Commercial Auto"],
  [["general liability"], "General Liability"],
  [["workers comp", "workers compensation", "payroll"], "Workers Compensation"],
  [["umbrella"], "Umbrella"],
];

export function extractLeadFields(transcript = "", recap = null) {
  const t = ` ${String(transcript).toLowerCase()} `;
  const out = {};

  // Policy type — prefer the recap's product, else keyword scan.
  if (recap?.productsDiscussed?.length) {
    out.policy_type = recap.productsDiscussed[0];
  } else {
    for (const [needles, label] of POLICY_TYPES) {
      if (needles.some((n) => t.includes(n))) { out.policy_type = label; break; }
    }
  }

  // Current carrier.
  for (const [needle, label] of CARRIERS) {
    if (t.includes(needle)) { out.carrier = label; break; }
  }

  // Premium — a dollar amount near price/premium/pay wording.
  const premium = extractPremium(transcript);
  if (premium != null) out.premium = premium;

  // Email address spoken/spelled in the call.
  const email = String(transcript).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (email) out.email = email[0].toLowerCase();

  // Lifecycle hint from outcome.
  if (recap?.outcome === "sale") out.lifecycle_stage = "customer";
  else if (recap?.outcome === "not_interested") out.lifecycle_stage = "lost";

  return out;
}

function extractPremium(transcript) {
  const text = String(transcript);
  // "$1,234.56" or "1234 dollars" or "$120 a month"
  const re = /\$\s?([0-9][0-9,]{1,7}(?:\.\d{2})?)|([0-9][0-9,]{1,7}(?:\.\d{2})?)\s*dollars/gi;
  let best = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] || m[2] || "").replace(/,/g, "");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10 && n <= 1_000_000) {
      // Prefer the largest plausible amount (usually the premium, not "$0 down").
      if (best == null || n > best) best = n;
    }
  }
  return best;
}
