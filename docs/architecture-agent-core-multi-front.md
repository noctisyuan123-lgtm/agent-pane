# Agent Core · Multi-Front Architecture

**Date:** 2026-07-16  
**Rev:** 2 — aligned with code reality + external review (Fable5)  
**Status:** Working notes (refactor constitution; keep in sync with `apps/bridge`)  
**Context:** Grok Build open-sourced after the “private data upload” controversy; Agent Pane already has a local Bridge + Grok ACP adapter.

This doc captures how Claude Code / Codex-style desktop stacks are usually shaped, how Agent Pane looks today, and what is worth simplifying (or *not* simplifying) next.

---

## 1. The pattern people mean

```
                 Agent Core
            (session · tools · permissions ·
             hooks · protocol · truth of state)
                       |
         ┌─────────────┼─────────────┐
         │             │             │
        CLI         Desktop         API
     (terminal)   (window / IDE)  (CI · automation)
```

### What “Agent Core” actually owns

| Responsibility | In Core? | Notes |
|----------------|----------|--------|
| Agent loop / turns | Yes | Model I/O, tool routing, stop conditions |
| Tool execution | Yes | Shell, FS, MCP, subagents |
| Permissions / policy | Yes | Allow / deny / ask |
| Hooks lifecycle | Yes | PreToolUse, SessionStart, … |
| Session identity & resume | Yes (or Core + thin store) | One truth, not three |
| Wire protocol | Yes | stdio ACP, HTTP, or **out-of-process** daemon API |
| Window chrome / chat layout | **No** | Frontends only |
| Product history UX, glass UI | **No** | Product shell |

### What each front is

| Front | Job | Must not own |
|-------|-----|----------------|
| **CLI** | TTY UX, flags, scripts, headless scripts | A second agent runtime |
| **Desktop** | Window, vibrancy, drag, notifications, offline UX | Re-implement tools/hooks |
| **API** | CI, bots, remote clients | Divergent session semantics |

**Rule of thumb:** three faces, **one brain**. If Desktop and CLI disagree about “what a session is,” the architecture has already forked.

Claude Code and Codex desktop products are widely described in this shape: the desktop app is a **client of the same Core** the CLI uses, not a separate agent stack.

---

## 2. Agent Pane today (honest map)

```
   Web (Vite)  /  Tauri WebView
              │
              │  WS + HTTP  127.0.0.1:8787
              ▼
         ┌─────────────────────────┐
         │  Bridge (Node)          │  ← product mid-layer (thick hybrid)
         │  · SessionManager       │
         │  · Event / history      │
         │  · Customize HTTP       │
         │  · PTY / browser MCP    │
         │  · GrokAcpAdapter       │
         │  · AgentProvider iface  │  ← already exists (see §6.3)
         └───────────┬─────────────┘
                     │  spawn + stdio ACP
                     ▼
              `grok agent … stdio`   ← external Agent Core (CLI binary)
```

### Scale (why “thin the adapter” is not a slogan)

Rough line counts under `apps/bridge/src` (~7.3k total):

| File | ~LOC | Role |
|------|------|------|
| `grok-acp-adapter.ts` | **1736** | CLI ACP + turn bookkeeping |
| `http-api.ts` | 1037 | REST surface |
| `session-manager.ts` | **1013** | Multi-session orchestration |
| `history-index.ts` | 559 | Pane session list / events |
| `customize-config.ts` | 533 | Rules / MCP / hooks on disk |

`GrokAcpAdapter` alone is a mini-core by weight. Thinning it is a scale problem with a bathroom scale, not pure ideology.

### Layer table

| Layer | Role today | “Core or shell?” |
|-------|------------|------------------|
| **UI** | Chat, sidebar bubble, Customize, rails | Shell (Desktop / Web front) |
| **Bridge** | Multi-session, broadcast, history disk, REST, PTY | **Hybrid** — product shell + mini-core |
| **Grok CLI** | Real agent loop / tools / hooks execution | **True Agent Core** (outside our repo, process boundary) |

So Agent Pane is **not** yet “Agent Core with three fronts.” It is closer to:

```
        Product shell (UI + thick Bridge)
                       |
              External Grok Agent Core
```

That was the right call when Grok was a black-box CLI. After open source, the *adapter* can thin out; the *product mid-layer* should not disappear without a plan.

---

## 3. Why Bridge is still justified

Even in a pure Core multi-front world, something must sit next to Desktop:

1. **Local gate** — after the upload controversy, a process boundary that owns ports, spawn, and disk is a feature, not debt.
2. **Product state** — Agent Pane history, pins, activity strip, glass UI are not Grok Core’s job.
3. **Multi-session broadcast** — one WebSocket fan-out to the window is UI infrastructure.
4. **Sidecar lifecycle** — Tauri spawning Node (or a future single binary) is packaging, not agent logic.

