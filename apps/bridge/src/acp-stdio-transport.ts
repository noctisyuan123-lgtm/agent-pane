/**
 * ACP JSON-RPC over child process stdio (NDJSON lines).
 * Owns framing only — no Grok extensions, no DomainEvent mapping.
 */
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type {
  AcpHandlers,
  AcpTransport,
  JsonRpcMsg,
} from "./acp-transport.js";

/** @deprecated Prefer AcpHandlers from acp-transport.js */
export type AcpStdioHandlers = AcpHandlers;
export type { JsonRpcMsg };

export class AcpStdioTransport implements AcpTransport {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private handlers: AcpHandlers | null = null;

  attach(proc: ChildProcess, handlers: AcpHandlers): void {
    this.detach();
    this.closed = false;
    this.proc = proc;
    this.handlers = handlers;
    this.rl = readline.createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line));
  }

  /** Replace handlers without rebinding the process (e.g. after reassignment). */
  setHandlers(handlers: AcpHandlers): void {
    this.handlers = handlers;
  }

  isAlive(): boolean {
    return Boolean(
      this.proc &&
        !this.closed &&
        this.proc.exitCode === null &&
        this.proc.killed !== true &&
        this.proc.stdin &&
        !this.proc.stdin.destroyed
    );
  }

  get process(): ChildProcess | null {
    return this.proc;
  }

  write(obj: unknown): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  send(
    method: string,
    params?: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    // During start(), isAlive() may be strict; only require proc+stdin here
    if (!this.proc?.stdin || this.closed) {
      return Promise.reject(new Error("Agent not started"));
    }
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  reply(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  replyError(id: number | string, message: string, code = -32000): void {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMsg;
    try {
      msg = JSON.parse(line) as JsonRpcMsg;
    } catch {
      return;
    }

    // Client←Agent response to our request
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }

    // Agent→Client request (must reply) or notification
    if (msg.method) {
      if (msg.id != null) {
        void this.handlers?.onRequest(msg.id, msg.method, msg.params);
      } else {
        this.handlers?.onNotification(msg.method, msg.params);
      }
    }
  }

  /** Fail all pending RPCs and stop reading lines (does not kill the process). */
  close(): void {
    this.detach();
  }

  /** @deprecated use close() */
  detach(): void {
    this.closed = true;
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    this.rl = null;
    for (const [, p] of this.pending) {
      p.reject(new Error("Agent transport closed"));
    }
    this.pending.clear();
    this.proc = null;
    this.handlers = null;
  }

  /** Kill child + close. */
  dispose(): void {
    this.kill();
  }

  /** Kill child + detach. */
  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.detach();
  }
}
