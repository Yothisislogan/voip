// Auth-enforced mode: the WebSocket upgrade must require a valid session cookie.
process.env.AUTH_REQUIRED = "true";
process.env.SESSION_SECRET = "test-session-secret";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";

const { attachAgentWss } = await import("../src/realtime/ws.js");
const { publishToAgent } = await import("../src/realtime/bus.js");
const session = await import("../src/auth/session.js");

async function startServer() {
  const server = http.createServer();
  attachAgentWss(server);
  server.listen(0);
  await once(server, "listening");
  return server;
}

test("upgrade without a session cookie is rejected", async () => {
  const server = await startServer();
  const { port } = server.address();

  const ws = new WebSocket(`ws://localhost:${port}/ws/agent`);
  let opened = false;
  ws.on("open", () => (opened = true));
  // Server writes 401 and destroys the socket → client errors / unexpected-response.
  await Promise.race([
    once(ws, "error").catch(() => {}),
    once(ws, "unexpected-response").catch(() => {}),
    new Promise((r) => setTimeout(r, 800)),
  ]);
  assert.equal(opened, false);

  try { ws.terminate(); } catch {}
  await new Promise((r) => server.close(r));
});

test("upgrade with a valid full session cookie connects and routes events", async () => {
  const server = await startServer();
  const { port } = server.address();

  const { token } = session.issueSession({
    email: "a@wit.com",
    identity: "marisol.vega",
    name: "M",
    level: "full",
  });

  const ws = new WebSocket(`ws://localhost:${port}/ws/agent`, {
    headers: { Cookie: `${session.cookieName}=${token}` },
  });
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  await once(ws, "open");

  publishToAgent("marisol.vega", "screenpop", { phone: "+14805550100", contact: null });
  await waitFor(() => messages.some((m) => m.type === "screenpop"));
  assert.equal(messages.find((m) => m.type === "screenpop").phone, "+14805550100");

  ws.close();
  await new Promise((r) => server.close(r));
});

function waitFor(pred, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error("waitFor timed out")); }
    }, 10);
  });
}