What *should* shrink is only the part that **re-implements or re-guesses** Core behavior (CLI flags, fragile ACP edge cases, dual session directories).

---

## 4. Target shape (proposed)

```
                    Grok Agent Core
                 (open-source runtime —
                  **prefer out-of-process**
                  official ACP daemon / CLI stdio;
                  in-process embed = last resort)
                          |
          ┌───────────────┼───────────────┐
          │               │               │
     grok CLI      Agent Pane          Future API
                   (Desktop / Web)     (optional)
                          |
                   Pane Host / Bridge
                   (thin: UI session store ·
                    PTY · REST · permission UX ·
                    Provider adapter only)
```

### Process-boundary priority (do not invert)

| Preference | Shape | vs local-gate metric (§5) |
|------------|--------|---------------------------|
| **1 — default** | Bridge / Host spawns **official ACP daemon or `grok agent stdio`** (today) | Gate keeps spawn + ports; agent loop in child |
| **2 — if upstream offers it** | Long-lived **out-of-process** Core service on localhost | Same isolation; fewer cold starts |
| **3 — last resort** | In-process `EmbeddedCoreProvider` inside Bridge | **Conflicts with gate:** agent loop shares the process that can already RW disk + bind ports. Only if (1)(2) are impossible and blast radius is re-audited |

So: “Core closer” means **clearer protocol + thinner adapter**, not “embed the loop into the Host by default.”

### Split of the current Bridge

| Keep in **Pane Host** (ours) | Move toward **Agent Core** (theirs / shared) |
|------------------------------|-----------------------------------------------|
| History list, pins, fork UX | Agent turn loop |
| Customize UI (rules / MCP / hooks editors) | Hook *execution* |
| Terminal PTY, browser panel | Tool runners |
| WS events shaped for React | Canonical session protocol |
| Glass sidebar, traffic-light chrome | Model / effort selection defaults (maybe shared) |

### Adapter evolution (corrected)

```
Today:     UI → Bridge → GrokAcpAdapter implements AgentProvider
                        → spawn `grok agent stdio`

Next:      UI → Pane Host → AgentProvider (interface already in tree)
                              ├─ CliAcpProvider / GrokAcpAdapter (current body)
                              └─ DaemonAcpProvider (preferred second impl)
                              └─ EmbeddedCoreProvider (last resort only)

Later:     optional HTTP API front on the same Host or on Core
```

---

## 5. Opinions (written straight)

### Worth doing

- **Treat open-source Grok as the Agent Core**, Agent Pane as Desktop (and later API) front.  
- **Thin the ACP adapter** once source of truth for messages / resume / hooks is readable upstream.  
- **Keep a local Host** for privacy, multi-session UI, and product-only features.  
- **Document the port and process graph** (`8787` WS+HTTP, terminal path, Tauri sidecar).  
- **Pin upstream version + upgrade playbook** before the adapter gets thin (see §7).  

### Not worth doing (yet)

- Rewriting the agent loop inside Agent Pane “because we can.” That races the open-source Core and splits security review.  
- Merging agent execution into the WebView process for “fewer processes.”  
- **Defaulting to in-process embed** of Core into Bridge (breaks the local-gate story).  
- Forcing CLI and Desktop to share UI code. They should share **Core + protocol**, not React trees.

### Simplification metric

A refactor is “simpler” only if it reduces **one** of:

- process hops for a single prompt, or  
- duplicated session concepts, or  
- adapter special cases,

…**without** increasing “places that can touch the network or the whole FS.”

In-process Core inside Bridge **increases** that surface unless the Host is split again. Prefer out-of-process Core.

---

## 6. Concrete next steps (ordered)

### 6.0 Step 0 — Session ID single truth (do this first)

By the rule in §1, **we already have fork seeds**:

| Place | Session concept |
|-------|-----------------|
| `history-index.ts` | Pane `sessionId`, `~/.agent-pane/sessions/<id>/`, `providerSessionId?` |
| `grok-session-import.ts` | Import Grok CLI / Claude-import ids into Pane |
| `grok-signals-watcher.ts` | `~/.grok/sessions/<cwd-enc>/<providerSessionId>/signals.json` |
| `GrokAcpAdapter` | `domainSessionId`, provider session, user-turn list |
| `SessionManager` | Live map keyed by Pane id + adapter lifecycle |

**Deliverable before a second Provider:**

