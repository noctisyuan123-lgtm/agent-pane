import { useEffect, useState } from "react";
import { EmbeddedTerminal } from "./EmbeddedTerminal";
import { openIterm } from "./api";
import { IconTerminal } from "./icons";

function newTermId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

type TermTab = { id: string; title: string };

export type TerminalPanelProps = {
  cwd: string;
  active: boolean;
};

export function TerminalPanel({ cwd, active }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TermTab[]>(() => [
    { id: newTermId(), title: "zsh" },
  ]);
  const [activeId, setActiveId] = useState(() => tabs[0]!.id);
  const [termBusy, setTermBusy] = useState(false);
  const [termMsg, setTermMsg] = useState<string | null>(null);

  useEffect(() => {
    const id = newTermId();
    setTabs([{ id, title: "zsh" }]);
    setActiveId(id);
  }, [cwd]);

  const addTab = () => {
    const id = newTermId();
    setTabs((prev) => [...prev, { id, title: "zsh" }]);
    setActiveId(id);
  };

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        setActiveId("");
        return [];
      }
      setActiveId((cur) =>
        cur === id ? next[next.length - 1]!.id : cur
      );
      return next;
    });
  };

  return (
    <div className="right-rail-panel terminal-panel">
      <div className="term-tabbar">
        <div className="term-tabs" role="tablist">
          {tabs.map((t) => (
            <div
              key={t.id}
              role="tab"
              aria-selected={t.id === activeId}
              tabIndex={0}
              className={`term-tab ${t.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setActiveId(t.id);
                }
              }}
            >
              <IconTerminal size={12} className="term-tab-ico" />
              <span className="term-tab-label">{t.title}</span>
              <button
                type="button"
                className="term-tab-close"
                title="Close"
                aria-label="Close terminal"
                onMouseDown={(e) => {
                  // beat tab onClick / focus steal
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="term-tab-add"
            title="New terminal"
            onClick={addTab}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="term-ext"
          disabled={termBusy}
          title="Open in iTerm2"
          onClick={() => {
            setTermBusy(true);
            setTermMsg(null);
            void openIterm(cwd)
              .then(() => setTermMsg(null))
              .catch((e) =>
                setTermMsg(e instanceof Error ? e.message : String(e))
              )
              .finally(() => setTermBusy(false));
          }}
        >
          ↗
        </button>
      </div>
      {termMsg && <div className="right-rail-hint err">{termMsg}</div>}
      <div className="embedded-terminal-wrap">
        {tabs.length === 0 ? (
          <div className="right-rail-empty term-empty">
            终端已关闭
            <button type="button" className="term-empty-new" onClick={addTab}>
              + New Terminal
            </button>
          </div>
        ) : (
          tabs.map((t) => {
            const shown = t.id === activeId;
            return (
              <div
                key={t.id}
                className={`embedded-terminal-slot ${shown ? "active" : ""}`}
                aria-hidden={!shown}
              >
                <EmbeddedTerminal
                  cwd={cwd}
                  termId={t.id}
                  active={active && shown}
                  killOnUnmount
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
