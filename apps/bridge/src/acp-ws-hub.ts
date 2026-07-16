/**
 * Shared WebSocket ACP client for `grok agent serve`.
 *
 * Why: on grok 0.2.101, *multiple* WS clients to one serve process do NOT each
 * receive their own session streams — updates land on one connection and the
 * other session's `session/prompt` can hang/timeout (observed interrupt).
 *
 * Fix: one WS + demux by `params.sessionId` to per-live-session handlers.
 *
 * @see docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md
 */
import type { AcpHandlers, AcpTransport } from "./acp-transport.js";
import { AcpWsTransport } from "./acp-ws-transport.js";
import { DaemonSupervisor } from "./daemon-supervisor.js";

type Bound = {
  handlers: AcpHandlers;
  /** Pane-side id for dead notifications when provider id not yet known */
  domainSessionId?: string;
};

export class AcpWsHub {
  private static _shared: AcpWsHub | null = null;

  static shared(): AcpWsHub {
    if (!this._shared) this._shared = new AcpWsHub();
    return this._shared;
  }

  static resetShared(): void {
    this._shared = null;
  }

  private transport: AcpWsTransport | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private ensurePromise: Promise<void> | null = null;

  /** providerSessionId → handlers */
  private byProvider = new Map<string, Bound>();
  /**
   * Views that have not finished session/new yet — receive unscoped RPCs
   * and notifications without sessionId (bootstrap).
   */
  private pending = new Set<SessionTransportView>();

  private closedHandlers: Array<(reason: string) => void> = [];

  async ensureReady(): Promise<void> {
    if (this.transport?.isAlive() && this.initialized) return;
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInner().finally(() => {
      this.ensurePromise = null;
    });
    return this.ensurePromise;
  }

  private async ensureInner(): Promise<void> {
    if (!this.transport?.isAlive()) {
      const daemon = await DaemonSupervisor.shared().ensure();
      const ws = new AcpWsTransport();
      await ws.connect(daemon.wsUrl, {
        onRequest: (id, method, params) => this.routeRequest(id, method, params),
        onNotification: (method, params) =>
          this.routeNotification(method, params),
        onClose: (reason) => this.onSocketClose(reason ?? "ws closed"),
      });
      this.transport = ws;
      this.initialized = false;
    }
    if (!this.initialized) {
      if (!this.initPromise) {
        this.initPromise = this.doInitialize().finally(() => {
          this.initPromise = null;
        });
      }
      await this.initPromise;
    }
  }

