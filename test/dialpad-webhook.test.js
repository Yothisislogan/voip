// Dialpad inbound webhook: JWT verification + normalization + forwarding.
process.env.SESSION_SECRET = "test-session-secret";
process.env.DIALPAD_WEBHOOK_SECRET = "dialpad-test-secret";
process.env.WITNEXT_URL = ""; // bridge off — we only test the receiver here

import express from "express";
import http from "node:http";
import jwt from "jsonwebtoken";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const { dialpadRouter } = await import("../src/routes/dialpad.js");

let base;
let server;
before(async () => {
  const app = express();
  app.use("/dialpad", express.text({ type: ["text/*", "application/jwt"], limit: "200kb" }));
  app.use(express.json());
  app.use(dialpadRouter);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function signedEvent(payload) {
  return jwt.sign(payload, "dialpad-test-secret", { algorithm: "HS256" });
}

test("a JWT-signed call-completed event is accepted (204)", async () => {
  const body = signedEvent({ call_id: "12345", state: "hangup", direction: "inbound", duration: 63000 });
  const r = await fetch(`${base}/dialpad/events`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  assert.equal(r.status, 204);
});

test("an unsigned JSON body is rejected (403) — never ingest unsigned call data", async () => {
  const r = await fetch(`${base}/dialpad/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call_id: "999", state: "hangup" }),
  });
  assert.equal(r.status, 403);
});

test("a JWT signed with the WRONG secret is rejected (403)", async () => {
  const body = jwt.sign({ call_id: "12345", state: "hangup" }, "attacker-secret", { algorithm: "HS256" });
  const r = await fetch(`${base}/dialpad/events`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  assert.equal(r.status, 403);
});

test("an unrecognized (but validly signed) event is acknowledged without forwarding (204)", async () => {
  const body = signedEvent({ something_else: true });
  const r = await fetch(`${base}/dialpad/events`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  assert.equal(r.status, 204);
});
