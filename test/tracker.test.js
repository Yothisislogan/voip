// Case tracker smart links: token signing/verification security properties.
process.env.SESSION_SECRET = "test-session-secret";

import { test } from "node:test";
import assert from "node:assert/strict";

const { signTrackerId, verifyTrackerToken, TRACKER_STATUSES, trackerStatusOptions } = await import(
  "../src/store/tracker.js"
);

test("token round-trips: sign then verify returns the id", () => {
  assert.equal(verifyTrackerToken(signTrackerId(42)), 42);
  assert.equal(verifyTrackerToken(signTrackerId(1)), 1);
});

test("tampered signature is rejected", () => {
  const token = signTrackerId(42);
  const [payload, sig] = token.split(".");
  const flipped = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
  assert.equal(verifyTrackerToken(`${payload}.${flipped}`), null);
});

test("tampered payload (id swap) is rejected", () => {
  const t42 = signTrackerId(42);
  const t43 = signTrackerId(43);
  const forged = `${t43.split(".")[0]}.${t42.split(".")[1]}`; // 43's id, 42's sig
  assert.equal(verifyTrackerToken(forged), null);
});

test("garbage tokens are rejected without throwing", () => {
  for (const bad of ["", ".", "abc", "abc.def", "../../etc/passwd", null, undefined, "a".repeat(5000)]) {
    assert.equal(verifyTrackerToken(bad), null);
  }
});

test("token encodes only the numeric id — nonpositive/NaN payloads rejected", () => {
  // Sign arbitrary payloads via the real signer to isolate the id check.
  assert.equal(verifyTrackerToken(signTrackerId(0)), null);
  assert.equal(verifyTrackerToken(signTrackerId(-5)), null);
  assert.equal(verifyTrackerToken(signTrackerId("not-a-number")), null);
});

test("status vocabulary is stable and labeled", () => {
  const options = trackerStatusOptions();
  assert.equal(options.length, TRACKER_STATUSES.length);
  for (const o of options) {
    assert.ok(TRACKER_STATUSES.includes(o.key));
    assert.ok(o.label && typeof o.label === "string");
  }
  assert.ok(TRACKER_STATUSES.includes("quote_delivered"));
});