  private async doInitialize(): Promise<void> {
    if (!this.transport) throw new Error("WS hub not connected");
    await this.transport.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "agent-pane", version: "0.1.2" },
    });
    this.initialized = true;
    console.log("[acp-ws-hub] shared initialize ok");
  }

  /** Open a per-session transport view (does not create Core session). */
  openView(opts?: { domainSessionId?: string }): SessionTransportView {
    const view = new SessionTransportView(this, opts?.domainSessionId);
    this.pending.add(view);
    return view;
  }

  bindProvider(providerSessionId: string, view: SessionTransportView): void {
    const handlers = view.handlers;
    if (!handlers) return;
    this.byProvider.set(providerSessionId, {
      handlers,
      domainSessionId: view.domainSessionId,
    });
    this.pending.delete(view);
    view.providerSessionId = providerSessionId;
  }

  unbindProvider(providerSessionId: string): void {
    this.byProvider.delete(providerSessionId);
  }

  releaseView(view: SessionTransportView): void {
    this.pending.delete(view);
    if (view.providerSessionId) {
      this.byProvider.delete(view.providerSessionId);
    }
  }

  get wire(): AcpWsTransport {
    if (!this.transport) throw new Error("WS hub not connected");
    return this.transport;
  }

  isAlive(): boolean {
    return Boolean(this.transport?.isAlive());
  }

  private extractSessionId(params: unknown): string {
    const p = (params ?? {}) as Record<string, unknown>;
    const nested = p.update as Record<string, unknown> | undefined;
    return String(p.sessionId ?? nested?.sessionId ?? "").trim();
  }

  private routeRequest(
    id: number | string,
    method: string,
    params: unknown
  ): void {
    const sid = this.extractSessionId(params);
    if (sid) {
      const bound = this.byProvider.get(sid);
      if (bound) {
        void bound.handlers.onRequest(id, method, params);
        return;
      }
      // Unknown session — do not steal; reply method-not-found lightly
      this.transport?.replyError(id, `No local handler for session ${sid}`, -32001);
      return;
    }
    // Unscoped (fs/*, some auth): first pending, else first bound
    const any =
      [...this.pending][0]?.handlers ??
      this.byProvider.values().next().value?.handlers;
    if (any) {
      void any.onRequest(id, method, params);
      return;
    }
    this.transport?.replyError(id, "No session handlers", -32001);
  }

  private routeNotification(method: string, params: unknown): void {
    const sid = this.extractSessionId(params);
    if (sid) {
      const bound = this.byProvider.get(sid);
      if (bound) {
        bound.handlers.onNotification(method, params);
        return;
      }
      // Foreign / not ours — drop (prevents cross-talk if any)
      return;
    }
    // Unscoped notifications: deliver to all live sessions + pending
    for (const view of this.pending) {
      view.handlers?.onNotification(method, params);
    }
    for (const bound of this.byProvider.values()) {
      bound.handlers.onNotification(method, params);
    }
  }

  private onSocketClose(reason: string): void {
    this.initialized = false;
    this.transport = null;
    for (const bound of this.byProvider.values()) {
      try {
        bound.handlers.onClose?.(reason);
      } catch {
        /* ignore */
      }
    }
    for (const view of this.pending) {
      try {
        view.handlers?.onClose?.(reason);
      } catch {
        /* ignore */
      }
    }
    this.byProvider.clear();
    this.pending.clear();
    for (const h of this.closedHandlers) {
      try {
        h(reason);
      } catch {
        /* ignore */
      }
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.transport?.dispose();
    } catch {
      /* ignore */
    }
    this.transport = null;
    this.initialized = false;
    this.byProvider.clear();
    this.pending.clear();
  }
}

/**
 * Per-live-session facade implementing AcpTransport over the shared hub.
 * `initialize` is a no-op after hub init (adapter still calls it — we short-circuit).
 */
export class SessionTransportView implements AcpTransport {
  handlers: AcpHandlers | null = null;
  providerSessionId = "";
  domainSessionId?: string;
  private closed = false;

  constructor(
    private readonly hub: AcpWsHub,
    domainSessionId?: string
  ) {
    this.domainSessionId = domainSessionId;
  }

  setHandlers(handlers: AcpHandlers): void {
    this.handlers = handlers;
    if (this.providerSessionId) {
      this.hub.bindProvider(this.providerSessionId, this);
    }
  }

  /** Call after session/new so demux can route. */
  attachProviderSession(providerSessionId: string): void {
    this.hub.bindProvider(providerSessionId, this);
  }

  isAlive(): boolean {
    return !this.closed && this.hub.isAlive();
  }

  async send(
    method: string,
    params?: unknown,
    timeoutMs = 120_000
  ): Promise<unknown> {
    // Shared connection already initialized — skip duplicate initialize
    if (method === "initialize") {
      await this.hub.ensureReady();
      return {
        protocolVersion: 1,
        agentCapabilities: {},
        _meta: { sharedHub: true },
      };
    }
    await this.hub.ensureReady();
    return this.hub.wire.send(method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    if (!this.hub.isAlive()) return;
    this.hub.wire.notify(method, params);
  }

  reply(id: number | string, result: unknown): void {
    this.hub.wire.reply(id, result);
  }

  replyError(id: number | string, message: string, code = -32000): void {
    this.hub.wire.replyError(id, message, code);
  }

  close(): void {
    this.closed = true;
    this.hub.releaseView(this);
  }

  dispose(): void {
    this.close();
    this.handlers = null;
  }
}
