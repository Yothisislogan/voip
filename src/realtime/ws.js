import { WebSocketServer } from "ws";
import { URL } from "node:url";
import { subscribeAgent } from "./bus.js";

/**
 * WebSocket channel that pushes screen-pop / coaching / recap events to the
 * agent's unified screen. The browser connects to:
 *
 *   ws(s)://<host>/ws/agent?identity=<agent-identity>
 *
 * and receives JSON messages: {type: "screenpop"|"coaching"|"recap", ...}.
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
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const identity = new URL(req.url, "http://localhost").searchParams.get("identity");
    if (!identity) {
      ws.close(1008, "identity required");
      return;
    }

    const unsubscribe = subscribeAgent(identity, (event) => {
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