1. Written map: **Pane `sessionId` ↔ `providerSessionId` ↔ on-disk paths (Pane + Grok)**.  
2. Which id is allowed on the wire to the UI (should be Pane id only).  
3. Resume / import / delete rules: who is source of truth when they disagree.  
4. Tests or a small checklist for “open from history” vs “new agent” vs “import grok”.

Until this is pinned, every “thin adapter” PR will invent another mapping.

### 6.1 Map upstream Core

Entry points, ACP surface, session on-disk format, hooks discovery, telemetry / upload paths.

### 6.2 Diff table: adapter vs product vs packaging

Against `GrokAcpAdapter` + `SessionManager`, classify every concern:

| Bucket | Examples |
|--------|----------|
| **protocol** | ACP lines, init, prompt, cancel, permissions |
| **product** | Pane history titles, pins, activity strip, glass chrome |
| **packaging** | PATH fixups, sidecar spawn, port bind |
| **adapter special cases (watch list)** | **`undoLastTurn` / `rewindToUserTurn`** — Claude Code–style semantics on `AgentProvider`; if Grok Core rewind differs, these are where special cases hide. Map explicitly in the diff table before thinning. |

### 6.3 `AgentProvider` — skeleton already exists

**Code reality (do not document as future tense):**

- Interface: `apps/bridge/src/provider-api.ts`  
- Methods already: `start` / `stop` / `sendPrompt` / `cancel` / `undoLastTurn` / `rewindToUserTurn` / `hydrateUserTurns` / `respondPermission` / `onEvent`  
- Implementation: `GrokAcpAdapter implements AgentProvider`

**Remaining work (not “introduce the interface”):**

1. Second implementation: prefer **Daemon/CLI ACP provider** with a stable contract; **EmbeddedCoreProvider** only if forced.  
2. **Fold session logic into the provider boundary** — today a large amount of session/turn state still lives in the adapter + manager (~adapter weight above). Target: Host owns Pane session map; Provider owns provider session + turn rewind semantics.  
3. Feature-flag provider selection; keep Domain Events for the UI unchanged.

### 6.4 Align Customize

Hooks / rules / MCP stay **editors** of `~/.grok` (and project paths); **execution** stays in Core.

### 6.5 Optional API front

Same Host HTTP already used by Customize; formalize as “API face” only after Desktop + CLI share Core cleanly.

### 6.6 Do not destabilize daily UX mid-flight

Glass sidebar, collapse animation, traffic-light chrome are shell polish—land behind Provider/session cuts, not mixed into them.

---

## 7. Upstream version strategy

Thinning the adapter **increases** dependence on upstream behavior. Without a pin policy, “thin” becomes “breaks on every Grok release.”

| Topic | Policy (draft) |
|-------|----------------|
| **Pin** | Document the supported `grok` / Core version range in README or `docs/` (CLI version, optional Core commit when embedded/daemon). |
| **Protocol break** | Adapter is the only place allowed to special-case; Host and UI stay on Domain Events. If ACP breaks, fail loud in adapter init—not silent drift. |
| **Upgrade flow** | (1) bump pin in a dedicated PR, (2) run resume + prompt + permission smoke, (3) re-check hooks/Customize paths, (4) only then merge Host changes that assume new semantics. |
| **Fallback** | Keep CliAcpProvider path until Daemon/Core path is proven on the same pin. |
| **Telemetry / upload** | Track upstream changes that reintroduce network exfil; Host must not strip process isolation to “keep up.” |

---

## 8. One-line summary

> **Claude/Codex shape = one Agent Core, many fronts.  
> Agent Pane today = strong Desktop front + thick hybrid Host + external Grok Core.  
> Open source lets the Host get thinner and the Core get closer—prefer out-of-process Core; keep the local gate; pin session IDs and upstream versions before the adapter loses weight.**

---

## Related

- Product design: [`docs/superpowers/specs/2026-07-09-agent-pane-design.md`](./superpowers/specs/2026-07-09-agent-pane-design.md)  
- ACP resume notes: [`docs/research/acp-resume-patterns.md`](./research/acp-resume-patterns.md)  
- Provider interface: `apps/bridge/src/provider-api.ts`  
- Bridge listen: `apps/bridge/src/index.ts` (`AGENT_PANE_PORT` default `8787`)  
- Desktop sidecar spawn: `apps/desktop/src-tauri/src/lib.rs` (`start_bridge`)  
- Grok stdio adapter: `apps/bridge/src/grok-acp-adapter.ts`  
- Session import / history / signals: `grok-session-import.ts`, `history-index.ts`, `grok-signals-watcher.ts`  

### Changelog

| Rev | Note |
|-----|------|
| 1 | Initial working notes |
| 2 | Fable5 review: Provider already exists; session ID first; embed last; upstream pin; undo/rewind special-case watch |
