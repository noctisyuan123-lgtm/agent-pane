# Agent Pane — Design Spec

**Date:** 2026-07-09  
**Status:** Draft for review  
**Owner:** Noctis + 妹妹  
**Codename:** `agent-pane`  
**Repo:** `~/projects/agent-pane`

---

## 1. Problem

哥哥没有 Cursor Pro，Claude 账号不可用，日常靠 Grok CLI。CLI 能干活，但缺少 Cursor Agent **整窗** 的可读性与操作节奏：工具时间线、To-dos、候选 diff + Accept/Reject、`@` / `/`、大面积对话流。

侧栏聊天扩展**不在目标内**——那样不如直接在 IDE 里开 agent；本产品要的是 **一整扇 Agent 窗** 的 UI 体验，后端用 Grok。

---

## 2. Goals & Non-Goals

### Goals

1. **整窗 Agent UI**，视觉与信息架构对齐 Cursor Agent 面板（截图为基准），暗色优先。
2. **大脑 = Grok**，通过官方 **ACP**（`grok agent stdio` / `serve`）接入，复用本机已登录的 Grok harness、工具、MCP、skills、rules。
3. **Web 优先** → 迭代 UI → **Tauri 打包**（Nib 同路线），不先养 Code-OSS fork。
4. **迷你～全量 Agent 体验（分阶段）**：流式消息、工具时间线、plan/todos、diff 审阅与应用、权限确认、会话历史、工作区绑定。
5. 代码编辑展示用 **Monaco**（VS Code 编辑器核），不从零写编辑器。

### Non-Goals (v1)

- 不做 Cursor/VS Code **侧栏扩展**作为主形态。
- 不做 Code-OSS 全量 fork / 自有 IDE 发行版（可作远期选项，本 spec 不覆盖）。
- 不重新实现 Grok 的工具执行引擎（不写第二套 agent runtime）。
- 不接入 Claude 为首发后端（架构可留 Provider 口子，首发只接 Grok ACP）。
- 不做多租户 / 云端 SaaS。

---

## 3. Product Shape

### 3.1 Primary surface

**独立全窗口应用**（浏览器 dev / 桌面 prod）：

```
┌─────────────────────────────────────────────────────────────┐
│  顶栏：会话标题 · 工作区路径 · 历史 · 设置 · 窗口控制          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   主区：对话流 + 工具折叠条 + To-dos + Diff 卡片              │
│   （大面积，不是 320px 侧栏）                                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  底栏输入：                                                  │
│  [Agent ▾] [Auto/权限 ▾] [模型 ▾]  ·  输入框  ·  发送        │
│  占位：Plan, @ for context, / for commands                   │
└─────────────────────────────────────────────────────────────┘
```

可选：右侧或浮层 **文件树 / 会话列表**（不抢主视觉，可折叠）。

### 3.2 Delivery phases

| Phase | 形态 | 说明 |
|-------|------|------|
| **P0 Web** | Vite + React 本地页 | `localhost` 开发；本地 Node bridge 拉起 `grok agent` |
| **P1 日用** | 同上 + 稳定 ACP 映射 | 工具时间线、diff Accept、权限、历史可用 |
| **P2 打包** | Tauri 2 壳 | 系统窗、托盘可选、自动起 bridge；Nib 级桌面体验 |
| **P3+** | 可选加深 | 「用系统编辑器打开」、MCP 管理 UI、Plan 完整态、多会话并行 |

---

## 4. Architecture

```
┌──────────────────────┐     WebSocket / HTTP      ┌─────────────────────┐
│  Agent Pane UI       │ ◄──────────────────────► │  Bridge (Node)      │
│  React + Monaco      │   JSON events (UI 协议)   │  localhost only      │
└──────────────────────┘                          └──────────┬──────────┘
                                                             │ ACP JSON-RPC
                                                             │ stdio 或 WS
                                                  ┌──────────▼──────────┐
                                                  │  grok agent         │
                                                  │  stdio | serve      │
                                                  │  tools / MCP / fs   │
                                                  └─────────────────────┘
```

### 4.1 Why a Bridge

浏览器 **不能** 直接 spawn `grok agent stdio`。Bridge 负责：

1. 启动/托管 `grok agent stdio`（首选）或连接 `grok agent serve`（`127.0.0.1:2419`）。
2. 翻译 **ACP ↔ UI 友好事件**（chunk、tool_call、plan、permission、diff）。
3. 工作区路径、模型、permission mode 配置。
4. 会话列表（读 Grok session 存储或 bridge 侧索引）。
5. Diff Accept/Reject：调用 Grok 扩展方法（`x.ai/git/*` / session 审阅相关）或安全的本地 apply。

Tauri 阶段：Bridge 可并入 Rust 侧命令或仍由 sidecar Node 进程承担；**UI 协议保持不变**。

### 4.2 Backend: Grok ACP (locked)

文档：`~/.grok/docs/user-guide/15-agent-mode.md`

