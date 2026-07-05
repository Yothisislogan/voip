import { test } from "node:test";
import assert from "node:assert/strict";
import { extractLeadFields } from "../src/ai/extract.js";
import { parseInboundEmail, parseFrom, extractPhone, stripHtml } from "../src/intake/email.js";
import { parseSurveyRating } from "../src/realtime/survey.js";

// ── lead extraction ──
test("extractLeadFields pulls policy/carrier/premium/email", () => {
  const t = "Agent: what do you pay? Customer: I have Geico auto and pay $1,450 a year. Email me at jane.doe@x.com";
  const f = extractLeadFields(t, { productsDiscussed: ["Auto"], outcome: "quote_requested" });
  assert.equal(f.policy_type, "Auto");
  assert.equal(f.carrier, "GEICO");
  assert.equal(f.premium, 1450);
  assert.equal(f.email, "jane.doe@x.com");
});

test("extractLeadFields maps outcome to lifecycle stage", () => {
  assert.equal(extractLeadFields("bind it", { outcome: "sale" }).lifecycle_stage, "customer");
  assert.equal(extractLeadFields("no thanks", { outcome: "not_interested" }).lifecycle_stage, "lost");
});

test("premium picks the largest plausible amount", () => {
  const f = extractLeadFields("$0 down and $1,200 for the year", null);
  assert.equal(f.premium, 1200);
});

// ── email parsing ──
test("parseFrom splits name and email", () => {
  assert.deepEqual(parseFrom("Jane Doe <jane@x.com>"), { name: "Jane Doe", email: "jane@x.com" });
  assert.deepEqual(parseFrom("bob@y.com"), { name: "", email: "bob@y.com" });
});

test("extractPhone finds a US number in free text", () => {
  assert.equal(extractPhone("call me at (480) 555-0199 tomorrow"), "+14805550199");
  assert.equal(extractPhone("no number here"), null);
});

test("stripHtml removes tags", () => {
  assert.equal(stripHtml("<p>Hello&nbsp;<b>world</b></p>"), "Hello world");
});

test("parseInboundEmail normalizes SendGrid and Mailgun shapes", () => {
  const sg = parseInboundEmail({ from: "Bob Roe <bob@x.com>", subject: "Quote", text: "need auto" });
  assert.equal(sg.fromEmail, "bob@x.com");
  assert.equal(sg.fromName, "Bob Roe");
  assert.equal(sg.body, "need auto");

  const mg = parseInboundEmail({ sender: "amy@z.com", subject: "Hi", "body-plain": "home insurance please" });
  assert.equal(mg.fromEmail, "amy@z.com");
  assert.equal(mg.body, "home insurance please");
});

// ── survey rating ──
test("parseSurveyRating reads a 1-5 reply", () => {
  assert.equal(parseSurveyRating("5 - great"), 5);
  assert.equal(parseSurveyRating("I'd say 3"), 3);
  assert.equal(parseSurveyRating("no number"), null);
  assert.equal(parseSurveyRating("9"), null);
});
