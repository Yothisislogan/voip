/**
 * Deterministic call scorer. Produces a 0–100 lead/quality score plus the
 * factors that moved it, from the structured recap (and transcript as a tie-
 * breaker). Local and dependency-free so it works with any AI backend.
 */

const OUTCOME_DELTA = {
  sale: 40,
  quote_requested: 20,
  follow_up: 10,
  callback: 5,
  other: 0,
  no_answer: -20,
  not_interested: -30,
};

export function scoreCall({ recap, transcript = "" } = {}) {
  const factors = [];
  let score = 50;
  const add = (delta, label) => {
    if (!delta) return;
    score += delta;
    factors.push({ label, delta });
  };

  const outcome = recap?.outcome || "other";
  add(OUTCOME_DELTA[outcome] ?? 0, `Outcome: ${prettify(outcome)}`);

  const sentiment = recap?.customerSentiment || "neutral";
  if (sentiment === "positive") add(10, "Positive customer sentiment");
  if (sentiment === "negative") add(-10, "Negative customer sentiment");

  const products = recap?.productsDiscussed?.length || 0;
  if (products) add(Math.min(products * 5, 15), `Discussed ${products} product${products > 1 ? "s" : ""}`);

  const objections = recap?.objections?.length || 0;
  if (objections) add(-Math.min(objections * 5, 15), `${objections} objection${objections > 1 ? "s" : ""} raised`);

  const nextSteps = recap?.nextSteps?.length || 0;
  if (nextSteps) add(5, "Clear next steps");
  if (recap?.followUpDate) add(5, "Follow-up scheduled");

  const t = String(transcript).toLowerCase();
  if (/\b(move forward|bind|sign up|start today|purchase|let's do it|lets do it)\b/.test(t)) {
    add(10, "Buying signal detected");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    sentiment,
    outcome,
    factors,
    summary: `${score}/100 — ${prettify(outcome)}, ${sentiment} sentiment.`,
  };
}

function prettify(s) {
  return String(s || "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
