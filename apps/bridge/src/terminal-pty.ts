import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildAugmentedPath } from "./path-env.js";

const SHELL = process.env.SHELL || "/bin/zsh";

export type TerminalSend = (msg: ServerMsg) => void;

export type ClientMsg =
  | {
      type: "attach";
      cwd: string;
      termId?: string;
      cols?: number;
      rows?: number;
    }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach"; kill?: boolean };

export type ServerMsg =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export interface WsLike {
  send(data: string): void;
}

interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
}

interface AttachedClient {
  send: TerminalSend;
}

/** Dynamic import without compile-time module resolution (optional dep). */
function dynamicImport(specifier: string): Promise<unknown> {
  return new Function("s", "return import(s)")(specifier) as Promise<unknown>;
}

/** npm packs spawn-helper without +x → posix_spawnp fails. */
function ensureSpawnHelperExecutable(): void {
  try {
    let root: string | null = null;
    try {
      const req = createRequire(
        // CJS bundle: import.meta.url is empty — resolve from cwd / NODE_PATH
        path.resolve(process.cwd(), "package.json")
      );
      root = path.dirname(req.resolve("node-pty/package.json"));
    } catch {
      const nm = process.env.NODE_PATH?.split(path.delimiter)[0];
      if (nm) {
        const cand = path.join(nm, "node-pty");
        if (fs.existsSync(cand)) root = cand;
      }
    }
    if (!root) return;
    const prebuilds = path.join(root, "prebuilds");
    if (!fs.existsSync(prebuilds)) return;
    for (const plat of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, plat, "spawn-helper");
      if (!fs.existsSync(helper)) continue;
      try {
        fs.accessSync(helper, fs.constants.X_OK);
      } catch {
        fs.chmodSync(helper, 0o755);
      }
    }
  } catch {
    /* ignore — spawn will surface a clear error */
  }
}

type NodePtySpawn = (
  file: string,
  args: string[],
  opts: Record<string, unknown>
) => {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  removeListener(event: string, cb: unknown): void;
};

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    // Drop IDE/npm noise that can confuse interactive shells in a PTY
    if (/^(npm_|npm_config_|CURSOR_|VSCODE_|ELECTRON)/i.test(k)) continue;
    env[k] = v;
  }
  env.PATH = buildAugmentedPath(env.PATH ?? process.env.PATH);
  env.TERM = "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  env.SHELL = SHELL;
  return env;
}

