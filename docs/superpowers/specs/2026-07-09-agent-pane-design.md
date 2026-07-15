# Agent Pane — Design Spec

**Date:** 2026-07-09  
**Status:** Draft for review (rev 2 — architecture hardening)  
**Owner:** Noctis  
**Codename:** `agent-pane`  
**Repo:** `~/projects/agent-pane`

**Rev 2 notes:** Incorporates four architecture must-fix from external review (Event Store · Domain Event · Git/FS Diff · Workspace Snapshot), plus clean layering for Adapter / Task Model / Diff Engine. Product shape and delivery cadence are unchanged.

---

## 1. Problem

The user does not have Cursor Pro, the Claude account is unavailable, and day-to-day work runs on Grok CLI. The CLI can get work done, but it lacks the readability and interaction rhythm of Cursor Agent's **full-window** experience: tool timeline, To-dos, proposed diffs with Accept/Reject, `@` / `/`, and a large conversation surface.

A sidebar chat extension is **out of scope** — that would be no better than opening an agent inside the IDE. This product aims for the UI experience of **a full Agent window**. Grok is the first-ship brain; the architecture is designed for **swappable Providers**, but multi-backend is not implemented in v1.

---

## 2. Goals & Non-Goals

### Goals

1. **Full-window Agent UI**, visually and in information architecture aligned with the Cursor Agent panel (screenshots as the baseline), dark-first.
2. **First-ship brain = Grok**, connected via a **Grok ACP Adapter** (`grok agent stdio` / `serve`), reusing the local harness / tools / MCP / skills / rules.
3. **Web-first** → iterate the UI → **Tauri packaging** (same route as Nib); do not grow a Code-OSS fork first.
4. **Mini-to-full Agent experience (phased):** streaming messages, tool timeline, tasks, diff review, permissions, session history, workspace binding.
5. Code display via **Monaco**; **Diff source of truth = Git / filesystem**, not locked to any Provider's diff events.
6. Inside the Bridge: **Domain Event + Event Store** — React only subscribes to events and is never the source of truth; supports replay, debugging, crash recovery, and export.

### Non-Goals (v1)

- No Cursor/VS Code **sidebar extension** as the primary form.
- No full Code-OSS fork / own IDE distribution (optional later; out of scope for this spec).
- Do not reimplement Grok's tool execution engine (no second agent runtime).
- **Do not implement** Claude / Codex / Gemini adapter bodies (keep only the Adapter interface and Domain Events to avoid fake abstraction depth).
- No multi-tenant / cloud SaaS.

---

## 3. Product Shape

### 3.1 Primary surface

**Standalone full-window app** (browser for dev / desktop for prod):

```
┌─────────────────────────────────────────────────────────────┐
│  Top bar: session title · workspace path · history · settings · window controls │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   Main area: conversation stream + tool fold rows + To-dos + Diff cards │
│   (large surface, not a 320px sidebar)                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Bottom composer:                                           │
│  [Agent ▾] [Auto/permission ▾] [model ▾]  ·  input  ·  send │
│  Placeholder: Plan, @ for context, / for commands           │
└─────────────────────────────────────────────────────────────┘
```

Optional: right-side or floating **file tree / session list** (must not dominate the main visual; collapsible).

### 3.2 Delivery phases

| Phase | Form | Notes |
|-------|------|-------|
| **P0 Web** | Vite + React local page | `localhost`; Bridge + Event Store + Grok Adapter skeleton |
| **P1 Daily use** | Same | Tool timeline, Git Diff + Snapshot Accept/Reject, permissions, history replay usable |
| **P2 Package** | Tauri 2 shell | System window, sidecar Bridge; Nib-class desktop experience |
| **P3+** | Optional deepen | Second Provider, MCP management UI, parallel sessions, full Timeline replay UX |

---

## 4. Architecture

### 4.0 Hard requirements (rev 2)

The following four items are constraints that **must land in the code structure from M0**, not "refactor later":

