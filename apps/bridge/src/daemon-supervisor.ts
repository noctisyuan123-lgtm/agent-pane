/**
 * Lifecycle for `grok agent serve` — spawn / adopt / reclaim orphan / shutdown.
 *
 * Why orphans happen (vs Claude Code):
 * - Claude Code keeps the agent as a **child of the app/CLI** process tree; quit → tree dies.
 * - `grok agent serve` is a **long-lived daemon** on a fixed port (designed to outlive clients).
 * - If Bridge is SIGKILL'd (Tauri kill) or crashes, the daemon is reparented to launchd (PPID 1)
 *   and keeps 2419 — next Bridge cannot adopt without the secret.
 *
 * Mitigations: persist secret (0600) for adopt; on failed probe in auto mode, reclaim port; shutdown
 * kills by child handle **or** recorded pid.
 *
 * @see docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { withHealthyEnv } from "./path-env.js";

export type DaemonManageMode = "auto" | "external" | "off";

export type DaemonInfo = {
  bind: string;
  host: string;
  port: number;
  secret: string;
  wsUrl: string;
  /** We spawned this process (safe to kill on Bridge exit). */
  managed: boolean;
  pid?: number;
};

type DaemonFile = {
  bind: string;
  host: string;
  port: number;
  /** Local-only adopt key (chmod 0600). Not for git / UI. */
  secret?: string;
  /** sha256 hex — optional integrity / legacy files */
  secretHash?: string;
  pid?: number;
  managed: boolean;
  startedAt: string;
};

function agentPaneDir(): string {
  return path.join(process.env.HOME || "/tmp", ".agent-pane");
}

function daemonFilePath(): string {
  return path.join(agentPaneDir(), "daemon.json");
}

function parseBind(bind: string): { host: string; port: number } {
  const m = bind.match(/^([^:]+):(\d+)$/);
  if (!m) {
    throw new Error(
      `Invalid AGENT_PANE_SERVE_BIND "${bind}" — expected host:port`
    );
  }
  return { host: m[1], port: Number(m[2]) };
}

