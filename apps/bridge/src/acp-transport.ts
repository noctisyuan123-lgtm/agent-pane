/**
 * Shared ACP JSON-RPC transport contract.
 * Framing only — no Grok extensions, no DomainEvent mapping.
 */

export type JsonRpcMsg = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type AcpHandlers = {
  onRequest: (
    id: number | string,
    method: string,
    params: unknown
  ) => void | Promise<void>;
  onNotification: (method: string, params: unknown) => void;
  /** Optional: transport lost (child exit / WS close). */
  onClose?: (reason?: string) => void;
};

/**
 * Bidirectional ACP channel (stdio child or WebSocket to `grok agent serve`).
 */
export interface AcpTransport {
  isAlive(): boolean;
  send(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<unknown>;
  /** JSON-RPC notification (no id) — e.g. session/cancel. */
  notify(method: string, params?: unknown): void;
  reply(id: number | string, result: unknown): void;
  replyError(id: number | string, message: string, code?: number): void;
  setHandlers(handlers: AcpHandlers): void;
  /**
   * Fail pending RPCs and stop I/O.
   * Stdio: does not kill the child. WS: closes the socket.
   */
  close(): void;
  /**
   * close() + release underlying resources.
   * Stdio: kill child. WS: close socket (daemon process stays up).
   */
  dispose(): void;
}