| # | Constraint | Reason |
|---|------------|--------|
| 1 | **Event Store** | Every Domain Event is appended first, then broadcast → replay / debug / resume / export |
| 2 | **Provider-agnostic Domain Event** | Frontend and Bridge core do not know ACP field names |
| 3 | **Diff from Git/FS + Diff Engine** | Any agent that mutates disk can be reviewed; do not depend on whether the Provider emits diff events |
| 4 | **Workspace Snapshot** | Accept/Reject must not depend on the Provider's discard API |

Secondary but recommended to draw boundaries in the same pass (implementations may stay thin):

| # | Constraint | Notes |
|---|------------|-------|
| 5 | **Unified Tool state machine** | `ToolStarted` / `ToolProgress` / `ToolFinished` / `ToolFailed` |
| 6 | **Task Model** | TodoPanel consumes Tasks; does not bind directly to Plan |
| 7 | **Provider Adapter layer** | Bridge core does not parse raw ACP frames |
| 8 | **Diff Engine as a standalone module** | DiffCard only renders `DiffModel` |

### 4.1 Layered diagram

```
┌─────────────────────────────────────────┐
│  Agent Pane UI (React + Monaco)         │
│  · emits Commands only · subscribes to Domain Events only │
└──────────────────▲──────────────────────┘
                   │ WebSocket (commands + events)
┌──────────────────┴──────────────────────┐
│  Bridge (Node, 127.0.0.1 only)          │
│                                         │
│  ┌─────────────┐   ┌─────────────────┐  │
│  │  Commands   │   │  Event Store    │  │
│  │  handler    │   │  append-only    │──┼──► WS broadcast / replay
│  └──────┬──────┘   └────────▲────────┘  │
│         │                   │           │
│  ┌──────▼───────────────────┴────────┐  │
│  │  Domain services                  │  │
│  │  Session · Task · Permission      │  │
│  │  DiffEngine · WorkspaceSnapshot   │  │
│  └──────▲────────────────────────────┘  │
│         │ Domain Event / intents        │
│  ┌──────┴────────────────────────────┐  │
│  │  Provider Adapter (interface)     │  │
│  │  └─ GrokAcpAdapter (v1 only)      │  │
│  └──────▲────────────────────────────┘  │
└─────────┼───────────────────────────────┘
          │ transport-specific (stdio JSON-RPC / WS)
┌─────────┴───────────────────────────────┐
│  grok agent stdio | serve               │
│  tools / MCP / fs (agent runtime)       │
└─────────────────────────────────────────┘
```

**React is never the event source.** The UI emits **Commands** (`session.prompt`, `diff.accept`, …); all state changes leave the Event Store as **Domain Events**.

### 4.2 Why a Bridge

The browser cannot spawn `grok agent stdio`. The Bridge is responsible for:

1. Hosting the Provider process/connection (v1: Grok ACP).
2. The Adapter **normalizes** Provider traffic **into Domain Events** → **Event Store.append** → broadcast.
3. Workspace, model, and permission-mode configuration.
4. **Workspace Snapshot** + **Diff Engine** (Git/FS).
5. Session index, and replay / export against the store.

In the Tauri phase: the Bridge may run as a sidecar; the **Domain Event and Command protocols stay the same**.

### 4.3 Domain Event Model (Provider-agnostic)

Authoritative definitions live in `packages/domain-events` (or `shared/events`). Naming uses stable verb forms:

