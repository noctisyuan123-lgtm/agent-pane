# grodex — Design Spec

**Date:** 2026-07-17  
**Status:** Draft for review  
**Owner:** Noctis（产品） / 妹妹（总设计）  
**Codename:** `grodex`

---

## 1. One-liner

**grodex** = fork of open-source [Grok Build](https://github.com/xai-org/grok-build)，按 Claude Code / Codex 的产品结构做成「一份 Agent Core + 多张脸」；Desktop 做 Cursor 味全窗，UI 零件从现有 **agent-pane** 材料库搬入。

---

## 2. Product shape (Claude-like)

```
                 Agent Core
            (loop / tools / sessions)
                       |
         ┌─────────────┼─────────────┐
         │             │             │
        CLI         Desktop         API
     (TUI/headless) (全窗 UI)   (stdio/serve/ACP/SDK)
```

| Surface | Role | v1 intent |
|---------|------|-----------|
| **Core** | Single source of truth for turns, tools, session UUID | Keep upstream `xai-grok-shell` + tools; change only when Desktop needs it |
| **CLI** | First-class daily path (like `claude` / `codex`) | Ship as `grodex` (or `grodex` alias over forked binary); full resume = same session id |
| **Desktop** | Cursor-like full window | First-party face of Core — **not** an external ACP host forever |
| **API** | Scripts, CI, embedders | Keep ACP `agent stdio` / `serve`; Desktop must not depend on digest-fake-resume |

**Non-goals (v1):** multi-provider brain (Claude/Codex adapters); SaaS; replacing Grok auth with a second identity system.

---

## 3. Repos & materials

| Repo | Role |
|------|------|
| `xai-org/grok-build` | Upstream; periodic sync when useful |
| **`grodex`** (new GitHub repo, fork or mirror-of-fork) | Product home: Core + CLI + Desktop + API |
| `noctisyuan123-lgtm/agent-pane` | **Materials library only** — React/Tauri UI (TextRoll, tool timeline, subagent cards, Working pill, bridge patterns). Not the long-term Core host |

Maintenance stance (accepted): fork may diverge; sync upstream on major releases rather than daily. Prefer cherry-picks over continuous rebase noise.

---

## 4. Session identity (hard rule)

- One user conversation ⇒ **one Core session UUID** on disk (`~/.grok/sessions/…` or grodex-equivalent path if rebranded).
- CLI and Desktop attach to that same id (true resume / load), Claude-Code-style.
- **Forbidden as the long-term Desktop resume strategy:** ACP `session/new` + history digest that mints A→C→B provider ids while the UI pretends continuity.
- Short-term: Desktop may boot via existing ACP while Core wiring lands; must be marked transitional in code comments and removed once native attach works.

---

## 5. Desktop architecture (inside grodex)

Preferred end state:

```
Desktop (Tauri + Web UI, ported from agent-pane)
    → thin Host / Bridge
        → in-process or sibling link to Agent Core
            → same session store as CLI
```

Transitional (allowed):

```
Desktop → Bridge → forked `grodex agent stdio|serve` (ACP)
```

Only acceptable if resume uses **load/attach same UUID**, not digest-new-session.

**UI port priority (from agent-pane):**

1. Shell layout: composer, session list, activity strip  
2. Tool timeline + LiveProcess TextRoll  
3. Subagent task card + Working pill  
4. Diff / permission flows (as Core events allow)  
5. Polish / theming last  

---

## 6. Branding

- Product name: **grodex**
- Binary / CLI: prefer `grodex` (upstream artifact may remain `xai-grok-pager` / `grok` during early builds; document install rename)
- Config / data dirs: decide in implementation plan — either keep `~/.grok` for compatibility **or** introduce `~/.grodex` with migration note. Default proposal: **keep `~/.grok` in v1** to reuse auth + sessions; brand only the app/CLI name.

---

## 7. Workstyle

- **总设计 / 终审:** 妹妹（this agent）— architecture, specs, review of subagent output  
- **杂货:** 子代理 — fork bootstrap, file moves, mechanical UI ports, checklist verification  
- **agent-pane:** freeze feature ambition; only harvest patches worth porting  

---

## 8. Phased delivery

| Phase | Outcome |
|-------|---------|
| **G0** | GitHub `grodex` exists (fork of grok-build); README states product shape; CI/build notes for Desktop placeholder |
| **G1** | CLI builds & runs from fork; `grodex --version` / resume path documented |
| **G2** | Desktop skeleton in-tree (Tauri or agreed stack); can start/attach one Core session |
| **G3** | Port agent-pane chat + tool timeline; true same-UUID resume from Desktop |
| **G4** | Drop digest-resume; upstream sync playbook written |

---

## 9. Open decisions (resolve in plan, not blockers for G0)

1. Desktop stack pin: reuse agent-pane **Tauri 2 + Vite/React** vs native Rust UI (default: **reuse Tauri stack**).  
2. Monorepo layout: `apps/desktop` beside upstream crates vs separate workspace member — follow least-friction for cargo + node.  
3. Public vs private GitHub for `grodex` fork.  
4. Whether to accept upstream “no external contributions” culture by staying on a personal fork forever (yes for A).

---

## 10. Success criteria

- Opening the same conversation from CLI and Desktop does **not** create a new Core UUID.  
- Desktop feels like a first-party grodex face, not a third-party ACP remote.  
- agent-pane remains readable as a UI quarry; grodex is the product you open daily.

---

## 11. Approval

- [ ] Product name `grodex` confirmed  
- [ ] Structure (Core / CLI / Desktop / API) confirmed  
- [ ] agent-pane = materials only confirmed  
- [ ] Ready for G0 (create fork + README) via subagents after this spec is accepted  
