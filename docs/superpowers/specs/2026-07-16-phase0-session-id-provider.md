# Phase 0 — Session ID single truth + Provider boundary

**Date:** 2026-07-16  
**Status:** Spec for implementation (chief designer)  
**Parent:** [`docs/architecture-agent-core-multi-front.md`](../../architecture-agent-core-multi-front.md) rev 2  
**Research:** parallel explore agents (session inventory · provider inventory · upstream scan)

---

## 0. Preconditions (reality check)

| Assumption in earlier notes | Reality on this machine (2026-07-16) |
|----------------------------|--------------------------------------|
| “Grok Build open-source Core in tree” | **No Core source found.** Live binary: `~/.grok/bin/grok` **0.2.101** (closed). Docs under `~/.grok/docs/`. |
| Second provider = embed Core | **Unavailable.** Prefer `stdio` today; optional long-lived `grok agent serve` as out-of-process daemon later. |
| `AgentProvider` is future work | **False.** Interface exists: `apps/bridge/src/provider-api.ts`. Sole impl: `GrokAcpAdapter`. Host types live as **concrete** `GrokAcpAdapter`, not the interface. |

Phase 0 does **not** depend on open-source Core. It freezes identity + adapter boundary so later Core moves do not thrash the Host.

---

## 1. Session identity — single truth rules

### 1.1 Canonical IDs

| ID | Name | Owner | On wire to UI | On disk |
|----|------|-------|---------------|---------|
| **A** | Pane `sessionId` (aka `domainSessionId` in adapter) | **Host** | **Yes — only this** | `~/.agent-pane/sessions/<id>/` |
| **B** | `providerSessionId` (ACP `sessionId`) | **Provider** (minted) · Host stores map | **No** (except nested in events for history) | `~/.grok/sessions/<cwd-enc>/<id>/` |
| **C** | cwd-enc path segment | Grok | No | under `~/.grok/sessions/` |
| **D** | `clientRequestId` | UI create correlation | WS only, ephemeral | none |

### 1.2 Mapping table (authoritative)

| Field | Location | Meaning |
|-------|----------|---------|
| `meta.sessionId` | `~/.agent-pane/sessions/<A>/meta.json` | Pane id **A** |
| `meta.providerSessionId` | same | **Last known live** provider handle **B** (ephemeral process handle, not transcript continuity) |
| Event `sessionId` | every DomainEvent | Always **A** |
| `SessionStarted.providerSessionId` / `ContextUsage.providerSessionId` | events | Historical snapshot of **B** at that moment — **not** current map |
| Live map key | `SessionManager.live` | **A** → adapter + current **B** |

**Rule:** Current map = `meta.providerSessionId` + live entry.  
Event-embedded **B** is archaeology only.

### 1.3 Lifecycle (freeze as product law)

| Flow | A (Pane) | B (Provider) | Notes |
|------|----------|--------------|-------|
| New Agent | new UUID | `session/new` | Meta after first user message (draft prune) |
| Open history (no Send) | existing | meta may be stale | No spawn |
| Resume / Send on idle | **same A** | **always new B** (`session/new` + digest) | Old Grok dir orphaned; intentional today |
| Fork | new A | cleared | Events reseq; no Grok link |
| Import Grok | **A := Grok UUID** | initially **B := same** | Collapse until first resume |
| Delete Pane | remove A dir | Grok **not** deleted | Document orphans |
| Rewind | same A; truncate events | best-effort on **current** B | Pane log is transcript SoT |

### 1.4 Required code/doc fixes (implement in order)

| # | Work | Why |
|---|------|-----|
| P0-1 | Add explicit meta field `sourceProviderSessionId?` (or keep import collapse + document that post-resume `providerSessionId` ≠ import source) | Import collapse breaks on resume; need lineage |
| P0-2 | Fix comments that still claim `session/load` resume | Lies cause dual strategies |
| P0-3 | Context usage: resolve **B** via live → meta → never “last ContextUsage alone” | Wrong ring on history-only |
| P0-4 | Web `SessionMeta` type include `providerSessionId?` (read-only) or document intentional omit | Type lag |
| P0-5 | Dual pins: prefer `pins.json` as SoT; localStorage optimistic only | Same id space, two stores |
| P0-6 | Checklist tests (manual or automated) for new / history / resume / import / fork / delete | Arch deliverable |

### 1.5 Non-goals for Phase 0

- Re-enable `session/load` (hang history; separate reliability project).  
- Cascade-delete `~/.grok/sessions`.  
- Reverse index **B → A** (nice-to-have later).

---

## 2. Provider boundary — inventory summary

### 2.1 Interface (exists)