```ts
// Session
type DomainEvent =
  | { type: "SessionStarted"; sessionId: string; cwd: string; model?: string; at: string }
  | { type: "SessionEnded"; sessionId: string; stopReason: string; at: string }
  | { type: "SessionError"; sessionId: string; message: string; at: string }

  // Messages
  | { type: "UserMessageAppended"; sessionId: string; text: string; attachments?: ContextRef[]; at: string }
  | { type: "MessageChunk"; sessionId: string; role: "assistant"; text: string; at: string }
  | { type: "ThoughtChunk"; sessionId: string; text: string; at: string }
  | { type: "MessageDone"; sessionId: string; role: "assistant"; at: string }

  // Tools (unified state machine; Timeline only recognizes this set)
  | { type: "ToolStarted"; sessionId: string; toolId: string; title: string; kind: string; inputSummary?: string; at: string }
  | { type: "ToolProgress"; sessionId: string; toolId: string; detail?: string; at: string }
  | { type: "ToolFinished"; sessionId: string; toolId: string; outputSummary?: string; at: string }
  | { type: "ToolFailed"; sessionId: string; toolId: string; error: string; at: string }

  // Tasks (TodoPanel only recognizes Task; sources may be plan / workflow / …)
  | { type: "TaskUpserted"; sessionId: string; task: Task; at: string }
  | { type: "TaskRemoved"; sessionId: string; taskId: string; at: string }
  | { type: "TasksReplaced"; sessionId: string; tasks: Task[]; at: string }

  // Permissions
  | { type: "PermissionRequested"; sessionId: string; requestId: string; tool: string; summary: string; at: string }
  | { type: "PermissionResolved"; sessionId: string; requestId: string; allow: boolean; at: string }

  // Diff (produced by Diff Engine, not emitted directly by the Adapter)
  | { type: "DiffProposed"; sessionId: string; files: DiffFileMeta[]; at: string }
  | { type: "DiffResolved"; sessionId: string; filePath: string | "*"; action: "accept" | "reject"; at: string }

  // Snapshots
  | { type: "SnapshotTaken"; sessionId: string; snapshotId: string; at: string }
  | { type: "SnapshotRestored"; sessionId: string; snapshotId: string; at: string };
```

`Task` shape (decoupled from source):

```ts
type Task = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  source?: "plan" | "workflow" | "checklist" | "other";
};
```

**Rules:**

- The Adapter **only** turns Provider frames into Domain Events (or Domain intents).
- Diff / Snapshot **must not** speak to the UI directly from the Adapter.
- The frontend **must not** use `if (provider === 'grok')`; must not depend on ACP field names.

### 4.4 Event Store

One append-only log per `sessionId`:

```
~/.agent-pane/sessions/<sessionId>/events.jsonl
# or in-project .agent-pane/ for development; implementation plan picks the default
```

Behavior:

1. Any Domain Event → `store.append(event)` (persist + in-memory ring).
2. Then `broadcast(event)` to connected WS clients.
3. Client reconnect / new page: `events.subscribe({ fromSeq })` or `events.replay(sessionId)`.
4. Export Conversation = filter/render the store.
5. Debug panel (P1+) = inspect the jsonl as-is.

**Ordering:** globally monotonic `seq` (per-session). Events carry `at` as ISO time.

M0 may use a single jsonl file; do not introduce a heavy DB.

### 4.5 Provider Adapter interface

```ts
interface AgentProvider {
  readonly id: string; // "grok-acp"
  start(opts: { cwd: string; model?: string; permissionMode?: string }): Promise<void>;
  stop(): Promise<void>;
  sendPrompt(input: { sessionId: string; text: string; attachments?: ContextRef[] }): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondPermission(requestId: string; allow: boolean): Promise<void>;
  // Adapter → Bridge: callback Domain Events only (or convert raw frames inside the adapter before callback)
  onEvent(handler: (e: DomainEvent) => void): void;
}
```

**v1 sole implementation: `GrokAcpAdapter`**

- Transport: `grok agent stdio` (primary) / `serve` (backup)
- Docs: `~/.grok/docs/user-guide/15-agent-mode.md`
- Internal mapping examples (not exposed to the frontend):

| ACP / Grok | Domain Event |
|------------|--------------|
| `agent_message_chunk` | `MessageChunk` |
| `agent_thought_chunk` | `ThoughtChunk` |
| `tool_call` | `ToolStarted` |
| `tool_call_update` (running) | `ToolProgress` |
| `tool_call_update` (completed) | `ToolFinished` |
| `tool_call_update` (failed) | `ToolFailed` |
| `plan` | `TasksReplaced` / `TaskUpserted` (`source: "plan"`) |
| permission request | `PermissionRequested` |
| end turn | `MessageDone` / `SessionEnded` |