- Transport：`grok agent stdio`（主）/ `grok agent serve --bind 127.0.0.1:2419`（备）
- 协议：JSON-RPC 2.0 + ACP
- 生命周期：`initialize` → `session/new`（cwd）→ `session/prompt` → `session/update` 流
- 更新类型（渲染映射）：

| ACP `sessionUpdate` | UI |
|---------------------|-----|
| `agent_message_chunk` | 主回复气泡流式 |
| `agent_thought_chunk` | 可折叠「思考」 |
| `tool_call` / `tool_call_update` | 工具时间线（Exploring / Reading / Grepped…） |
| `plan` | To-dos 面板 |

- 权限：agent 请求工具批准 → UI 弹确认（或 Auto / always-approve 模式）
- 扩展：`x.ai/fs/*`、`x.ai/git/*`、`x.ai/terminal/*`、`x.ai/session/*` 等按需接入

**明确不做：** 自己拼 LLM HTTP + 自写 tool loop 当 v1 主路径（会重复造 Grok 已有的轮子且丢 MCP/skills）。

### 4.3 UI event protocol (Bridge → Frontend)

稳定、版本化的 WS 消息（示意）：

```ts
// client → bridge
{ type: "session.create", cwd: string, model?: string }
{ type: "session.prompt", sessionId: string, text: string, attachments?: ContextRef[] }
{ type: "session.cancel", sessionId: string }
{ type: "permission.respond", requestId: string, allow: boolean }
{ type: "diff.accept", sessionId: string, filePath: string | "*"}
{ type: "diff.reject", sessionId: string, filePath: string | "*"}
{ type: "context.add", refs: ContextRef[] }  // @ files

// bridge → client
{ type: "session.ready", sessionId: string }
{ type: "message.chunk", role: "assistant", text: string }
{ type: "thought.chunk", text: string }
{ type: "tool.start" | "tool.update" | "tool.end", id, title, kind, status, detail? }
{ type: "plan", items: { id, content, status }[] }
{ type: "diff.proposed", files: DiffFile[] }
{ type: "permission.request", requestId, tool, summary }
{ type: "session.error", message: string }
{ type: "session.done", stopReason: string }
```

具体字段在实现计划里对照 ACP 实测补齐；**前端只依赖 UI 协议**，不直接绑死 ACP 字段名。

---

## 5. UI Design

### 5.1 Visual baseline

- **主参考：** 哥哥提供的 Cursor Agent 截图（暗色、工具行、diff 卡、底栏控件）。
- **气质参考（可选二次皮肤）：** Nib Glass tokens（`UI-Templates/Nib-Glass`）——默认先 **Cursor-like dark** 保证「整窗像 Agent」，再提供 Nib 主题切换不阻塞 P0。
- 字体：UI 用 Inter / system-ui；代码用 JetBrains Mono / 系统 mono。
- 布局：单主栏对话；diff 可内嵌卡片或展开为半屏 Monaco diff。

### 5.2 Core components

1. **SessionHeader** — 标题、cwd、连接状态（bridge / grok）
2. **MessageList** — user / assistant / system；markdown
3. **ToolTimeline** — 折叠行：图标 + 动词 + 路径/摘要 + 耗时；展开看输入输出
4. **TodoPanel** — 来自 `plan`；勾选状态只读（agent 驱动）或本地镜像
5. **DiffCard** — 路径、+/- 统计、Monaco DiffEditor 预览、Accept / Reject；批量 Keep All / Undo All
6. **Composer** — 多行输入、发送、停止；`@` 文件选择；`/` 命令菜单
7. **ModeBar** — Agent | 权限模式 | 模型
8. **SessionSidebar**（可关）— 历史会话

### 5.3 Slash commands (v1 最小集)

| Command | 行为 |
|---------|------|
| `/new` | 新会话 |
| `/clear` | 清空当前视图（不删磁盘会话，或二次确认后删） |
| `/model` | 切换模型 |
| `/cwd` | 切换工作区 |
| `/compact` | 若 ACP 支持则转发 |
| `/help` | 列出命令 |

更多 Grok 原生 `/` 命令：P1+ 透传或映射。

### 5.4 `@` context

- 从 cwd 模糊搜文件/文件夹
- 选中后作为 prompt 附件（路径列表 + 可选预读摘要）
- Bridge 把路径写进 ACP prompt content blocks（按 Grok 支持的格式）

---

## 6. Diff & file change flow

1. Agent 通过工具改文件或提出 patch → Bridge 从 ACP 通知 / `x.ai/git/diffs` / `x.ai/session_notification` 归一成 `diff.proposed`。
2. UI 展示 DiffCard；**默认不静默吞掉**（除非用户选 always-approve 且配置「自动 keep」——v1 默认关）。
3. **Accept**：应用该文件变更（若 grok 已写入磁盘，Accept = 确认保留 + UI 消卡；若为缓冲 patch，则 write）。
4. **Reject**：丢弃变更（git checkout / 恢复备份 / ACP discard——实现时选与 Grok 行为一致的一种）。
5. **Keep All / Undo All**：批量。

