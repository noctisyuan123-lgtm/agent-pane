# Agent Pane M0–M3 Implementation Plan

> **For agentic workers:** Inline execution in this session. Checkboxes track progress.

**Goal:** Ship a runnable full-window Agent Pane: Web UI + Bridge + Grok ACP, with Event Store, Domain Events, Snapshot + Diff review.

**Architecture:** React UI sends Commands over WS; Bridge appends Domain Events to Event Store and broadcasts; GrokAcpAdapter is the only Provider; Diff from git/FS vs session baseline.

**Tech Stack:** Node 22, npm workspaces, TypeScript, Vite, React, ws, Monaco (diff)

---

## Layout

```
apps/web/          Vite React UI
apps/bridge/       WS server + domain services + grok adapter
packages/shared/   DomainEvent, Command types, helpers
```

## Tasks

- [x] Task 0: Plan + probe ACP
- [x] Task 1: Scaffold monorepo + shared types
- [x] Task 2: Event Store + Bridge WS skeleton
- [x] Task 3: GrokAcpAdapter (init/session/prompt/stream map)
- [x] Task 4: Snapshot + Diff Engine (git-first)
- [x] Task 5: React Agent window UI (chat/tools/todos/diff/composer)
- [x] Task 6: Wire end-to-end + README + demo run (PONG e2e OK)