**Explicitly not v1:** building a custom LLM HTTP + hand-rolled tool loop as the primary path.

### 4.6 Commands (UI → Bridge)

```ts
// client → bridge (Command, not Domain Event)
{ type: "session.create"; cwd: string; model?: string }
{ type: "session.prompt"; sessionId: string; text: string; attachments?: ContextRef[] }
{ type: "session.cancel"; sessionId: string }
{ type: "session.replay"; sessionId: string; fromSeq?: number }
{ type: "permission.respond"; requestId: string; allow: boolean }
{ type: "diff.accept"; sessionId: string; filePath: string | "*" }
{ type: "diff.reject"; sessionId: string; filePath: string | "*" }
{ type: "diff.refresh"; sessionId: string }  // force Diff Engine rerun
{ type: "context.search"; cwd: string; query: string } // @ picker may use HTTP
```

When the Bridge handles a Command it may call the Provider, Snapshot, or Diff Engine; **side-effect results still enter the Store as Events**.

### 4.7 Workspace Snapshot

```
Session create / first prompt
        ↓
  SnapshotTaken  (baseline of cwd — see below)
        ↓
  Agent mutates files (any Provider)
        ↓
  Diff Engine → DiffProposed
        ↓
  Accept  → advance baseline (new Snapshot or move head) + DiffResolved(accept)
  Reject  → SnapshotRestored (back to baseline) + DiffResolved(reject)
```

**Implementation strategies (cost ascending; implementation plan locks one default):**

| Strategy | Fit | Notes |
|----------|-----|-------|
| **A. Git stash/worktree baseline** | Already a git repo | Use `git` to record baseline commit/tree; reject = restore paths from baseline |
| **B. Per-file copy-on-write mirror** | Non-git / mixed | At session start, back up files about to change before mutation; or full tree fingerprint under ignore rules + on-demand backup |
| **C. Hybrid (recommended default)** | General | **Prefer Git**; non-git paths fall back to per-file backup under `~/.agent-pane/snapshots/<id>/` |

**Reject must not** depend on "whether ACP supports discard".  
**Accept**, under the "agent already wrote to disk" model, = confirm keep + refresh baseline + clear Diff cards; no second write unless a future buffer mode exists.

Snapshot scope: respect `.gitignore` + optional `.agent-paneignore`; exclude `node_modules` and large binaries.

### 4.8 Diff Engine (standalone module)

```
Filesystem + Git
       ↓
  Diff Engine
       ↓
  DiffModel { files: DiffFile[] }
       ↓
  DomainEvent DiffProposed
       ↓
  DiffCard (render only)
```

- **Source of truth:** workspace diff relative to the **current session baseline snapshot** (git diff baseline…worktree, or file-backup diff).
- **Triggers:** after tools finish, after a turn ends, user `diff.refresh`, debounced fs watch (P1).
- ACP/Grok diff notifications are **hints only** (may trigger refresh), **not** fed directly to DiffCard.
- `DiffFile`: `path`, `status`, `additions`, `deletions`, `patch` or before/after paths (for Monaco).

A standalone module makes it easier to add later: three-way merge, read-only patch import, export `.patch`.

### 4.9 Task Model vs Plan

- Provider plan updates → Adapter maps to `TaskUpserted` / `TasksReplaced` (`source: "plan"`).
- TodoPanel **only** subscribes to Task-related Domain Events.
- Future checklist / workflow can share the same panel without changing the UI contract.

---

## 5. UI Design

### 5.1 Visual baseline

- **Primary reference:** Cursor Agent screenshots (dark, tool rows, diff cards, bottom bar).
- **Optional skin:** Nib Glass (must not block P0).
- Fonts: UI Inter / system-ui; code JetBrains Mono / system mono.
- Layout: single main conversation column; diffs as embedded cards or half-screen Monaco DiffEditor.

### 5.2 Core components

