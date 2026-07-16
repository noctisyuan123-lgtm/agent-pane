/**
 * ACP JSON-RPC over WebSocket to `grok agent serve`.
 * One text frame = one JSON-RPC object (not NDJSON).
 */
import WebSocket from "ws";
import type {
  AcpHandlers,
  AcpTransport,
  JsonRpcMsg,
} from "./acp-transport.js";

export class AcpWsTransport implements AcpTransport {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private closed = false;
  private handlers: AcpHandlers | null = null;
  private url = "";

  /**
   * Connect to serve URL (already includes `?server-key=`).
   * Resolves when the socket is open.
   */
  async connect(url: string, handlers?: AcpHandlers): Promise<void> {
    this.dispose();
    this.closed = false;
    this.url = url;
    if (handlers) this.handlers = handlers;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const onOpen = () => {
        cleanupOpen();
        resolve();
      };
      const onErr = (err: Error) => {
        cleanupOpen();
        reject(err);
      };
      const cleanupOpen = () => {
        ws.off("open", onOpen);
        ws.off("error", onErr);
      };
      ws.once("open", onOpen);
      ws.once("error", onErr);
    });

    const ws = this.ws!;
    ws.on("message", (data) => {
      this.handleMessage(String(data));
    });
    ws.on("close", (code, reason) => {
      const why = `ws closed ${code}${reason?.length ? `: ${reason}` : ""}`;
      this.failPending(why);
      this.closed = true;
      this.ws = null;
      try {
        this.handlers?.onClose?.(why);
      } catch {
        /* ignore */
      }
    });
    ws.on("error", (err) => {
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[acp-ws]", err.message);
      }
    });
  }

  setHandlers(handlers: AcpHandlers): void {
    this.handlers = handlers;
  }

  isAlive(): boolean {
    return Boolean(
      this.ws && !this.closed && this.ws.readyState === WebSocket.OPEN
    );
  }

  get connectedUrl(): string {
    // never log full URL (contains secret); expose host path only via redacted helper
    return this.url ? "[ws]" : "";
  }

  private write(obj: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  send(
    method: string,
    params?: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) {
      return Promise.reject(new Error("Agent WS not connected"));
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

  private handleMessage(raw: string): void {
    let msg: JsonRpcMsg;
    try {
      msg = JSON.parse(raw) as JsonRpcMsg;
    } catch {
      return;
    }

    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      if (msg.id != null) {
        void this.handlers?.onRequest(msg.id, msg.method, msg.params);
      } else {
        this.handlers?.onNotification(msg.method, msg.params);
      }
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  close(): void {
    this.closed = true;
    this.failPending("Agent transport closed");
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  dispose(): void {
    this.close();
    this.handlers = null;
  }
}
