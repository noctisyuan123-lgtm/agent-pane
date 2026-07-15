# Open-source references for Agent Pane

Cursor’s Agent shell is **not open source** (closed fork + proprietary composer/toolFormer). What we can legally learn from is the protocol layer and open Agent UIs.

## Must-read: protocols & standards

| Resource | Why |
|----------|-----|
| [Agent Client Protocol (ACP)](https://agentclientprotocol.com) | The standard we already use: tool_call streams, permissions, **fs/read_text_file** client RPCs |
| Grok `15-agent-mode.md` | Local sample client at `~/.grok/docs/user-guide/15-agent-mode.md` |
| [cursor-agent-acp-npm](https://github.com/blowmage/cursor-agent-acp-npm) | Adapter that wires Cursor CLI to ACP (good layering reference) |

## Tool timeline / session UI to study

| Project | Shape | Worth copying |
|---------|-------|---------------|
| **[Cline](https://github.com/cline/cline)** (Apache-2.0) | VS Code extension | Plan/Act, tool approval UI, tool blocks inside messages |
| **[Roo Code](https://github.com/RooCodeInc/Roo-Code)** / Kilo | Cline-family fork | Similar agent panel patterns |
| **[Void](https://github.com/voideditor/void)** | VS Code fork | “Open Cursor” layout; Agent mode structure |
| **[OpenHands](https://github.com/All-Hands-AI/OpenHands)** | Platform + canvas | Multi-agent canvas; ACP-facing CLI agents |
| **[Zed](https://github.com/zed-industries/zed)** | Editor | ACP client side (agent panel + protocol) |
| **Aider** | Terminal | Diff/git workflow reference (not GUI) |
| **Continue** | Formerly open | Acquired by Cursor; useful archaeology, not an active dependency |

## Tool-log translation + cache (recommended model)

```
Provider raw frames
   → Adapter (normalize)     # only place that understands ACP/CLI
   → Domain Event            # ToolStarted / Progress / Finished
   → Event Store (jsonl)     # already done: replay / debug
   → UI projection cache     # rebuild ToolRow[] from events; no second source of truth
```

Cursor’s internals are roughly stream → toolFormer → UI projection. We use the **Event Store as the cache of truth**, which is more stable than regex-parsing CLI logs.

When stuck, check first:

1. Declared a capability but never implemented the matching RPC (past bug: `fs/read_text_file`)
2. `session/request_permission` never replied with the same id
3. Event Store last entry stuck on `ToolProgress` / `PermissionRequested`

## Avoid

- Decompiling Cursor.app commercial UI assets for redistribution
- Treating Continue’s current product as an upstream (post-acquisition policy is unclear)
- Writing a second tool runtime that bypasses Grok (loses MCP / skills)