1. **SessionHeader** — title, cwd, connection status, optional seq indicator
2. **MessageList** — projected from `UserMessageAppended` / `MessageChunk` / `MessageDone`
3. **ToolTimeline** — only Tool* four-state; fold rows + expand details
4. **TodoPanel** — only Task* events
5. **DiffCard** — only `DiffModel` / `DiffProposed`; Accept/Reject emit Commands
6. **Composer** — Command: `session.prompt`; `@` / `/`
7. **ModeBar** — permission mode · model (written into session config; not a flood of Domain Events)
8. **SessionSidebar** — history; open with `session.replay`
9. **EventDebugDrawer** (P1, hideable) — inspect Event Store directly

### 5.3 Slash commands (v1 minimal set)

| Command | Behavior |
|---------|----------|
| `/new` | New session + new Snapshot |
| `/clear` | Clear the view (store may still retain) |
| `/model` | Switch model |
| `/cwd` | Switch workspace (new session or reset snapshot) |
| `/export` | Export conversation from Event Store |
| `/help` | List commands |

### 5.4 `@` context

- Fuzzy search files/folders under cwd
- Attached as prompt attachments; Adapter turns them into Provider-recognized content blocks

---

## 6. Diff & file change flow (finalized)

```
SessionStarted
    → SnapshotTaken (baseline)
Agent tools mutate disk
    → Tool* events (from Adapter)
    → Diff Engine refresh
    → DiffProposed
User Accept(file|*)
    → keep disk state
    → advance baseline (new snapshot head)
    → DiffResolved(accept)
User Reject(file|*)
    → restore paths from baseline (Git or file backup)
    → DiffResolved(reject)
    → optional Diff Engine refresh
```

- UI **by default** shows diffs pending review; no silent Keep (Auto-keep is an explicit setting, off by default in v1).
- Keep All / Undo All = `filePath: "*"`.
- Decoupled from "whether the agent already wrote disk": **we assume tools mutate disk**; the review layer is always baseline↔worktree.

---

## 7. Security & permissions

- Bridge binds **127.0.0.1 only**.
- If `grok agent serve` is used, it must use a secret; development defaults to a stdio child process.
- Permissions: `PermissionRequested` → UI → `permission.respond` Command → Adapter → Provider.
- Mode enums align with Grok CLI (`default` / `acceptEdits` / `auto` / `bypassPermissions`, etc., validated against real behavior).
- Do not commit tokens; reuse `~/.grok` login state.
- Snapshot directory permissions match the local user; no cloud upload.

---

## 8. Tech stack

| Layer | Choice |
|-------|--------|
| UI | React 18+ · TypeScript · Vite |
| Styling | Tailwind + CSS variables (dark agent tokens) |
| Editor | Monaco (required for diffs) |
| Bridge | Node 20+ · `ws` · spawn `grok` |
| Domain modules | Event Store · Diff Engine · Snapshot · GrokAcpAdapter |
| Desktop | Tauri 2 (P2) |
| Package manager | pnpm |
| Testing | Vitest: Adapter mapping, Diff Engine, Snapshot restore, Event Store replay |

---

## 9. Repository layout (target)

```
agent-pane/
  docs/superpowers/specs/
  apps/web/                      # React UI (Commands + Domain Events only)
  apps/bridge/                   # HTTP/WS entry · assembles domain
  packages/domain-events/        # event/command types
  packages/event-store/          # append-only jsonl store
  packages/diff-engine/          # git/fs → DiffModel
  packages/workspace-snapshot/   # baseline + restore
  packages/provider-grok-acp/    # GrokAcpAdapter
  packages/provider-api/         # AgentProvider interface
  src-tauri/                     # P2
  README.md
```

P0 may be physically flat, but **directory/module boundaries must follow the table above** (even if the monorepo starts as one package with multiple folders).

---

## 10. Milestone breakdown

### M0 — Skeleton + spine

- Dark full-window shell (top bar + message area + Composer)
- `domain-events` types + `event-store` (jsonl)
- `provider-api` + `GrokAcpAdapter`: spawn + `initialize` → `SessionStarted`
- Bridge: Command entry, Event Store append, WS broadcast
- UI: subscribe to events, show connected / empty session
- **Full chat not required yet** — get the spine working first