async function createPty(
  cwd: string,
  cols: number,
  rows: number
): Promise<PtyHandle> {
  ensureSpawnHelperExecutable();
  let mod: { spawn: NodePtySpawn };
  try {
    mod = (await dynamicImport("node-pty")) as { spawn: NodePtySpawn };
  } catch (e) {
    throw new Error(
      `node-pty unavailable (${e instanceof Error ? e.message : e}). Run: npm rebuild node-pty`
    );
  }

  let pty;
  try {
    pty = mod.spawn(SHELL, [], {
      name: "xterm-256color",
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 8),
      cwd,
      env: buildPtyEnv(),
    });
  } catch (e) {
    throw new Error(
      `PTY spawn failed (${e instanceof Error ? e.message : e}). ` +
        `Try: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
    );
  }

  return {
    write: (data) => pty.write(data),
    resize: (c, r) => pty.resize(Math.max(c, 20), Math.max(r, 8)),
    kill: () => {
      try {
        pty.kill();
      } catch {
        /* ignore */
      }
    },
    onData: (cb) => {
      pty.onData(cb);
      return () => pty.removeListener("data", cb);
    },
    onExit: (cb) => {
      const handler = (e: { exitCode: number }) => cb(e.exitCode ?? 0);
      pty.onExit(handler);
      return () => pty.removeListener("exit", handler);
    },
  };
}

export class TerminalHub {
  private cwd: string;
  private pty: PtyHandle | null = null;
  private starting: Promise<void> | null = null;
  private clients = new Map<symbol, AttachedClient>();
  private cols = 80;
  private rows = 24;
  private dataUnsub: (() => void) | null = null;
  private exitUnsub: (() => void) | null = null;
  /** Input typed before PTY is ready (e.g. `grok login` + Enter). */
  private pendingInput = "";

  constructor(_key: string, cwd: string) {
    this.cwd = cwd;
  }

  private broadcast(msg: ServerMsg): void {
    for (const { send } of this.clients.values()) {
      send(msg);
    }
  }

  private flushPendingInput(): void {
    if (!this.pty || !this.pendingInput) return;
    const buf = this.pendingInput;
    this.pendingInput = "";
    this.pty.write(buf);
  }

  private async ensurePty(): Promise<void> {
    if (this.pty) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const pty = await createPty(this.cwd, this.cols, this.rows);
        this.pty = pty;
        this.dataUnsub = pty.onData((data) => {
          this.broadcast({ type: "data", data });
        });
        this.exitUnsub = pty.onExit((code) => {
          this.broadcast({ type: "exit", code });
          this.destroyPty();
        });
        this.flushPendingInput();
      } catch (e) {
        this.broadcast({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  private destroyPty(): void {
    this.dataUnsub?.();
    this.exitUnsub?.();
    this.dataUnsub = null;
    this.exitUnsub = null;
    this.pty?.kill();
    this.pty = null;
    this.pendingInput = "";
  }

  attach(send: TerminalSend, cols = 80, rows = 24): symbol {
    this.cols = cols;
    this.rows = rows;
    const id = Symbol("terminal-client");
    this.clients.set(id, { send });
    void this.ensurePty()
      .then(() => {
        this.pty?.resize(this.cols, this.rows);
        this.flushPendingInput();
        send({ type: "ready" });
      })
      .catch((e) => {
        send({
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      });
    return id;
  }

  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
      return;
    }
    // Queue until spawn finishes — otherwise early keystrokes are dropped
    this.pendingInput += data;
    void this.ensurePty();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
  }

  /** Detach one client; keep PTY alive so reopening the panel reconnects. */
  dispose(sessionId: symbol): void {
    this.clients.delete(sessionId);
  }

  /** Explicit teardown (e.g. workspace cwd changed). */
  kill(): void {
    this.clients.clear();
    this.destroyPty();
  }

  clientCount(): number {
    return this.clients.size;
  }
}

const hubs = new Map<string, TerminalHub>();

export interface TerminalSession {
  hub: TerminalHub;
  clientId: symbol;
  cwd: string;
  hubKey: string;
}

/** Module-level map of WS connections to terminal sessions. */
export const terminalSessions = new Map<WsLike, TerminalSession>();

function hubKey(cwd: string, termId?: string): string {
  return termId ? `${cwd}::${termId}` : cwd;
}

function getHub(cwd: string, termId?: string): TerminalHub {
  const key = hubKey(cwd, termId);
  let hub = hubs.get(key);
  if (!hub) {
    hub = new TerminalHub(key, cwd);
    hubs.set(key, hub);
  }
  return hub;
}

function sendJson(ws: WsLike, msg: ServerMsg): void {
  ws.send(JSON.stringify(msg));
}

export function handleTerminalWs(ws: WsLike, rawMessage: unknown): void {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(String(rawMessage)) as ClientMsg;
  } catch {
    sendJson(ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "attach": {
      const cwd = msg.cwd;
      if (!cwd) {
        sendJson(ws, { type: "error", message: "attach requires cwd" });
        return;
      }
      const existing = terminalSessions.get(ws);
      if (existing) {
        existing.hub.dispose(existing.clientId);
        terminalSessions.delete(ws);
      }
      const key = hubKey(cwd, msg.termId);
      const hub = getHub(cwd, msg.termId);
      const clientId = hub.attach(
        (m) => sendJson(ws, m),
        msg.cols ?? 80,
        msg.rows ?? 24
      );
      terminalSessions.set(ws, { hub, clientId, cwd, hubKey: key });
      break;
    }
    case "input": {
      const session = terminalSessions.get(ws);
      if (!session) {
        sendJson(ws, { type: "error", message: "Not attached" });
        return;
      }
      session.hub.write(msg.data);
      break;
    }
    case "resize": {
      const session = terminalSessions.get(ws);
      if (!session) {
        sendJson(ws, { type: "error", message: "Not attached" });
        return;
      }
      session.hub.resize(msg.cols, msg.rows);
      break;
    }
    case "detach": {
      const session = terminalSessions.get(ws);
      if (session) {
        session.hub.dispose(session.clientId);
        terminalSessions.delete(ws);
        if (msg.kill) {
          session.hub.kill();
          hubs.delete(session.hubKey);
        }
      }
      break;
    }
    default:
      sendJson(ws, { type: "error", message: "Unknown message type" });
  }
}

export function createTerminalConnection(ws: WsLike): void {
  ws.send(JSON.stringify({ type: "hello", channel: "terminal" } satisfies Record<string, string>));
}
