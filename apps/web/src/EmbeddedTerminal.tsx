import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const WS_BASE =
  import.meta.env.VITE_BRIDGE_WS ?? "ws://127.0.0.1:8787";

function terminalWsUrl(): string {
  const base = WS_BASE.replace(/\/$/, "");
  return `${base}/terminal`;
}

type ServerMsg =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "hello"; channel?: string };

export type EmbeddedTerminalProps = {
  cwd: string;
  /** Stable id so multiple shells can share one cwd. */
  termId: string;
  active: boolean;
  /** When true on unmount, destroy the PTY (tab closed). */
  killOnUnmount?: boolean;
};

/** Skip fit when container is collapsed — zero-width fit corrupts the prompt. */
function canFit(el: HTMLElement): boolean {
  return el.clientWidth >= 40 && el.clientHeight >= 24;
}

export function EmbeddedTerminal({
  cwd,
  termId,
  active,
  killOnUnmount = false,
}: EmbeddedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const killRef = useRef(killOnUnmount);
  killRef.current = killOnUnmount;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "JetBrains Mono, SF Mono, ui-monospace, monospace",
      fontSize: 13,
      theme: {
        background: "#151515",
        foreground: "#e0e0e0",
        cursor: "#81a1c1",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(terminalWsUrl());
    wsRef.current = ws;

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const safeFit = () => {
      if (!canFit(container)) return;
      try {
        const prevCols = term.cols;
        const prevRows = term.rows;
        fit.fit();
        if (term.cols !== prevCols || term.rows !== prevRows) {
          send({ type: "resize", cols: term.cols, rows: term.rows });
        }
      } catch {
        /* ignore */
      }
    };

    ws.onopen = () => {
      safeFit();
      send({
        type: "attach",
        cwd,
        termId,
        cols: Math.max(term.cols, 80),
        rows: Math.max(term.rows, 24),
      });
    };

    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === "data") term.write(msg.data);
      else if (msg.type === "error")
        term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
      else if (msg.type === "exit")
        term.writeln(`\r\n\x1b[33m[exit ${msg.code}]\x1b[0m`);
    };

    const onData = term.onData((data) => send({ type: "input", data }));
    const ro = new ResizeObserver(() => {
      // Never fit a hidden / zero-size pane — that wraps the prompt into garbage
      if (!activeRef.current || !canFit(container)) return;
      safeFit();
    });
    ro.observe(container);

    return () => {
      onData.dispose();
      ro.disconnect();
      const kill = killRef.current;
      const payload = JSON.stringify({ type: "detach", kill });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        ws.close();
      } else if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener("open", () => {
          try {
            ws.send(payload);
          } catch {
            /* ignore */
          }
          ws.close();
        });
      } else {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [cwd, termId]);

  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const ws = wsRef.current;
    const container = containerRef.current;
    if (!term || !fit || !container) return;

    const doFit = () => {
      if (!canFit(container)) return;
      try {
        fit.fit();
        term.focus();
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      } catch {
        /* ignore */
      }
    };

    requestAnimationFrame(doFit);
    const t = window.setTimeout(doFit, 220);
    return () => window.clearTimeout(t);
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="embedded-terminal"
      style={{ width: "100%", height: "100%", minHeight: 200 }}
    />
  );
}
