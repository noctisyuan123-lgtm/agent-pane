# Embedded Terminal + Agent Browser

**Date:** 2026-07-11  
**Status:** Approved direction (awaiting spec review)  
**Scope:** Right-rail **Terminal** (in-window PTY) and **Browser** (Playwright-backed agent browser + live preview)

## Context

Agent Pane’s right rail already has Changes / Browser / Terminal / Files. Changes and Files work. Terminal currently launches external iTerm2; Browser is copy-only. User wants Cursor-like **in-window** terminal and a real **agent browser** (not “open Google”, not iframe-only).

## Goals

1. **Terminal:** Interactive shell inside the Terminal panel (`xterm` + PTY), cwd = active workspace.
2. **Browser:** One Chromium session shared by (a) Grok MCP tools and (b) the Browser panel preview.
3. Keep iTerm / system-browser as optional “open outside” actions.

## Non-goals (this version)

- Design Mode / click-to-edit styles
- Multi-tab browser or multi-PTY tabs
- Merging user PTY with ACP agent `terminal/*` tool sessions
- Full Cursor Browser parity (network panel, device emulation, etc.)

---

## 1. Embedded Terminal

### Approach

Bridge owns a **node-pty** session; web UI uses **@xterm/xterm** + fit addon over a dedicated WebSocket.

### Protocol

- Upgrade path: `WS /terminal` (same host/port as bridge `8787`, separate from session command WS).
- Client → server: `{ type: "attach", cwd }`, `{ type: "input", data }`, `{ type: "resize", cols, rows }`, `{ type: "detach" }`
- Server → client: `{ type: "ready" }`, `{ type: "data", data }`, `{ type: "exit", code }`, `{ type: "error", message }`

### Lifecycle

- Opening Terminal tab (with a workspace cwd) attaches or creates PTY.
- Shell: `process.env.SHELL` or `/bin/zsh` on macOS; `cwd` = session workspace.
- Closing the panel **does not** kill the PTY (reconnect on reopen). Changing workspace cwd kills and recreates.
- Optional button: “Open in iTerm2” keeps existing `POST /api/terminal/iterm`.

### UI

- Full-height xterm in right-rail body when Terminal tab is active.
- Dark theme aligned with existing tokens; fit on panel resize.

### Files (expected)

| Area | Path |
|------|------|
| Bridge PTY | `apps/bridge/src/terminal-pty.ts` (new) |
| Bridge WS wire | `apps/bridge/src/index.ts` |
| Deps | `apps/bridge`: `node-pty`; `apps/web`: `@xterm/xterm`, `@xterm/addon-fit` |
| UI | `apps/web/src/EmbeddedTerminal.tsx` (new), wired from `App.tsx` |

---

## 2. Agent Browser

### Approach (chosen)

**Bridge-owned Playwright Chromium** + thin **stdio MCP server** registered on `session/new` via `mcpServers` (today hard-coded `[]` in `grok-acp-adapter.ts`). Same browser session powers the right-rail preview.

Rejected for v1: iframe-only preview; nested Tauri webview; wiring third-party Playwright MCP without a shared preview surface.

### Browser session (bridge)

Singleton (or per-app) `BrowserSession`:

- Launch Chromium (headless or headed-offscreen; prefer headless + screenshots for packaging simplicity).
- State: current URL, last screenshot (PNG base64 or file under `~/.agent-pane/browser/`), last a11y snapshot text.
- Methods: `navigate(url)`, `back()`, `snapshot()`, `screenshot()`, `click(ref|selector)`, `type(ref|selector, text)`, `close()`.

### MCP tools (agent-facing)

Expose roughly:

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to URL |
| `browser_snapshot` | Accessibility / element refs for clicking |
| `browser_click` | Click by ref from snapshot |
| `browser_type` | Type into element |
| `browser_screenshot` | Capture viewport (also refreshes UI) |
| `browser_back` | History back |

MCP process can be in-process stdio bridge or a small Node entry (`apps/bridge/src/browser-mcp.ts`) that talks to the same `BrowserSession` over localhost HTTP. Prefer **HTTP control plane on bridge** + MCP wrapper so the UI and MCP share one implementation:

- `GET /api/browser/state` → `{ url, title, screenshotBase64?, updatedAt }`
- `POST /api/browser/navigate` `{ url }`
- `POST /api/browser/back`
- `POST /api/browser/screenshot`
- (click/type/snapshot primarily via MCP; optional HTTP mirrors for debugging)

### Wiring into Grok

On `session/new`, pass `mcpServers` entry pointing at the Agent Pane browser MCP (command + args + env with bridge URL). Adapter today:

```ts
{ cwd: opts.cwd, mcpServers: [] }
```

Replace `[]` with the configured server when browser MCP is available.

### UI (Browser panel)

- URL bar + Go / Refresh / Back / “Open in system browser”
- Preview: latest screenshot (`<img>`), polled or pushed when state changes
- When any browser tool runs (or navigate from UI), optionally auto-select Browser tab and refresh preview
- Empty state: hint to navigate or ask the agent to open a local URL (default suggestion `http://127.0.0.1:5173`)

### Notifications (optional stretch)

- WS notice or domain event `BrowserUpdated` so UI doesn’t only poll — nice-to-have; polling every 1s while tab visible is enough for v1.

### Packaging notes

- Playwright browsers must be installable for desktop builds (`npx playwright install chromium` documented; consider bundling or first-run install).
- If Chromium missing, Browser panel shows clear error + install hint; agent tools fail with same message.

### Files (expected)

| Area | Path |
|------|------|
| Session | `apps/bridge/src/browser-session.ts` |
| HTTP API | `apps/bridge/src/http-api.ts` (+ maybe `browser-api.ts`) |
| MCP entry | `apps/bridge/src/browser-mcp.ts` |
| Adapter | `apps/bridge/src/grok-acp-adapter.ts` (`mcpServers`) |
| Deps | `playwright` (or `playwright-core` + browser path) |
| UI | `apps/web/src/AgentBrowserPanel.tsx`, `api.ts` helpers |
| Styles | `apps/web/src/styles.css` |

---

## 3. Security / sandbox

- Browser navigate: allow `http(s):` only; block `file:` unless under workspace (v1: http(s) only).
- PTY: no extra sandbox beyond user’s own shell (same trust model as iTerm).
- MCP and HTTP bound to `127.0.0.1` only (existing bridge bind).

---

## 4. Success criteria

- [ ] Terminal tab shows a working interactive shell in-app at workspace cwd; resize works.
- [ ] Agent can navigate + snapshot/click via MCP in a live session.
- [ ] Browser panel shows URL + screenshot of the **same** page the agent is driving.
- [ ] Manual URL bar navigate updates the same session.
- [ ] Desktop rebuild installs and runs without requiring external iTerm for basic terminal use.

## 5. Implementation order

1. Terminal PTY + xterm (user-visible immediately)
2. BrowserSession + HTTP state/navigate/screenshot
3. Browser panel UI
4. MCP server + `mcpServers` wiring
5. Desktop bundle / Playwright install path + smoke test

---

## Spec self-review

- No unresolved placeholders for core behavior.
- Terminal and Browser are coupled only at UI shell (right rail); backends independent — can ship Terminal first if Browser Chromium install blocks.
- Scope explicitly excludes Design Mode and multi-tab.
- Risk: Playwright binary size / first-run install on desktop — called out under packaging.