### M1 — Chat loop

- `session.prompt` → `UserMessageAppended` + streaming `MessageChunk` / `ThoughtChunk` / `MessageDone`
- cancel, cwd, model
- Reconnect via `session.replay`

### M2 — Agent chrome

- Tool four-state → ToolTimeline
- Plan → Task* → TodoPanel
- PermissionRequested UI
- Minimal `@` / `/` set

### M3 — Diff + Snapshot

- SnapshotTaken at session start
- Diff Engine → DiffProposed + Monaco DiffCard
- Accept / Reject / Keep All (restore from baseline)
- DiffResolved

### M4 — Sessions & polish

- History list, export, errors/reconnect, shortcuts
- Visuals closer to screenshots
- Optional EventDebugDrawer

### M5 — Tauri package

- macOS arm64, sidecar Bridge, window/icon

---

## 11. Success criteria

The user can:

1. Open a full window and bind a project cwd.
2. See Grok read/edit/run-command work **visualized** (tool timeline + message stream).
3. See diffs based on the **real workspace relative to baseline**; Accept/Reject is **stable and predictable**, independent of Grok discard.
4. After refresh or reconnect, **replay** the current session from the Event Store.
5. Work without Cursor Pro / Claude.
6. Feel like "my Agent window," not a web chat room.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Incomplete ACP field docs | Capture and freeze mapping tables inside the Adapter; lock with unit tests |
| Over-abstraction slows first ship | Implement only Grok Adapter; keep the interface thin; no fake Providers |
| Snapshot cost on non-git repos | Hybrid strategy C; gitignore; on-demand backup |
| Diff confused with "unsaved buffers" | v1 assumes write-to-disk; copy says "workspace changes" |
| `grok` path drift | `GROK_BIN`, default `~/.grok/bin/grok` |
| Trademark / look | Own naming and icons; do not copy Cursor assets |
| Scope creep into IDE fork | Lock: standalone window + Domain layer + single Provider implementation |

---

## 13. Open decisions (defaulted)

| Topic | Default | Changeable |
|-------|---------|------------|
| Product name | Agent Pane | User naming |
| Theme | Cursor-like dark | Nib Glass later |
| Transport | stdio primary | serve as backup |
| Snapshot strategy | Hybrid C (git first) | May force A or B |
| Event Store path | `~/.agent-pane/sessions/` | In-project `.agent-pane/` |
| Auto-approve / auto-keep | Off by default | UI toggle |
| Project path | `~/projects/agent-pane` | — |

---

## 14. External review disposition

| Suggestion | Disposition |
|------------|-------------|
| Event Store | **Adopt · required (M0 spine)** |
| Provider-agnostic Event Model | **Adopt · required** |
| Diff independent of ACP / use Git·FS | **Adopt · required (M3; empty module shell OK at M0)** |
| Workspace Snapshot | **Adopt · required (M3; interfaces OK at M0)** |
| Unified Tool state machine | **Adopt** (folded into Domain Event) |
| Todo via Task Model | **Adopt** (thin model, not locked to plan) |
| Domain / Adapter layering | **Adopt** (v1 only writes the Grok implementation) |
| Diff Engine standalone module | **Adopt** |
| Multi-Provider implementations | **Not adopted for v1** (interface only) |

---

## 15. References

- Cursor Agent UI screenshots (2026-07-09) — visual baseline  
- Cursor.app reverse notes: composer/toolFormer embedded in workbench; **do not fork, surface reference only**  
- Grok ACP: `~/.grok/docs/user-guide/15-agent-mode.md`  
- Grok headless: `14-headless-mode.md`  
- Nib Glass: `~/UI-Templates/Nib-Glass/nib-glass-style-guide.md`  
- CLI: `~/.grok/bin/grok` · `grok agent stdio|serve|leader`  
- External architecture review (2026-07-09) — Event Store / Domain Event / Diff / Snapshot  

---
