import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientCommand } from "@agent-pane/shared";
import { SessionManager } from "./session-manager.js";
import { handleHttp, pushRecent } from "./http-api.js";
import {
  createTerminalConnection,
  handleTerminalWs,
  terminalSessions,
} from "./terminal-pty.js";
import { applyHealthyPathToProcess } from "./path-env.js";

// GUI-launched Tauri often inherits a lean PATH; fix before any tool/PTY spawn.
applyHealthyPathToProcess();

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

const server = http.createServer(async (req, res) => {
  try {
    const handled = await handleHttp(req, res, {
      stopSession: (id) => sessions.stopSession(id),
      purgeSession: (id) => sessions.purgeSession(id),
    });
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    );
  }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const pathname = (req.url ?? "/").split("?")[0] || "/";

  if (pathname === "/terminal") {
    createTerminalConnection(ws);
    ws.on("message", (raw) => {
      handleTerminalWs(ws, raw);
    });
    ws.on("close", () => {
      handleTerminalWs(ws, JSON.stringify({ type: "detach" }));
      terminalSessions.delete(ws);
    });
    return;
  }

  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));
  // Snapshot of currently live agents (multi-session)
  try {
    ws.send(
      JSON.stringify({
        type: "live",
        sessionIds: sessions.listLiveSessionIds(),
      })
    );
  } catch {
    /* ignore */
  }

  ws.on("message", async (raw) => {
    try {
      const cmd = JSON.parse(String(raw)) as ClientCommand;
      if (cmd.type === "session.create" && cmd.cwd) {
        try {
          pushRecent(cmd.cwd);
        } catch {
          /* ignore */
        }
      }
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
  console.log(`[agent-pane] terminal ws://${HOST}:${PORT}/terminal`);
  console.log(`[agent-pane] health http://${HOST}:${PORT}/health`);
  console.log(`[agent-pane] folder-pick POST http://${HOST}:${PORT}/api/folder-pick`);
});
