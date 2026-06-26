// Dev-bypass mode so the upgrade is allowed and the injected identity matches
// the channel we publish to. (Auth-enforced rejection is covered in
// ws-auth.test.js, which needs a different config and so a separate process.)
process.env.AUTH_REQUIRED = "false";
process.env.DEV_IDENTITY = "marisol.vega";

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";

const { attachAgentWss } = await import("../src/realtime/ws.js");
const { publishToAgent } = await import("../src/realtime/bus.js");

test("agent receives only their own published events over WS", async () => {
  const server = http.createServer();
  attachAgentWss(server);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address();

  const ws = new WebSocket(`ws://localhost:${port}/ws/agent`);
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  await once(ws, "open");

  await waitFor(() => messages.length >= 1);
  assert.equal(messages[0].type, "connected");

  // Identity is the dev identity (marisol.vega); events for another agent must not arrive.
  publishToAgent("someone.else", "coaching", { cues: [] });
  publishToAgent("marisol.vega", "screenpop", { phone: "+14805550100", contact: null });

  await waitFor(() => messages.some((m) => m.type === "screenpop"));
  assert.equal(messages.find((m) => m.type === "screenpop").phone, "+14805550100");
  assert.ok(!messages.some((m) => m.type === "coaching"));

  ws.close();
  await new Promise((r) => server.close(r));
});

function waitFor(pred, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(iv);
        reject(new Error("waitFor timed out"));
      }
    }, 10);
  });
}
