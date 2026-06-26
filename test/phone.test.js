import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, digitsOnly, phoneVariants } from "../src/util/phone.js";

test("normalizePhone assumes +1 for 10-digit US numbers", () => {
  assert.equal(normalizePhone("4805550100"), "+14805550100");
  assert.equal(normalizePhone("(480) 555-0100"), "+14805550100");
  assert.equal(normalizePhone("480-555-0100"), "+14805550100");
});

test("normalizePhone keeps existing country code", () => {
  assert.equal(normalizePhone("14805550100"), "+14805550100");
  assert.equal(normalizePhone("+14805550100"), "+14805550100");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
});

test("normalizePhone handles empty / junk", () => {
  assert.equal(normalizePhone(""), "");
  assert.equal(normalizePhone(null), "");
  assert.equal(normalizePhone("abc"), "");
});

test("digitsOnly strips non-digits", () => {
  assert.equal(digitsOnly("+1 (480) 555-0100"), "14805550100");
});

test("phoneVariants returns most-distinctive-first, deduped", () => {
  assert.deepEqual(phoneVariants("(480) 555-0100"), ["5550100", "4805550100"]);
  assert.deepEqual(phoneVariants("+14805550100"), ["5550100", "4805550100", "14805550100"]);
  // short number → only the full string
  assert.deepEqual(phoneVariants("12345"), ["12345"]);
});
