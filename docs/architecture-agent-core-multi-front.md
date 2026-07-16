# Agent Core · Multi-Front Architecture

**Date:** 2026-07-16  
**Status:** Working notes (direction for the next large refactor)  
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
| Wire protocol | Yes | stdio ACP, HTTP, or in-process API |
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
         │  Bridge (Node)          │  ← product mid-layer (thick)
         │  · SessionManager       │
         │  · Event / history      │
         │  · Customize HTTP       │
         │  · PTY / browser MCP    │
         │  · GrokAcpAdapter       │
         └───────────┬─────────────┘
                     │  spawn + stdio ACP
                     ▼
              `grok agent … stdio`   ← external Agent Core (CLI binary)
```

### Layer table

| Layer | Role today | “Core or shell?” |
|-------|------------|------------------|
| **UI** | Chat, sidebar bubble, Customize, rails | Shell (Desktop / Web front) |
| **Bridge** | Multi-session, broadcast, history disk, REST, PTY | **Hybrid** — partly product shell, partly “mini-core” |
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

Keep the public diagram simple; rename pieces so ownership is clear:

```
                    Grok Agent Core
                 (open-source runtime —
                  in-process lib and/or
                  official ACP daemon)
                          |
          ┌───────────────┼───────────────┐
          │               │               │
     grok CLI      Agent Pane          Future API
                   (Desktop / Web)     (optional)
                          |
                   Pane Host / Bridge
                   (thin: sessions UI
                    store · PTY · REST
                    · permission UX)
```

### Split of the current Bridge

| Keep in **Pane Host** (ours) | Move toward **Agent Core** (theirs / shared) |
|------------------------------|-----------------------------------------------|
| History list, pins, fork UX | Agent turn loop |
| Customize UI (rules / MCP / hooks editors) | Hook *execution* |
| Terminal PTY, browser panel | Tool runners |
| WS events shaped for React | Canonical session protocol |
| Glass sidebar, traffic-light chrome | Model / effort selection defaults (maybe shared) |

### Adapter evolution

```
Today:     UI → Bridge → spawn `grok agent stdio`
Next:      UI → Pane Host → Provider interface
                              ├─ CliAcpProvider (current)
                              └─ EmbeddedCoreProvider (post open-source)
Later:     optional HTTP API front on the same Host or on Core
```

Do **not** jump straight to “delete Bridge.” Prefer:

1. **Provider interface** at the Adapter boundary.  
2. **One session ID model** documented end-to-end.  
3. **Embedded Core** as a second implementation, feature-flagged.  
4. Only then collapse dead CLI-only code paths.

---

## 5. Opinions (sister’s take, written straight)

### Worth doing

- **Treat open-source Grok as the Agent Core**, Agent Pane as Desktop (and later API) front.  
- **Thin the ACP adapter** once source of truth for messages / resume / hooks is readable in-tree upstream.  
- **Keep a local Host** for privacy, multi-session UI, and product-only features.  
- **Document the port and process graph** (already roughly: `8787` WS+HTTP, terminal path, Tauri sidecar).  

### Not worth doing (yet)

- Rewriting the agent loop inside Agent Pane “because we can.” That races the open-source Core and splits security review.  
- Merging agent execution into the WebView process for “fewer processes.” Harder to reason about, worse blast radius.  
- Forcing CLI and Desktop to share UI code. They should share **Core + protocol**, not React trees.

### Simplification metric

A refactor is “simpler” only if it reduces **one** of:

- process hops for a single prompt, or  
- duplicated session concepts, or  
- adapter special cases,

…without increasing “places that can touch the network or the whole FS.”

---

## 6. Concrete next steps (when the large project starts)

1. **Map upstream Core**  
   Entry points, ACP surface, session on-disk format, hooks discovery, any telemetry / upload paths.

2. **Diff against `GrokAcpAdapter` + `SessionManager`**  
   Table: *protocol | product | packaging*.

3. **Introduce `AgentProvider`**  
   Methods: create / resume / prompt / stop / permissions; Domain Events unchanged for UI.

4. **Align Customize**  
   Hooks / rules / MCP stay editors of `~/.grok` (and project paths); execution stays in Core.

5. **Optional API front**  
   Same Host HTTP already used by Customize; formalize as “API face” only after Desktop+CLI share Core cleanly.

6. **Do not destabilize daily UX mid-flight**  
   Glass sidebar, collapse animation, traffic-light chrome are shell polish—land behind the Provider cut, not mixed into it.

---

## 7. One-line summary

> **Claude/Codex shape = one Agent Core, many fronts.  
> Agent Pane today = strong Desktop front + thick local Host + external Grok Core.  
> Open source lets the Host get thinner and the Core get closer—without throwing away the local gate.**

---

## Related

- Product design: [`docs/superpowers/specs/2026-07-09-agent-pane-design.md`](./superpowers/specs/2026-07-09-agent-pane-design.md)  
- ACP resume notes: [`docs/research/acp-resume-patterns.md`](./research/acp-resume-patterns.md)  
- Bridge listen: `apps/bridge/src/index.ts` (`AGENT_PANE_PORT` default `8787`)  
- Desktop sidecar spawn: `apps/desktop/src-tauri/src/lib.rs` (`start_bridge`)  
- Grok stdio spawn: `apps/bridge/src/grok-acp-adapter.ts`  
