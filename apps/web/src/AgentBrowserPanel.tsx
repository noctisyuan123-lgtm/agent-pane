import { useCallback, useEffect, useState } from "react";

const BRIDGE_HTTP =
  import.meta.env.VITE_BRIDGE_HTTP ?? "http://127.0.0.1:8787";

export type BrowserState = {
  url: string;
  title: string;
  screenshotBase64: string;
  error?: string;
};

export type AgentBrowserPanelProps = {
  active: boolean;
};

export function AgentBrowserPanel({ active }: AgentBrowserPanelProps) {
  const [urlInput, setUrlInput] = useState("http://127.0.0.1:5173");
  const [state, setState] = useState<BrowserState>({
    url: "",
    title: "",
    screenshotBase64: "",
  });
  const [busy, setBusy] = useState(false);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(`${BRIDGE_HTTP}/api/browser/state`);
      if (!res.ok) return;
      const data = (await res.json()) as BrowserState;
      setState(data);
      if (data.url) setUrlInput(data.url);
    } catch {
      /* ignore poll errors */
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void fetchState();
    const id = window.setInterval(() => void fetchState(), 1500);
    return () => window.clearInterval(id);
  }, [active, fetchState]);

  const navigate = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${BRIDGE_HTTP}/api/browser/navigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput }),
      });
      if (!res.ok) {
        const t = await res.text();
        setState((s) => ({ ...s, error: t || `HTTP ${res.status}` }));
        return;
      }
      const data = (await res.json()) as BrowserState;
      setState(data);
    } catch (e) {
      setState((s) => ({
        ...s,
        error: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setBusy(false);
    }
  }, [urlInput]);

  const goBack = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(`${BRIDGE_HTTP}/api/browser/back`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as BrowserState;
        setState(data);
        if (data.url) setUrlInput(data.url);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (state.url) {
      setUrlInput(state.url);
      setBusy(true);
      try {
        const res = await fetch(`${BRIDGE_HTTP}/api/browser/navigate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: state.url }),
        });
        if (res.ok) {
          const data = (await res.json()) as BrowserState;
          setState(data);
        }
      } finally {
        setBusy(false);
      }
    } else {
      void fetchState();
    }
  }, [state.url, fetchState]);

  return (
    <div className="agent-browser-panel" style={{ display: "flex", flexDirection: "column", height: "100%", gap: 8, padding: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void navigate();
          }}
          placeholder="https://…"
          style={{
            flex: 1,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--glass-border)",
            background: "var(--bg-input)",
          }}
        />
        <button type="button" disabled={busy} onClick={() => void navigate()}>
          Go
        </button>
        <button type="button" disabled={busy} onClick={() => void goBack()}>
          Back
        </button>
        <button type="button" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      {state.title ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {state.title}
        </div>
      ) : null}

      {state.error ? (
        <div style={{ color: "var(--red)", fontSize: 12 }}>{state.error}</div>
      ) : null}

      <div style={{ flex: 1, overflow: "auto", background: "var(--bg-editor)", borderRadius: 8 }}>
        {state.screenshotBase64 ? (
          <img
            src={`data:image/png;base64,${state.screenshotBase64}`}
            alt={state.title || "Browser preview"}
            style={{ width: "100%", display: "block" }}
          />
        ) : (
          <div style={{ padding: 24, color: "var(--text-dim)", textAlign: "center" }}>
            {active
              ? "还没有预览 — 输入本地地址（如 http://127.0.0.1:5173）点 Go，或让 Agent 用 browser 工具打开"
              : "Browser inactive"}
          </div>
        )}
      </div>
    </div>
  );
}
