# Open-source references for Agent Pane

Cursor 的 Agent 壳**不开源**（闭源 fork + 自研 composer/toolFormer）。我们能合法参考的是协议层与开源 Agent UI。

## 必看：协议与标准

| 资源 | 为什么 |
|------|--------|
| [Agent Client Protocol (ACP)](https://agentclientprotocol.com) | 我们已用的标准：tool_call 流、permission、**fs/read_text_file** 客户端实现 |
| Grok `15-agent-mode.md` | `~/.grok/docs/user-guide/15-agent-mode.md` 本地示例客户端 |
| [cursor-agent-acp-npm](https://github.com/blowmage/cursor-agent-acp-npm) | 把 Cursor CLI 接到 ACP 的适配器（学 adapter 分层） |

## Tool 时间线 / 会话 UI 可抄

| 项目 | 形态 | 可抄什么 |
|------|------|----------|
| **[Cline](https://github.com/cline/cline)** (Apache-2.0) | VS Code 扩展 | Plan/Act、工具审批 UI、消息里嵌 tool 块的渲染 |
| **[Roo Code](https://github.com/RooCodeInc/Roo-Code)** / Kilo | Cline 系 fork | 同类 agent 面板 |
| **[Void](https://github.com/voideditor/void)** | VS Code fork | 「开源 Cursor」整体布局；Agent 模式 UI 结构 |
| **[OpenHands](https://github.com/All-Hands-AI/OpenHands)** | 平台 + Canvas | 多 agent 画布；通过 ACP 接 CLI agent |
| **[Zed](https://github.com/zed-industries/zed)** | 编辑器 | ACP 客户端侧实现（agent 面板 + 协议） |
| **Aider** | 终端 | Diff/git 工作流参考，不是 GUI |
| **Continue** | 曾开源 | 已被 Cursor 收购；老代码可考古，不宜当活跃依赖 |

## Tool log 转译 + 缓存（推荐模型）

```
Provider raw frames
   → Adapter (normalize)     # 唯一懂 ACP/CLI 的地方
   → Domain Event            # ToolStarted/Progress/Finished
   → Event Store (jsonl)     # 已做：可 replay / debug
   → UI projection cache     # 前端由 event 还原 ToolRow[]，勿存第二份真相
```

Cursor 内部大致也是 stream → toolFormer → UI 投影；我们用 **Event Store 当缓存真相**，比「把 CLI 日志正则解析」稳。

卡住时优先查：

1. 是否声明了 capability 却没实现对应 RPC（本次 bug：`fs/read_text_file`）
2. `session/request_permission` 是否未 reply 同 id
3. Event Store 最后一条卡在 `ToolProgress` / `PermissionRequested`

## 不建议

- 反编译 Cursor.app 商业 UI 资源当素材发布
- 把 Continue 现网当上游（收购后策略不明）
- 自写第二套 tool runtime 绕过 Grok（丢掉 MCP/skills）
