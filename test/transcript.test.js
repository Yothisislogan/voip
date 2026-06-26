import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptStore } from "../src/ai/transcript.js";

test("append + format labels speakers", () => {
  const s = new TranscriptStore();
  s.append("CA1", "agent", "Hello there", 1);
  s.append("CA1", "customer", "I want a quote", 2);
  assert.equal(s.format("CA1"), "Agent: Hello there\nCustomer: I want a quote");
});

test("blank / whitespace utterances are ignored", () => {
  const s = new TranscriptStore();
  s.append("CA1", "agent", "   ", 1);
  s.append("CA1", "customer", "", 2);
  s.append("CA1", "customer", null, 3);
  assert.equal(s.has("CA1"), false);
  assert.equal(s.get("CA1").length, 0);
});

test("missing callSid is a no-op", () => {
  const s = new TranscriptStore();
  s.append("", "agent", "hi", 1);
  s.append(undefined, "agent", "hi", 1);
  assert.equal(s.get("").length, 0);
});

test("formatRecent returns only the last N lines", () => {
  const s = new TranscriptStore();
  for (let i = 0; i < 20; i++) s.append("CA1", "customer", `line ${i}`, i);
  const recent = s.formatRecent("CA1", 3).split("\n");
  assert.equal(recent.length, 3);
  assert.equal(recent[2], "Customer: line 19");
});

test("buffers are isolated per call and clearable", () => {
  const s = new TranscriptStore();
  s.append("CA1", "agent", "one", 1);
  s.append("CA2", "agent", "two", 1);
  assert.equal(s.format("CA1"), "Agent: one");
  assert.equal(s.format("CA2"), "Agent: two");
  s.clear("CA1");
  assert.equal(s.has("CA1"), false);
  assert.equal(s.has("CA2"), true);
});

test("buffer is capped to avoid unbounded growth", () => {
  const s = new TranscriptStore();
  for (let i = 0; i < 500; i++) s.append("CA1", "customer", `u${i}`, i);
  assert.ok(s.get("CA1").length <= 400);
  // Oldest entries are dropped, newest retained.
  assert.equal(s.get("CA1").at(-1).text, "u499");
});
