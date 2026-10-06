import { WebSocketServer } from "ws";
import { URL } from "node:url";
import { subscribeAgent } from "./bus.js";
import { authenticateUpgrade } from "../auth/middleware.js";
import { config } from '../config.js';

/**
 * WebSocket channel that pushes screen-pop / coaching / recap events to the
 * agent's unified screen. The browser connects to:
 *
 *   ws(s)://<host>/ws/agent
 *
 * Identity is taken from the authenticated session cookie sent on the upgrade
 * request — NOT from the URL — so an agent only ever receives their own calls'
 * events (which contain customer PII). Unauthenticated upgrades are rejected.
 *
 * Attach to the same HTTP server the Express app listens on so it shares the
 * port (and Render's single exposed port).
 */
export function attachAgentWss(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws/agent") {
      // The separately authenticated Twilio Media Streams upgrade owns this path.
      if (pathname === '/voice/media') return;
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    const allowed = new Set([config.publicBaseUrl, ...config.allowedOrigins].filter(Boolean));
    if (origin && allowed.size && !allowed.has(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const agent = authenticateUpgrade(req);
    if (!agent?.identity) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    req._agentIdentity = agent.identity;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const identity = req._agentIdentity;
    ws.authRequest = req;

    const unsubscribe = subscribeAgent(identity, (event) => {
      if (authenticateUpgrade(req)?.identity !== identity) { ws.close(1008, 'Session expired'); return; }
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });

    ws.send(JSON.stringify({ type: "connected", identity, at: Date.now() }));

    // Heartbeat: drop dead connections so we don't leak subscriptions.
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));
    ws.on("close", unsubscribe);
    ws.on("error", unsubscribe);
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (authenticateUpgrade(ws.authRequest)?.identity !== ws.authRequest._agentIdentity) {
        ws.close(1008, 'Session expired');
        continue;
      }
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref?.();

  console.log("🔌 Agent WebSocket channel mounted at /ws/agent");
  return wss;
}
