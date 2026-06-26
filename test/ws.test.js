import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { attachAgentWss } from "../src/realtime/ws.js";
import { publishToAgent } from "../src/realtime/bus.js";

test("agent receives only their own published events over WS", async () => {
  const server = http.createServer();
  attachAgentWss(server);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address();

  const ws = new WebSocket(`ws://localhost:${port}/ws/agent?identity=marisol.vega`);
  // Attach the message handler before "open" so the immediate "connected"
  // handshake frame can't slip through before we're listening.
  const messages = [];
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  await once(ws, "open");

  // First message is the "connected" handshake.
  await waitFor(() => messages.length >= 1);
  assert.equal(messages[0].type, "connected");

  // Event for a different agent must NOT arrive.
  publishToAgent("someone.else", "coaching", { cues: [] });
  // Event for this agent must arrive.
  publishToAgent("marisol.vega", "screenpop", { phone: "+14805550100", contact: null });

  await waitFor(() => messages.some((m) => m.type === "screenpop"));
  const pop = messages.find((m) => m.type === "screenpop");
  assert.equal(pop.phone, "+14805550100");
  assert.ok(!messages.some((m) => m.type === "coaching"));

  ws.close();
  await new Promise((r) => server.close(r));
});

test("WS rejects a connection with no identity", async () => {
  const server = http.createServer();
  attachAgentWss(server);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address();

  const ws = new WebSocket(`ws://localhost:${port}/ws/agent`);
  const [code] = await once(ws, "close");
  assert.equal(code, 1008);

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
