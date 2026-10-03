// WiTNext bridge: signing, verification, delivery, and retry semantics.
process.env.SESSION_SECRET = "test-session-secret";
process.env.WITNEXT_URL = "http://127.0.0.1:1"; // repointed at the mock below
process.env.WITNEXT_INTEGRATION_ID = "test-integration";
process.env.WITNEXT_INTEGRATION_SECRET = "witnext-test-secret";

import http from "node:http";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { config } = await import("../src/config.js");
const {
  signWitnextRequest,
  verifyWitnextRequest,
  buildSignedEvent,
  sendWitnextEvent,
} = await import("../src/integrations/witnext.js");

// ── Mock WiTNext receiver: verifies exactly like the contract says ──
const seenEventIds = new Set();
let received = [];
let mode = "ok"; // ok | fail
const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers["x-wit-integration-id"] !== "test-integration") return res.writeHead(401).end();
    if (mode === "conflict") return res.writeHead(409).end();
    if (mode === "fail") return res.writeHead(500).end();
    const ok = verifyWitnextRequest({
      secret: config.witnext.secret,
      timestamp: req.headers["x-wit-timestamp"],
      nonce: req.headers["x-wit-nonce"],
      eventId: req.headers["x-wit-event-id"],
      rawBody: raw,
      signature: req.headers["x-wit-signature"],
    });
    if (!ok) return res.writeHead(403).end(JSON.stringify({ error: "bad signature" }));
    const id = req.headers["x-wit-event-id"];
    if (seenEventIds.has(id)) return res.writeHead(200).end(JSON.stringify({ status: "duplicate" })); // receiver contract
    seenEventIds.add(id);
    received.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(202).end();
  });
});

before(async () => {
  await new Promise((r) => mock.listen(0, r));
  config.witnext.url = `http://127.0.0.1:${mock.address().port}`;
});
after(() => mock.close());

// ── signing primitives ──
test("sign + verify round-trips", () => {
  const parts = { secret: "s", timestamp: Math.floor(Date.now() / 1000), nonce: "n1", eventId: "e1", rawBody: '{"a":1}' };
  const signature = signWitnextRequest(parts);
  assert.equal(verifyWitnextRequest({ ...parts, signature }), true);
});

test("verification rejects tampered body, wrong secret, and stale timestamps", () => {
  const ts = Math.floor(Date.now() / 1000);
  const parts = { secret: "s", timestamp: ts, nonce: "n", eventId: "e", rawBody: "{}" };
  const signature = signWitnextRequest(parts);
  assert.equal(verifyWitnextRequest({ ...parts, signature, rawBody: '{"x":1}' }), false); // tampered
  assert.equal(verifyWitnextRequest({ ...parts, signature, secret: "other" }), false); // wrong secret
  assert.equal(verifyWitnextRequest({ ...parts, signature, timestamp: ts - 600 }), false); // >5 min old
  assert.equal(verifyWitnextRequest({ ...parts, signature: "00" + signature.slice(2) }), false); // flipped sig
});

test("buildSignedEvent produces a verifiable envelope with all required fields", () => {
  const { body, headers } = buildSignedEvent({ eventType: "call.completed", payload: { call_id: "CA1" } });
  const env = JSON.parse(body);
  for (const k of ["event_id", "event_type", "provider", "occurred_at", "sent_at", "nonce", "payload"]) {
    assert.ok(k in env, `missing ${k}`);
  }
  assert.equal(env.event_type, "call.completed");
  assert.equal(
    verifyWitnextRequest({
      secret: config.witnext.secret,
      timestamp: headers["X-WIT-Timestamp"],
      nonce: headers["X-WIT-Nonce"],
      eventId: headers["X-WIT-Event-Id"],
      rawBody: body,
      signature: headers["X-WIT-Signature"],
    }),
    true
  );
});

// ── delivery against the mock receiver ──
test("delivers a call event to the call-events path and passes verification", async () => {
  received = [];
  const id = await sendWitnextEvent("call.completed", { call_id: "CAbridge1", direction: "inbound" });
  assert.ok(id);
  assert.equal(received.length, 1);
  assert.ok(received[0].path.includes("/integrations/dialpad/events"));
  assert.equal(received[0].body.payload.call_id, "CAbridge1");
});

test("email events route to the email-events path", async () => {
  received = [];
  await sendWitnextEvent("email.lead_received", { from_email: "x@y.com" });
  assert.equal(received.length, 1);
  assert.ok(received[0].path.includes("/integrations/email/events"));
});

test("retry with the same event_id is treated as delivered (receiver 200)", async () => {
  received = [];
  const id = await sendWitnextEvent("call.completed", { call_id: "CAbridge2" }, { eventId: "fixed-id-1" });
  assert.equal(id, "fixed-id-1");
  // Second attempt (as the DLQ retry would do) → receiver 200 → resolves, no dupe.
  const again = await sendWitnextEvent("call.completed", { call_id: "CAbridge2" }, { eventId: "fixed-id-1" });
  assert.equal(again, "fixed-id-1");
  assert.equal(received.length, 1); // receiver stored it exactly once
});

test("receiver failure throws so the DLQ can capture it", async () => {
  mode = "fail";
  await assert.rejects(() => sendWitnextEvent("call.completed", { call_id: "CAbridge3" }), /delivery failed/);
  mode = "ok";
});

test("bridge is a no-op when not configured", async () => {
  const savedUrl = config.witnext.url;
  config.witnext.url = "";
  assert.equal(await sendWitnextEvent("call.completed", { call_id: "CAx" }), null);
  config.witnext.url = savedUrl;
});

 test("409 replay rejection is not mistaken for delivered", async () => {
  mode = "conflict";
  await assert.rejects(() => sendWitnextEvent("call.completed", { call_id: "CAreplay" }), /409/);
  mode = "ok";
});
