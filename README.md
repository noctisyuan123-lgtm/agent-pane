# Agent Pane

A full-window agent UI (inspired by Cursor’s Agent layout) backed by a local **Grok ACP** bridge.

```
React UI  ──WS──►  Bridge  ──Domain Event Store──► UI
                     │
                     ├─ GrokAcpAdapter (stdio | serve)
                     ├─ Workspace Snapshot
                     └─ Diff Engine (git/fs)
```

## Requirements

- Node.js 20+
- Grok CLI installed and signed in (`~/.grok/bin/grok`)
- Prefer working inside a **git repository** (Diff / Reject work best there)

### Grok CLI pin

| Item | Value |
|------|--------|
| **Tested** | Grok CLI **0.2.101** (`~/.grok/version.json`) |
| **Default binary** | `GROK_BIN` env, else `~/.grok/bin/grok` |
| **Transport** | ACP JSON-RPC via `stdio` or `serve` (see [Provider](#provider-stdio-vs-serve)). **Desktop app defaults to `serve`**; `npm run dev:bridge` defaults to `stdio` unless `AGENT_PANE_PROVIDER` is set. |

Upgrade Grok in a dedicated PR; smoke resume + prompt + permission after bumps. See [`docs/architecture-agent-core-multi-front.md`](docs/architecture-agent-core-multi-front.md) §7.

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

Double-click the `.app` to launch. It starts the local Bridge on `127.0.0.1:8787` with **`AGENT_PANE_PROVIDER=serve`** (shared `grok agent serve` on `127.0.0.1:2419` after the first agent session).  
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

> **Relation to Grok Build:** Agent Pane talks to Grok over **ACP** (`grok agent … stdio` or `grok agent serve`). It does **not** depend on a TUI “Agent mode” menu entry. As long as `~/.grok/bin/grok` can authenticate and run the agent, you are good.

## Features

- Streaming chat with tool timeline, thoughts, and task lists
- Session history, resume, and workspace-bound projects
- Git/FS diff review (Accept / Reject) via workspace snapshots
- Hardened tool shells (`bash --noprofile --norc -s`) with healthy PATH
- Embedded terminal and agent browser panels (desktop)
- Glass dark UI with translucent tables, code blocks, and composer

## Provider: stdio vs serve

| Mode | When | Behavior |
|------|------|----------|
| **stdio** | `AGENT_PANE_PROVIDER=stdio` or unset in **dev bridge** | Each live session spawns its own `grok agent … stdio` child |
| **serve** | Desktop default; or `AGENT_PANE_PROVIDER=serve` | One `grok agent serve` daemon; Bridge holds a **shared** WebSocket and demuxes by ACP `sessionId` (multi-WS clients starve peers on Grok 0.2.101) |

```bash
# Dev bridge on serve (matches desktop)
AGENT_PANE_PROVIDER=serve npm run dev:bridge

# Or manage daemon yourself:
# grok agent serve --bind 127.0.0.1:2419 --secret "$AGENT_PANE_SERVE_SECRET"
AGENT_PANE_PROVIDER=serve AGENT_PANE_SERVE_MANAGE=external \
  AGENT_PANE_SERVE_SECRET=… npm run dev:bridge
```

Tagged snapshots: `v0.1.0-pre-serve` (stdio-era baseline) · `v0.1.1-serve` (this Wave 4).  
Full plan: [`docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md`](docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md)

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROK_BIN` | `~/.grok/bin/grok` | Path to the Grok CLI |
| `AGENT_PANE_PORT` | `8787` | Bridge HTTP/WS port |
| `AGENT_PANE_PERMISSION` | `auto` | `auto` passes `--always-approve` to grok (stdio) / client auto-approve (serve) |
| `AGENT_PANE_PROVIDER` | `stdio` (dev bridge); **desktop forces `serve` unless env already set** | `stdio` \| `serve` \| `daemon` |
| `AGENT_PANE_SERVE_BIND` | `127.0.0.1:2419` | Serve listen address (loopback only unless `AGENT_PANE_SERVE_ALLOW_LAN=1`) |
| `AGENT_PANE_SERVE_SECRET` | auto-generated | Shared with `GROK_AGENT_SECRET`; required to adopt external daemon |
| `AGENT_PANE_SERVE_MANAGE` | `auto` | `auto` spawn/adopt · `external` connect-only · `off` |
| `AGENT_PANE_SERVE_FALLBACK_STDIO` | `0` | If `1`, serve setup failure falls back to stdio |
| `VITE_BRIDGE_WS` | `ws://127.0.0.1:8787` | Frontend WebSocket URL |

## Data directories

- Event store: `~/.agent-pane/sessions/<id>/events.jsonl`
- Snapshots: `~/.agent-pane/snapshots/<id>/`

## Specs & docs

- [Design spec](docs/superpowers/specs/2026-07-09-agent-pane-design.md)
- [Wave 4 serve plan](docs/superpowers/specs/2026-07-16-wave4-grok-agent-serve.md)
- [Phase 0 session id + provider](docs/superpowers/specs/2026-07-16-phase0-session-id-provider.md)
- [Embedded terminal & agent browser](docs/superpowers/specs/2026-07-11-embedded-terminal-agent-browser-design.md)
- [ACP resume research](docs/research/acp-resume-patterns.md)
- [Open-source UI references](docs/open-source-agent-ui-refs.md)

## License

See the repository for license details if published.
