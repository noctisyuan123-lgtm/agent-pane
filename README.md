# Agent Pane

A full-window agent UI (inspired by Cursor’s Agent layout) backed by a local **Grok ACP** bridge.

```
React UI  ──WS──►  Bridge  ──Domain Event Store──► UI
                     │
                     ├─ GrokAcpAdapter (stdio)
                     ├─ Workspace Snapshot
                     └─ Diff Engine (git/fs)
```

## Requirements

- Node.js 20+
- Grok CLI installed and signed in (`~/.grok/bin/grok`)
- Prefer working inside a **git repository** (Diff / Reject work best there)

## Desktop (recommended)

Build macOS arm64 bundles with:

```bash
cd ~/agent-pane
npm install
npm run desktop:build
```

Outputs:

```text
apps/desktop/src-tauri/target/release/bundle/macos/Agent Pane.app
apps/desktop/src-tauri/target/release/bundle/dmg/Agent Pane_0.1.0_aarch64.dmg
```

Double-click the `.app` to launch. It starts the local Bridge on `127.0.0.1:8787`.  
You still need **Node** on `PATH` and the **Grok CLI** under `~/.grok/bin`.

If `cargo` fails to fetch crates, set a working proxy first, for example:

```bash
export http_proxy=http://127.0.0.1:7892 https_proxy=http://127.0.0.1:7892
npm run desktop:build
```

Dev mode (hot-reload UI):

```bash
npm run desktop:dev
```

## Web development

```bash
cd ~/agent-pane
npm install
npm run build -w @agent-pane/shared

# Terminal 1
npm run dev:bridge

# Terminal 2
npm run dev:web
```

Open http://127.0.0.1:5173

1. Pick a project folder (Open… / header **Choose** / Recent projects)
2. Type a task in the composer and hit **Start** (creates a session and sends)
3. Or click **New Agent**, then chat

> **Relation to Grok Build:** Agent Pane talks to `grok agent stdio` (ACP). It does **not** depend on a TUI “Agent mode” menu entry. As long as `~/.grok/bin/grok` can authenticate and run the agent, you are good.

## Features

- Streaming chat with tool timeline, thoughts, and task lists
- Session history, resume, and workspace-bound projects
- Git/FS diff review (Accept / Reject) via workspace snapshots
- Hardened tool shells (`bash --noprofile --norc -s`) with healthy PATH
- Embedded terminal and agent browser panels (desktop)
- Glass dark UI with translucent tables, code blocks, and composer

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROK_BIN` | `~/.grok/bin/grok` | Path to the Grok CLI |
| `AGENT_PANE_PORT` | `8787` | Bridge HTTP/WS port |
| `AGENT_PANE_PERMISSION` | `auto` | `auto` passes `--always-approve` to grok |
| `VITE_BRIDGE_WS` | `ws://127.0.0.1:8787` | Frontend WebSocket URL |

## Data directories

- Event store: `~/.agent-pane/sessions/<id>/events.jsonl`
- Snapshots: `~/.agent-pane/snapshots/<id>/`

## Specs & docs

- [Design spec](docs/superpowers/specs/2026-07-09-agent-pane-design.md)
- [Embedded terminal & agent browser](docs/superpowers/specs/2026-07-11-embedded-terminal-agent-browser-design.md)
- [ACP resume research](docs/research/acp-resume-patterns.md)
- [Open-source UI references](docs/open-source-agent-ui-refs.md)

## License

See the repository for license details if published.
