import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectEntry } from "./api";
import {
  IconCheck,
  IconFolder,
  IconFolders,
  IconMonitor,
} from "./icons";

function displayPath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (m) {
    const rest = m[1] || "";
    return rest ? `~${rest}` : "~";
  }
  return p;
}

export type WorkspacePickerProps = {
  open: boolean;
  cwd: string;
  recent: ProjectEntry[];
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (path: string) => void;
  onOpenFolder: () => void;
  onSoon: (label: string) => void;
};

export function WorkspacePicker({
  open,
  cwd,
  recent,
  anchorRef,
  onClose,
  onSelect,
  onOpenFolder,
  onSoon,
}: WorkspacePickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, anchorRef]);

  const rows = useMemo(() => {
    const list = recent.filter((r) => r.path?.trim());
    const paths = new Set(list.map((r) => r.path));
    const base: ProjectEntry[] =
      cwd && !paths.has(cwd)
        ? [
            {
              path: cwd,
              name: cwd.split("/").filter(Boolean).pop() || cwd,
            },
            ...list,
          ]
        : list;
    const q = query.trim().toLowerCase();
    if (!q) return base.slice(0, 14);
    return base
      .filter(
        (r) =>
          r.path.toLowerCase().includes(q) ||
          (r.name || "").toLowerCase().includes(q) ||
          displayPath(r.path).toLowerCase().includes(q)
      )
      .slice(0, 14);
  }, [recent, cwd, query]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      className="ws-picker"
      role="dialog"
      aria-label="Open project"
    >
      <div className="ws-picker-search">
        <input
          ref={searchRef}
          className="ws-picker-search-input"
          type="text"
          value={query}
          placeholder="Open project anywhere…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && rows[0]) {
              e.preventDefault();
              onSelect(rows[0].path);
            }
          }}
        />
      </div>

      <div className="ws-picker-section">
        <div className="ws-picker-section-label">Recents</div>
        {rows.length === 0 ? (
          <div className="ws-picker-empty">
            {query.trim() ? "No matches" : "No recent folders"}
          </div>
        ) : (
          rows.map((r) => {
            const active = r.path === cwd;
            return (
              <button
                key={r.path}
                type="button"
                className={`ws-picker-row ${active ? "active" : ""}`}
                onClick={() => onSelect(r.path)}
                title={r.path}
              >
                <IconFolder size={15} className="ws-picker-ico" />
                <span className="ws-picker-row-text">
                  <span className="ws-picker-name">
                    {r.name || displayPath(r.path)}
                  </span>
                  <span className="ws-picker-path">{displayPath(r.path)}</span>
                </span>
                {active && <IconCheck size={14} className="ws-picker-check" />}
              </button>
            );
          })
        )}
      </div>

      <div className="ws-picker-footer">
        <button
          type="button"
          className="ws-picker-action"
          onClick={onOpenFolder}
        >
          <IconFolder size={15} />
          <span>Open Folder</span>
        </button>
        <button
          type="button"
          className="ws-picker-action"
          onClick={() => onSoon("Set Up Workspace")}
        >
          <IconFolders size={15} />
          <span>Set Up Workspace</span>
        </button>
        <button
          type="button"
          className="ws-picker-action"
          onClick={() => onSoon("Connect SSH")}
        >
          <IconMonitor size={15} />
          <span>Connect SSH</span>
        </button>
      </div>
    </div>
  );
}