`AgentProvider` methods: `start`, `stop`, `sendPrompt`, `cancel`, `undoLastTurn`, `rewindToUserTurn`, `hydrateUserTurns`, `respondPermission`, `onEvent`.

**Claude-style product methods (special-case watch):**  
`undoLastTurn` / `rewindToUserTurn` / `hydrateUserTurns` — Host can offline-rewind without provider; Grok maps via `_x.ai/rewind/*` with fragile indices.

### 2.2 Host still codes against fat concrete type

`SessionManager` types live adapter as **`GrokAcpAdapter`**, not `AgentProvider`, and calls extra methods:

- `isAlive`, `onDead`, `setContextPrefix`, `publishSignalsUsageOnce`, `fetchBillingUsage`, `hasPendingPermission`

→ Second provider is blocked until interface (or capabilities object) absorbs the real Host contract.

### 2.3 Fold candidates (ordered)

| Priority | Move | From → To |
|----------|------|-----------|
| 1 | Turn index + `hydrateUserTurns` | Adapter → **Host** (from EventStore) |
| 2 | Emit `UserMessageAppended` | Prefer **Host** on accepted prompt |
| 3 | Expand `AgentProvider` + retype LiveSession | Concrete Grok → interface |
| 4 | Extract ACP transport + domain map | Modules reusable by Daemon |
| 5 | Optional `tryRewind` capability | Grok mapping stays special-case |
| 6 | DaemonAcpProvider (`grok agent serve`) | Out-of-process second impl |
| 7 | EmbeddedCoreProvider | **Last resort** (no Core source today) |

### 2.4 Process shape (evidence-based)

| Rank | Shape | Status |
|------|--------|--------|
| 1 | `grok agent … stdio` child | **Current default** |
| 2 | `grok agent serve` localhost daemon | Documented upstream; not wired in Pane yet |
| 3 | In-process embed | No public API / no source |

---

## 3. Upstream pin (draft)

| Item | Value |
|------|--------|
| Tested binary | **0.2.101** (`~/.grok/version.json`) |
| Default path | `GROK_BIN` or `~/.grok/bin/grok` |
| Product pin (todo) | Document in README: “supported / tested on grok 0.2.101” |
| Upgrade | Dedicated PR + resume/prompt/permission smoke + hooks path check |

---

## 4. PR plan (Phase 0 execution)

Do **not** mix glass UI polish into these PRs.

| PR | Title | Scope | Status |
|----|--------|--------|--------|
| **PR-A** | docs: session ID single-truth map | This file + architecture link; comment fixes on `session/load` | **done** (2026-07-16) |
| **PR-B** | fix: providerSessionId resolution for context usage | live → meta → query; UI no longer keys off last ContextUsage event | **done** |
| **PR-C** | feat: sourceProviderSessionId on import meta | Typed field + import write + upsert preserve | **done** |
| **PR-D** | refactor: AgentProvider Host contract | `isAlive`/`onDead`/… on interface; LiveSession uses AgentProvider; `createGrokAcpProvider` factory | **done** |
| **PR-E** | refactor: Host-owned user turns | `hydrateProviderTurns` from EventStore before undo/rewind/resume | **done** |

**Stop line for “large project wave 1”:** PR-A…C — **landed**.  
**Wave 2 (thin Host boundary):** PR-D…E — **landed** (2026-07-16).  
Next: extract ACP transport modules / optional DaemonAcpProvider (`grok agent serve`).

---

## 5. Chief designer decisions (locked for wave 1)

1. **Pane `sessionId` is the only conversation key on the UI wire.**  
2. **`providerSessionId` is an ephemeral Core handle**, rewritten on every resume.  
3. **Do not wait for open-source Core** to fix identity or Provider typing.  
4. **Prefer stdio → then `serve`; never default to embed.**  
5. **Undo/rewind product semantics are Host-owned;** provider assist is best-effort.  

---

## 6. Review notes (Fable5 alignment)

| Review point | Resolution in this spec |
|--------------|-------------------------|
| Provider already exists | §0, §2.1 — “skeleton done; Host still concrete” |
| Session ID first | §1 entire; PR-A…C before D…E |
| Embed vs gate | §2.4 rank 3 last; architecture §4 process priority |
| Upstream pin | §3 |
| undo/rewind special case | §2.1, §2.3 fold #1–2, #5 |

---

## Related paths

- `apps/bridge/src/provider-api.ts`  
- `apps/bridge/src/grok-acp-adapter.ts`  
- `apps/bridge/src/session-manager.ts`  
- `apps/bridge/src/history-index.ts`  
- `apps/bridge/src/grok-session-import.ts`  
- `apps/bridge/src/grok-signals-watcher.ts`  
- `packages/shared/src/index.ts`  
