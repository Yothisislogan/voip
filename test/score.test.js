import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCall } from "../src/ai/score.js";

test("a strong quote call scores high", () => {
  const s = scoreCall({
    recap: {
      outcome: "quote_requested",
      customerSentiment: "positive",
      productsDiscussed: ["Auto"],
      objections: [],
      nextSteps: ["Send quote"],
      followUpDate: "2026-09-01",
    },
    transcript: "Customer: let's do it",
  });
  assert.ok(s.score >= 90, `expected high score, got ${s.score}`);
  assert.equal(s.outcome, "quote_requested");
  assert.ok(s.factors.some((f) => f.label.includes("Buying signal")));
});

test("a not-interested, negative call scores near zero and clamps", () => {
  const s = scoreCall({
    recap: { outcome: "not_interested", customerSentiment: "negative", objections: ["Price", "Timing"] },
  });
  assert.equal(s.score, 0);
  assert.equal(s.sentiment, "negative");
});

test("scores stay within 0..100", () => {
  const hi = scoreCall({ recap: { outcome: "sale", customerSentiment: "positive", productsDiscussed: ["a", "b", "c", "d"], nextSteps: ["x"], followUpDate: "2026-01-01" }, transcript: "bind it, move forward" });
  assert.ok(hi.score <= 100 && hi.score >= 0);
});

test("missing recap defaults to a neutral baseline", () => {
  const s = scoreCall({});
  assert.equal(s.outcome, "other");
  assert.equal(s.sentiment, "neutral");
  assert.equal(s.score, 50);
});