P0 可先做「已落盘变更的 git diff 展示 + 文件系统回滚」；P1 对齐 Grok 原生 review 语义。

---

## 7. Security & permissions

- Bridge **仅监听 127.0.0.1**，不对外网暴露。
- `grok agent serve` 若使用，必须 secret；Web 开发默认优先 stdio 子进程，少暴露端口。
- 权限模式与 Grok 对齐：`default` / `acceptEdits` / `auto` / `bypassPermissions` 等（以 CLI 实际枚举为准）。
- UI 上危险操作（`rm`、超大写、权限提升）二次确认——若 Grok 已弹 permission，UI 转发即可。
- 不在仓库提交 token / API key；复用本机 `~/.grok` 已有登录态。

---

## 8. Tech stack

| Layer | Choice |
|-------|--------|
| UI | React 18+ · TypeScript · Vite |
| 样式 | Tailwind + CSS variables（dark agent tokens） |
| 编辑器 | Monaco（markdown 预览可用轻量方案；diff 必须 Monaco） |
| Bridge | Node 20+ · `ws` · spawn `grok` |
| 桌面 | Tauri 2（P2） |
| 包管理 | pnpm |
| 测试 | Vitest（协议映射纯函数）；少量 Playwright 烟测（P1） |

---

## 9. Repository layout (target)

```
agent-pane/
  docs/superpowers/specs/     # 本设计与后续计划
  apps/web/                   # Vite React UI
  apps/bridge/                # Node ACP bridge
  packages/ui-protocol/       # 共享 TS 类型
  src-tauri/                  # P2
  README.md
```

P0 可先 monorepo 扁平：`web/` + `bridge/`，类型先放 `shared/`。

---

## 10. Milestone breakdown

### M0 — Skeleton (约 1–2 晚)

- Vite 暗色整窗壳（顶栏 + 消息区 + Composer 静态）
- Bridge health + 能 spawn `grok agent stdio` 并完成 `initialize`
- UI 显示「已连接」

### M1 — Chat loop

- `session/new` + `session/prompt`
- 流式 `agent_message_chunk` / thought
- 停止生成
- 选择 cwd / model

### M2 — Agent chrome

- ToolTimeline 完整映射
- plan → TodoPanel
- permission.request UI
- `@` 文件、`/` 最小命令

### M3 — Diff review

- diff.proposed + Monaco DiffCard
- Accept / Reject / Keep All
- 与 git 状态一致的反馈

### M4 — Sessions & polish

- 历史列表与 resume
- 错误/重连
- 快捷键（Enter 发送、⌘Enter、Esc 停止）
- 视觉逼近截图

### M5 — Tauri package

- 打包 macOS arm64
- 启动时拉起 bridge sidecar
- 窗体尺寸/标题/dock 图标

---

## 11. Success criteria

哥哥可以：

1. 打开一整窗（浏览器或桌面），选中项目 cwd。
2. 用自然语言让 Grok 读代码、改文件、跑命令，**工具过程可视化**，不是 CLI 刷屏。
3. 对 diff 点 Accept/Reject，结果符合预期。
4. 不依赖 Cursor Pro、不依赖 Claude。
5. 体感上「这就是我的 Agent 窗」，而不是「又一个网页聊天」。

---

## 12. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| ACP 扩展字段文档不全 | M0 用真实 `initialize` + 抓包式日志固化映射表 |
| Diff 语义与「已写入磁盘」纠缠 | 先明确两种模式（buffer vs applied），UI 文案区分 |
| `grok` 路径/版本漂移 | Bridge 可配置 `GROK_BIN`，默认 `~/.grok/bin/grok` |
| 整窗做太像 Cursor 的商标风险 | 自有命名/图标；布局灵感参考，不复制 Cursor 资源文件 |
| 范围膨胀到 IDE fork | 本 spec 锁死：独立窗 + ACP，不做 Code-OSS |

---

## 13. Open decisions (defaulted)

| Topic | Default | 可改 |
|-------|---------|------|
| 产品名 | Agent Pane（可改中文名） | 哥哥起名 |
| 主题 | Cursor-like dark 优先 | 后加 Nib Glass |
| Transport | stdio 主路径 | serve 作远程/多端 |
| 自动批准 | UI 默认需确认写/ shell | 提供 Auto 开关 |
| 项目路径 | `~/projects/agent-pane` | — |

---

## 14. References

- Cursor Agent UI 截图（2026-07-09）— 视觉基准  
- Cursor.app 逆向结论：Agent 嵌在 `workbench.*.main.js` 的 composer/toolFormer；**不 fork，只参考表面**  
- Grok ACP：`~/.grok/docs/user-guide/15-agent-mode.md`  
- Grok headless：`14-headless-mode.md`  
- Nib Glass：`~/UI-Templates/Nib-Glass/nib-glass-style-guide.md`  
- 已有 CLI：`~/.grok/bin/grok` · `grok agent stdio|serve|leader`
---