function buildWsUrl(host: string, port: number, secret: string): string {
  return `ws://${host}:${port}/ws?server-key=${encodeURIComponent(secret)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex");
}

function portOpen(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function probeWs(wsUrl: string, timeoutMs = 4000): Promise<boolean> {
  const { AcpWsTransport } = await import("./acp-ws-transport.js");
  const t = new AcpWsTransport();
  try {
    await Promise.race([
      t.connect(wsUrl),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("probe timeout")), timeoutMs)
      ),
    ]);
    await t.send(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "agent-pane-probe", version: "0.1.0" },
        clientCapabilities: {},
      },
      timeoutMs
    );
    t.dispose();
    return true;
  } catch {
    try {
      t.dispose();
    } catch {
      /* ignore */
    }
    return false;
  }
}

function readDaemonFile(): DaemonFile | null {
  try {
    if (!fs.existsSync(daemonFilePath())) return null;
    return JSON.parse(fs.readFileSync(daemonFilePath(), "utf8")) as DaemonFile;
  } catch {
    return null;
  }
}

/** SIGTERM then SIGKILL a pid (orphan reclaim). */
function killPid(pid: number, label: string): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already dead */
  }
  // brief wait is async elsewhere; sync escalate after short spin
  const start = Date.now();
  while (Date.now() - start < 400) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    console.log(`[daemon] ${label} pid=${pid} (SIGKILL)`);
  } catch {
    /* ignore */
  }
}

/**
 * Free bind port: kill pid from daemon.json and/or anything still listening.
 * Uses lsof when available (macOS/Linux).
 */
function reclaimPort(host: string, port: number): void {
  const file = readDaemonFile();
  if (file?.pid && file.managed) {
    console.warn(
      `[daemon] reclaiming managed orphan pid=${file.pid} on ${host}:${port}`
    );
    killPid(file.pid, "reclaimed");
  }

  // Anyone still listening (PPID 1 orphans, stale pid file, etc.)
  try {
    const out = execSync(
      `lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`,
      { encoding: "utf8" }
    ).trim();
    for (const line of out.split(/\s+/).filter(Boolean)) {
      const pid = Number(line);
      if (Number.isFinite(pid) && pid > 0) {
        console.warn(`[daemon] killing listener pid=${pid} on :${port}`);
        killPid(pid, "listener");
      }
    }
  } catch {
    /* lsof missing — pid file path only */
  }

  try {
    if (fs.existsSync(daemonFilePath())) fs.unlinkSync(daemonFilePath());
  } catch {
    /* ignore */
  }
}

export class DaemonSupervisor {
  private static _shared: DaemonSupervisor | null = null;

  static shared(): DaemonSupervisor {
    if (!this._shared) this._shared = new DaemonSupervisor();
    return this._shared;
  }

  /** Test helper */
  static resetShared(): void {
    this._shared = null;
  }

  private info: DaemonInfo | null = null;
  private child: ChildProcess | null = null;
  private ensurePromise: Promise<DaemonInfo> | null = null;

  get current(): DaemonInfo | null {
    return this.info;
  }

  manageMode(): DaemonManageMode {
    const m = (process.env.AGENT_PANE_SERVE_MANAGE ?? "auto").toLowerCase();
    if (m === "external" || m === "off" || m === "auto") return m;
    return "auto";
  }

  bindSpec(): string {
    return process.env.AGENT_PANE_SERVE_BIND ?? "127.0.0.1:2419";
  }

  grokBin(): string {
    return (
      process.env.GROK_BIN ?? `${process.env.HOME}/.grok/bin/grok`
    );
  }

  /**
   * Ensure a healthy serve is reachable. Idempotent.
   */
  async ensure(): Promise<DaemonInfo> {
    if (this.info) {
      const ok = await portOpen(this.info.host, this.info.port);
      if (ok && this.info.secret) {
        // quick re-probe optional; port open + cached secret is enough for same process
        return this.info;
      }
      this.info = null;
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInner().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  private async tryAdopt(
    host: string,
    port: number,
    bind: string,
    secrets: string[]
  ): Promise<DaemonInfo | null> {
    for (const secret of secrets) {
      if (!secret) continue;
      const wsUrl = buildWsUrl(host, port, secret);
      if (await probeWs(wsUrl)) {
        const file = readDaemonFile();
        const info: DaemonInfo = {
          bind,
          host,
          port,
          secret,
          wsUrl,
          managed: Boolean(file?.managed),
          pid: file?.pid,
        };
        this.info = info;
        console.log(
          `[daemon] adopted grok agent serve on ${host}:${port} managed=${info.managed}`
        );
        return info;
      }
    }
    return null;
  }

  private async ensureInner(): Promise<DaemonInfo> {
    const manage = this.manageMode();
    if (manage === "off") {
      throw new Error(
        "AGENT_PANE_SERVE_MANAGE=off — cannot use serve provider"
      );
    }

    const bind = this.bindSpec();
    const { host, port } = parseBind(bind);
    if (host !== "127.0.0.1" && host !== "localhost") {
      if (process.env.AGENT_PANE_SERVE_ALLOW_LAN !== "1") {
        throw new Error(
          `Refuse to bind/connect serve on ${host} (not loopback). ` +
            `Set AGENT_PANE_SERVE_ALLOW_LAN=1 only if you understand the risk.`
        );
      }
    }

    const envSecret =
      process.env.AGENT_PANE_SERVE_SECRET ?? process.env.GROK_AGENT_SECRET;
    const file = readDaemonFile();
    const fileSecret =
      file &&
      file.port === port &&
      (file.host === host || file.bind === bind)
        ? file.secret
        : undefined;

    const candidates = [envSecret, fileSecret].filter(
      (s): s is string => Boolean(s)
    );

    const open = await portOpen(host, port);

    if (open) {
      const adopted = await this.tryAdopt(host, port, bind, candidates);
      if (adopted) return adopted;

      if (manage === "external") {
        throw new Error(
          `Port ${host}:${port} is open but ACP probe failed ` +
            `(wrong secret or not grok agent serve). ` +
            `Set AGENT_PANE_SERVE_SECRET / GROK_AGENT_SECRET to match.`
        );
      }

      // auto: kill orphan / foreign stale listener and spawn fresh
      console.warn(
        `[daemon] ${host}:${port} busy but not adoptable — reclaiming for new serve`
      );
      reclaimPort(host, port);
      await new Promise((r) => setTimeout(r, 300));
      if (await portOpen(host, port, 200)) {
        // second try
        reclaimPort(host, port);
        await new Promise((r) => setTimeout(r, 400));
      }
      if (await portOpen(host, port, 200)) {
        throw new Error(
          `Port ${host}:${port} still busy after reclaim. ` +
            `Manually: lsof -iTCP:${port} -sTCP:LISTEN  then kill, ` +
            `or AGENT_PANE_SERVE_FALLBACK_STDIO=1`
        );
      }
    }

    if (manage === "external") {
      throw new Error(
        `AGENT_PANE_SERVE_MANAGE=external but nothing listens on ${host}:${port}. ` +
          `Start: grok agent serve --bind ${bind} --secret <token>`
      );
    }

    return this.spawnServe(host, port, bind, envSecret);
  }

  private async spawnServe(
    host: string,
    port: number,
    bind: string,
    envSecret?: string
  ): Promise<DaemonInfo> {
    const secret = envSecret ?? randomBytes(24).toString("hex");
    const bin = this.grokBin();
    if (!fs.existsSync(bin)) {
      throw new Error(`Grok binary not found: ${bin}`);
    }

    const child = spawn(
      bin,
      ["agent", "serve", "--bind", bind, "--secret", secret],
      {
        cwd: process.env.HOME || process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...withHealthyEnv(process.env),
          GROK_AGENT_SECRET: secret,
        },
        // Stay in Bridge's process group when possible so shell/job control
        // can signal us; we still reclaim orphans on next ensure().
        detached: false,
      }
    );
    this.child = child;

    child.stderr?.on("data", (buf: Buffer) => {
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[daemon stderr]", buf.toString().slice(0, 400));
      }
    });
    child.stdout?.on("data", (buf: Buffer) => {
      if (process.env.AGENT_PANE_DEBUG) {
        console.log("[daemon stdout]", buf.toString().slice(0, 400));
      }
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (this.info?.managed && this.info.pid === child.pid) {
        console.warn(`[daemon] serve exited (${code})`);
        this.info = null;
      }
    });

    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (await portOpen(host, port, 200)) {
        const wsUrl = buildWsUrl(host, port, secret);
        if (await probeWs(wsUrl, 3000)) {
          ready = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!ready) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.child = null;
      throw new Error(
        `Failed to start grok agent serve on ${bind} within 15s`
      );
    }

    const info: DaemonInfo = {
      bind,
      host,
      port,
      secret,
      wsUrl: buildWsUrl(host, port, secret),
      managed: true,
      pid: child.pid,
    };
    this.info = info;
    await this.writeDaemonFile(info);
    console.log(
      `[daemon] spawned grok agent serve on ${host}:${port} pid=${child.pid ?? "?"}`
    );
    return info;
  }

  private async writeDaemonFile(info: DaemonInfo): Promise<void> {
    try {
      fs.mkdirSync(agentPaneDir(), { recursive: true });
      const body: DaemonFile = {
        bind: info.bind,
        host: info.host,
        port: info.port,
        // Local adopt after Bridge restart (file mode 0600). Not logged / not UI.
        secret: info.secret,
        secretHash: await sha256Hex(info.secret),
        pid: info.pid,
        managed: info.managed,
        startedAt: new Date().toISOString(),
      };
      const p = daemonFilePath();
      fs.writeFileSync(p, JSON.stringify(body, null, 2), { mode: 0o600 });
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.warn("[daemon] write daemon.json failed", e);
    }
  }

  /**
   * Stop managed serve (child handle and/or pid file).
   */
  async shutdown(): Promise<void> {
    const info = this.info;
    const child = this.child;
    this.info = null;
    this.child = null;

    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 400));
      try {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }

    const file = readDaemonFile();
    const pid = info?.pid ?? file?.pid;
    if (pid && (info?.managed || file?.managed)) {
      try {
        process.kill(pid, 0);
        killPid(pid, "shutdown");
      } catch {
        /* already gone */
      }
    }

    try {
      if (fs.existsSync(daemonFilePath())) fs.unlinkSync(daemonFilePath());
    } catch {
      /* ignore */
    }
    console.log("[daemon] stopped managed serve");
  }
}
