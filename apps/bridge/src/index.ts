import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientCommand } from "@agent-pane/shared";
import { SessionManager } from "./session-manager.js";

const PORT = Number(process.env.AGENT_PANE_PORT ?? 8787);
const HOST = process.env.AGENT_PANE_HOST ?? "127.0.0.1";

const clients = new Set<WebSocket>();

function broadcast(msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}

const sessions = new SessionManager({
  broadcast,
  permissionMode: process.env.AGENT_PANE_PERMISSION ?? "auto",
});

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "agent-pane-bridge" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));

  ws.on("message", async (raw) => {
    try {
      const cmd = JSON.parse(String(raw)) as ClientCommand;
      await sessions.handleCommand(cmd);
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        })
      );
    }
  });

  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-pane] bridge ws://${HOST}:${PORT}`);
  console.log(`[agent-pane] health http://${HOST}:${PORT}/health`);
});
