/**
 * Lifecycle for `grok agent serve` — spawn / adopt / health / shutdown.
 * Secret never logged; URL built as ws://host:port/ws?server-key=…
 *
 * @see docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md
 */
import { spawn, type ChildProcess } from "node:child_process";
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
  /** sha256 hex of secret — not the secret itself */
  secretHash: string;
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
      if (ok) return this.info;
      this.info = null;
    }
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInner().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
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

    const envSecret = process.env.AGENT_PANE_SERVE_SECRET ?? process.env.GROK_AGENT_SECRET;
    const open = await portOpen(host, port);

    if (open) {
      // Try secrets: env → daemon.json (we only store hash; need env or re-read if we have memory)
      const candidates: string[] = [];
      if (envSecret) candidates.push(envSecret);
      // If we previously managed with in-memory secret after restart we lost it —
      // external mode requires env secret when adopting.
      for (const secret of candidates) {
        const wsUrl = buildWsUrl(host, port, secret);
        if (await probeWs(wsUrl)) {
          const info: DaemonInfo = {
            bind,
            host,
            port,
            secret,
            wsUrl,
            managed: false,
          };
          this.info = info;
          console.log(
            `[daemon] adopted grok agent serve on ${host}:${port} (managed=false)`
          );
          return info;
        }
      }
      throw new Error(
        `Port ${host}:${port} is open but ACP probe failed ` +
          `(wrong secret or not grok agent serve). ` +
          `Set AGENT_PANE_SERVE_SECRET / GROK_AGENT_SECRET to match, ` +
          `or free the port.`
      );
    }

    if (manage === "external") {
      throw new Error(
        `AGENT_PANE_SERVE_MANAGE=external but nothing listens on ${host}:${port}. ` +
          `Start: grok agent serve --bind ${bind} --secret <token>`
      );
    }

    // auto: spawn
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
        secretHash: await sha256Hex(info.secret),
        pid: info.pid,
        managed: info.managed,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(daemonFilePath(), JSON.stringify(body, null, 2));
    } catch (e) {
      console.warn("[daemon] write daemon.json failed", e);
    }
  }

  /**
   * Kill serve only if we spawned it.
   */
  async shutdown(): Promise<void> {
    const info = this.info;
    const child = this.child;
    this.info = null;
    this.child = null;
    if (info?.managed && child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // escalate
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      console.log("[daemon] stopped managed serve");
    }
    try {
      if (fs.existsSync(daemonFilePath())) fs.unlinkSync(daemonFilePath());
    } catch {
      /* ignore */
    }
  }
}
