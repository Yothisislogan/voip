import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRecapNote } from "../src/ai/recap.js";

const baseRecap = {
  summary: "Customer wants an auto + home bundle.",
  outcome: "follow_up",
  productsDiscussed: ["Auto", "Home"],
  objections: ["Price too high"],
  nextSteps: ["Send bundled quote"],
  followUpDate: "2026-07-01",
  customerSentiment: "positive",
};

test("formatRecapNote builds subject + body", () => {
  const note = formatRecapNote(baseRecap, {
    from: "+14805550100",
    to: "+14805550111",
    durationSec: 412,
  });
  assert.equal(note.subject, "Call recap — Follow Up");
  assert.match(note.description, /Customer wants an auto \+ home bundle\./);
  assert.match(note.description, /Outcome: Follow Up/);
  assert.match(note.description, /Customer sentiment: positive/);
  assert.match(note.description, /Products discussed: Auto, Home/);
  assert.match(note.description, /• Price too high/);
  assert.match(note.description, /• Send bundled quote/);
  assert.match(note.description, /Follow-up date: 2026-07-01/);
  assert.match(note.description, /Call from \+14805550100 \/ to \+14805550111 \/ 412s\./);
});

test("formatRecapNote omits empty sections", () => {
  const note = formatRecapNote({
    summary: "Quick call.",
    outcome: "no_answer",
    productsDiscussed: [],
    objections: [],
    nextSteps: [],
    followUpDate: "",
    customerSentiment: "neutral",
  });
  assert.doesNotMatch(note.description, /Products discussed/);
  assert.doesNotMatch(note.description, /Objections/);
  assert.doesNotMatch(note.description, /Next steps/);
  assert.doesNotMatch(note.description, /Follow-up date/);
  assert.equal(note.subject, "Call recap — No Answer");
});

test("formatRecapNote returns null for null recap", () => {
  assert.equal(formatRecapNote(null), null);
});
