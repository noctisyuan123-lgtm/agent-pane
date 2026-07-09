# Agent Pane — Design Spec

**Date:** 2026-07-09  
**Status:** Draft for review (rev 2 — architecture hardening)  
**Owner:** Noctis + 妹妹  
**Codename:** `agent-pane`  
**Repo:** `~/projects/agent-pane`

**Rev 2 notes:** 吸收外部评审中 4 条架构必改项（Event Store · Domain Event · Git/FS Diff · Workspace Snapshot），以及 Adapter / Task Model / Diff Engine 的分层口子。产品形态与交付节奏不变。

---

## 1. Problem

哥哥没有 Cursor Pro，Claude 账号不可用，日常靠 Grok CLI。CLI 能干活，但缺少 Cursor Agent **整窗** 的可读性与操作节奏：工具时间线、To-dos、候选 diff + Accept/Reject、`@` / `/`、大面积对话流。

侧栏聊天扩展**不在目标内**——那样不如直接在 IDE 里开 agent；本产品要的是 **一整扇 Agent 窗** 的 UI 体验。首发大脑用 Grok；架构按 **Provider 可替换** 设计，但不在 v1 实现多后端。

---

## 2. Goals & Non-Goals

### Goals

1. **整窗 Agent UI**，视觉与信息架构对齐 Cursor Agent 面板（截图为基准），暗色优先。
2. **首发大脑 = Grok**，经 **Grok ACP Adapter** 接入（`grok agent stdio` / `serve`），复用本机 harness / 工具 / MCP / skills / rules。
3. **Web 优先** → 迭代 UI → **Tauri 打包**（Nib 同路线），不先养 Code-OSS fork。
4. **迷你～全量 Agent 体验（分阶段）**：流式消息、工具时间线、tasks、diff 审阅、权限、会话历史、工作区绑定。
5. 代码展示用 **Monaco**；**Diff 的真相来源 = Git / 文件系统**，不绑死某 Provider 的 diff 事件。
6. Bridge 内 **Domain Event + Event Store**：React 只订阅事件，不当事情源；支持回放、调试、崩溃恢复、导出。

### Non-Goals (v1)

- 不做 Cursor/VS Code **侧栏扩展**作为主形态。
- 不做 Code-OSS 全量 fork / 自有 IDE 发行版（远期可选，本 spec 不覆盖）。
- 不重新实现 Grok 的工具执行引擎（不写第二套 agent runtime）。
- **不实现** Claude / Codex / Gemini 适配器本体（只保留 Adapter 接口与 Domain Event，避免假抽象过深）。
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
| **P0 Web** | Vite + React 本地页 | `localhost`；Bridge + Event Store + Grok Adapter 骨架 |
| **P1 日用** | 同上 | 工具时间线、Git Diff + Snapshot Accept/Reject、权限、历史回放可用 |
| **P2 打包** | Tauri 2 壳 | 系统窗、sidecar Bridge；Nib 级桌面体验 |
| **P3+** | 可选加深 | 第二 Provider、MCP 管理 UI、多会话并行、完整 Timeline 回放 UX |

---

## 4. Architecture

### 4.0 Hard requirements (rev 2)

下列四项为 **M0 起就要落进代码结构** 的约束，不是「以后重构再说」：

| # | 约束 | 原因 |
|---|------|------|
| 1 | **Event Store** | 所有 Domain Event 先 append 再广播 → replay / debug / resume / export |
| 2 | **Provider 无关 Domain Event** | 前端与 Bridge 核心不认识 ACP 字段名 |
| 3 | **Diff 来自 Git/FS + Diff Engine** | 任意会改盘的 Agent 都能审阅；不依赖 Provider 是否发 diff 事件 |
| 4 | **Workspace Snapshot** | Accept/Reject 不依赖 Provider 的 discard API |

次要但建议同期分好边界（实现可薄）：

| # | 约束 | 说明 |
|---|------|------|
| 5 | **Tool 统一状态机** | `ToolStarted` / `ToolProgress` / `ToolFinished` / `ToolFailed` |
| 6 | **Task Model** | TodoPanel 消费 Task，不直接绑 Plan |
| 7 | **Provider Adapter 层** | Bridge 核心不解析 ACP 原始帧 |
| 8 | **Diff Engine 独立模块** | DiffCard 只渲染 `DiffModel` |

### 4.1 Layered diagram

```
┌─────────────────────────────────────────┐
│  Agent Pane UI (React + Monaco)         │
│  · 只发 Command · 只订阅 Domain Event    │
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

**React 永远不是事件源。** UI 发出的是 **Command**（`session.prompt`、`diff.accept`…）；状态变化一律以 **Domain Event** 形式从 Event Store 流出。

### 4.2 Why a Bridge

浏览器不能 spawn `grok agent stdio`。Bridge 负责：

1. 托管 Provider 进程/连接（v1：Grok ACP）。
2. Adapter 把 Provider 流量 **归一成 Domain Event** → **Event Store.append** → 广播。
3. 工作区、模型、权限模式配置。
4. **Workspace Snapshot** + **Diff Engine**（Git/FS）。
5. 会话索引、按 store 做 replay / export。

Tauri 阶段：Bridge 可作 sidecar；**Domain Event 与 Command 协议不变**。

### 4.3 Domain Event Model（Provider 无关）

权威定义放在 `packages/domain-events`（或 `shared/events`）。命名用稳定 verb 形式：

```ts
// 会话
type DomainEvent =
  | { type: "SessionStarted"; sessionId: string; cwd: string; model?: string; at: string }
  | { type: "SessionEnded"; sessionId: string; stopReason: string; at: string }
  | { type: "SessionError"; sessionId: string; message: string; at: string }

  // 消息
  | { type: "UserMessageAppended"; sessionId: string; text: string; attachments?: ContextRef[]; at: string }
  | { type: "MessageChunk"; sessionId: string; role: "assistant"; text: string; at: string }
  | { type: "ThoughtChunk"; sessionId: string; text: string; at: string }
  | { type: "MessageDone"; sessionId: string; role: "assistant"; at: string }

  // 工具（统一状态机；Timeline 只认这一套）
  | { type: "ToolStarted"; sessionId: string; toolId: string; title: string; kind: string; inputSummary?: string; at: string }
  | { type: "ToolProgress"; sessionId: string; toolId: string; detail?: string; at: string }
  | { type: "ToolFinished"; sessionId: string; toolId: string; outputSummary?: string; at: string }
  | { type: "ToolFailed"; sessionId: string; toolId: string; error: string; at: string }

  // 任务（TodoPanel 只认 Task；来源可是 plan / workflow / …）
  | { type: "TaskUpserted"; sessionId: string; task: Task; at: string }
  | { type: "TaskRemoved"; sessionId: string; taskId: string; at: string }
  | { type: "TasksReplaced"; sessionId: string; tasks: Task[]; at: string }

  // 权限
  | { type: "PermissionRequested"; sessionId: string; requestId: string; tool: string; summary: string; at: string }
  | { type: "PermissionResolved"; sessionId: string; requestId: string; allow: boolean; at: string }

  // Diff（由 Diff Engine 产出，不是 Adapter 直出）
  | { type: "DiffProposed"; sessionId: string; files: DiffFileMeta[]; at: string }
  | { type: "DiffResolved"; sessionId: string; filePath: string | "*"; action: "accept" | "reject"; at: string }

  // 快照
  | { type: "SnapshotTaken"; sessionId: string; snapshotId: string; at: string }
  | { type: "SnapshotRestored"; sessionId: string; snapshotId: string; at: string };
```

`Task` 形状（与来源解耦）：

```ts
type Task = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  source?: "plan" | "workflow" | "checklist" | "other";
};
```

**规则：**

- Adapter **只**把 Provider 帧变成 Domain Event（或 Domain intents）。
- Diff / Snapshot **不由** Adapter 直接对 UI 说话。
- 前端 **禁止** `if (provider === 'grok')`；禁止依赖 ACP 字段名。

### 4.4 Event Store

每个 `sessionId` 一条 append-only 日志：

```
~/.agent-pane/sessions/<sessionId>/events.jsonl
# 或项目内 .agent-pane/ 开发期路径；实现计划定默认
```

行为：

1. 任意 Domain Event → `store.append(event)`（持久化 + 内存 ring）。
2. 再 `broadcast(event)` 给已连接 WS 客户端。
3. 客户端重连 / 新开页：`events.subscribe({ fromSeq })` 或 `events.replay(sessionId)`。
4. Export Conversation = 过滤/渲染 store。
5. Debug 面板（P1+）= 原样查看 jsonl。

**顺序：** 全局单调 `seq`（per-session）。事件带 `at` ISO 时间。

M0 可用单文件 jsonl；不引入重型 DB。

### 4.5 Provider Adapter interface

```ts
interface AgentProvider {
  readonly id: string; // "grok-acp"
  start(opts: { cwd: string; model?: string; permissionMode?: string }): Promise<void>;
  stop(): Promise<void>;
  sendPrompt(input: { sessionId: string; text: string; attachments?: ContextRef[] }): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  respondPermission(requestId: string; allow: boolean): Promise<void>;
  // Adapter → Bridge：只回调 Domain Event（或 raw 帧由 adapter 内部转完再回调）
  onEvent(handler: (e: DomainEvent) => void): void;
}
```

**v1 唯一实现：`GrokAcpAdapter`**

- Transport：`grok agent stdio`（主）/ `serve`（备）
- 文档：`~/.grok/docs/user-guide/15-agent-mode.md`
- 内部映射示例（不落前端）：

| ACP / Grok | Domain Event |
|------------|--------------|
| `agent_message_chunk` | `MessageChunk` |
| `agent_thought_chunk` | `ThoughtChunk` |
| `tool_call` | `ToolStarted` |
| `tool_call_update` (running) | `ToolProgress` |
| `tool_call_update` (completed) | `ToolFinished` |
| `tool_call_update` (failed) | `ToolFailed` |
| `plan` | `TasksReplaced` / `TaskUpserted`（`source: "plan"`） |
| permission request | `PermissionRequested` |
| end turn | `MessageDone` / `SessionEnded` |

**明确不做 v1：** 自建 LLM HTTP + 自写 tool loop 当主路径。

### 4.6 Commands（UI → Bridge）

```ts
// client → bridge（Command，不是 Domain Event）
{ type: "session.create"; cwd: string; model?: string }
{ type: "session.prompt"; sessionId: string; text: string; attachments?: ContextRef[] }
{ type: "session.cancel"; sessionId: string }
{ type: "session.replay"; sessionId: string; fromSeq?: number }
{ type: "permission.respond"; requestId: string; allow: boolean }
{ type: "diff.accept"; sessionId: string; filePath: string | "*" }
{ type: "diff.reject"; sessionId: string; filePath: string | "*" }
{ type: "diff.refresh"; sessionId: string }  // 强制重跑 Diff Engine
{ type: "context.search"; cwd: string; query: string } // @ picker 可走 HTTP
```

Bridge 处理 Command 时：可能调用 Provider、Snapshot、Diff Engine；**副作用结果仍以 Event 形式进入 Store**。

### 4.7 Workspace Snapshot

```
Session create / first prompt
        ↓
  SnapshotTaken  (baseline of cwd — 见下)
        ↓
  Agent 改文件（任意 Provider）
        ↓
  Diff Engine → DiffProposed
        ↓
  Accept  → 更新 baseline（新 Snapshot 或移动 head）+ DiffResolved(accept)
  Reject  → SnapshotRestored（回到 baseline）+ DiffResolved(reject)
```

**实现策略（按成本递进，实现计划里锁定一种默认）：**

| 策略 | 适用 | 说明 |
|------|------|------|
| **A. Git stash/worktree baseline** | 已是 git 仓库 | 用 `git` 记 baseline commit/tree；reject = restore paths from baseline |
| **B. 文件级 copy-on-write 镜像** | 非 git / 混合 | session 开始时对即将修改的文件在改前备份；或全量 ignore 规则下的树指纹 + 按需备份 |
| **C. 混合（推荐默认）** | 通用 | **优先 Git**；非 git 路径 fallback 到 per-file backup 目录 `~/.agent-pane/snapshots/<id>/` |

**Reject 禁止**依赖「ACP 是否支持 discard」。  
**Accept** 在「agent 已写盘」模型下 = 确认保留 + 刷新 baseline + 清 Diff 卡；不二次 write，除非未来有 buffer 模式。

Snapshot 范围：尊重 `.gitignore` + 可选 `.agent-paneignore`；排除 `node_modules`、大二进制。

### 4.8 Diff Engine（独立模块）

```
Filesystem + Git
       ↓
  Diff Engine
       ↓
  DiffModel { files: DiffFile[] }
       ↓
  DomainEvent DiffProposed
       ↓
  DiffCard (只渲染)
```

- **真相来源：** 工作区相对 **当前 session baseline snapshot** 的差异（git diff baseline…worktree，或 file-backup diff）。
- **触发：** 工具结束后、turn 结束后、用户 `diff.refresh`、fs watch 防抖（P1）。
- ACP/Grok 的 diff 通知 **仅作 hint**（可触发 refresh），**不**直接喂给 DiffCard。
- `DiffFile`：`path`, `status`, `additions`, `deletions`, `patch` 或 before/after 路径（Monaco 用）。

独立模块便于以后加：三方 merge、只读 patch 导入、导出 `.patch`。

### 4.9 Task Model vs Plan

- Provider 的 plan 更新 → Adapter 映射为 `TaskUpserted` / `TasksReplaced`（`source: "plan"`）。
- TodoPanel **只**订阅 Task 相关 Domain Event。
- 未来 checklist / workflow 同一面板，无需改 UI 契约。

---

## 5. UI Design

### 5.1 Visual baseline

- **主参考：** Cursor Agent 截图（暗色、工具行、diff 卡、底栏）。
- **可选皮肤：** Nib Glass（不阻塞 P0）。
- 字体：UI Inter / system-ui；代码 JetBrains Mono / 系统 mono。
- 布局：单主栏对话；diff 内嵌卡或半屏 Monaco DiffEditor。

### 5.2 Core components

1. **SessionHeader** — 标题、cwd、连接状态、可选 seq 指示
2. **MessageList** — 由 `UserMessageAppended` / `MessageChunk` / `MessageDone` 投影
3. **ToolTimeline** — 只认 Tool* 四态；折叠行 + 展开详情
4. **TodoPanel** — 只认 Task* 事件
5. **DiffCard** — 只认 `DiffModel` / `DiffProposed`；Accept/Reject 发 Command
6. **Composer** — Command：`session.prompt`；`@` / `/`
7. **ModeBar** — 权限模式 · 模型（写入 session 配置，非 Domain Event 泛滥）
8. **SessionSidebar** — 历史；打开时 `session.replay`
9. **EventDebugDrawer**（P1，可隐藏）— 直接看 Event Store

### 5.3 Slash commands (v1 最小集)

| Command | 行为 |
|---------|------|
| `/new` | 新会话 + 新 Snapshot |
| `/clear` | 清空视图（store 仍可保留） |
| `/model` | 切换模型 |
| `/cwd` | 切换工作区（新会话或重置 snapshot） |
| `/export` | 从 Event Store 导出对话 |
| `/help` | 列出命令 |

### 5.4 `@` context

- cwd 模糊搜文件/文件夹
- 作为 prompt attachments；Adapter 负责写成 Provider 认识的 content blocks

---

## 6. Diff & file change flow（定稿）

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

- UI **默认**展示待审 diff，不静默 Keep（Auto-keep 为显式设置，v1 默认关）。
- Keep All / Undo All = `filePath: "*"`。
- 与「agent 是否已写盘」解耦：**我们假设工具会改盘**；审阅层永远是 baseline↔worktree。

---

## 7. Security & permissions

- Bridge **仅 127.0.0.1**。
- `grok agent serve` 若用，必须 secret；开发默认 stdio 子进程。
- 权限：`PermissionRequested` → UI → `permission.respond` Command → Adapter → Provider。
- 模式枚举对齐 Grok CLI（`default` / `acceptEdits` / `auto` / `bypassPermissions` 等以实测为准）。
- 不提交 token；复用 `~/.grok` 登录态。
- Snapshot 目录权限同用户本地；不上传云。

---

## 8. Tech stack

| Layer | Choice |
|-------|--------|
| UI | React 18+ · TypeScript · Vite |
| 样式 | Tailwind + CSS variables（dark agent tokens） |
| 编辑器 | Monaco（diff 必用） |
| Bridge | Node 20+ · `ws` · spawn `grok` |
| 领域模块 | Event Store · Diff Engine · Snapshot · GrokAcpAdapter |
| 桌面 | Tauri 2（P2） |
| 包管理 | pnpm |
| 测试 | Vitest：Adapter 映射、Diff Engine、Snapshot restore、Event Store replay |

---

## 9. Repository layout (target)

```
agent-pane/
  docs/superpowers/specs/
  apps/web/                      # React UI（只认 Command + Domain Event）
  apps/bridge/                   # HTTP/WS 入口 · 组装 domain
  packages/domain-events/        # 事件/命令类型
  packages/event-store/          # append-only jsonl store
  packages/diff-engine/          # git/fs → DiffModel
  packages/workspace-snapshot/   # baseline + restore
  packages/provider-grok-acp/    # GrokAcpAdapter
  packages/provider-api/         # AgentProvider 接口
  src-tauri/                     # P2
  README.md
```

P0 可物理扁平，但 **目录/模块边界必须按上表切开**（即使先 monorepo 单包多文件夹）。

---

## 10. Milestone breakdown

### M0 — Skeleton + spine

- 暗色整窗壳（顶栏 + 消息区 + Composer）
- `domain-events` 类型 + `event-store`（jsonl）
- `provider-api` + `GrokAcpAdapter`：spawn + `initialize` → `SessionStarted`
- Bridge：Command 入口、Event Store append、WS 广播
- UI：订阅事件，显示已连接 / 空会话
- **尚无**完整聊天也没关系，spine 先通

### M1 — Chat loop

- `session.prompt` → `UserMessageAppended` + 流式 `MessageChunk` / `ThoughtChunk` / `MessageDone`
- cancel、cwd、model
- 重连 `session.replay`

### M2 — Agent chrome

- Tool 四态 → ToolTimeline
- Plan → Task* → TodoPanel
- PermissionRequested UI
- `@` / `/` 最小集

### M3 — Diff + Snapshot

- Session 开始 SnapshotTaken
- Diff Engine → DiffProposed + Monaco DiffCard
- Accept / Reject / Keep All（restore from baseline）
- DiffResolved

### M4 — Sessions & polish

- 历史列表、export、错误/重连、快捷键
- 视觉逼近截图
- 可选 EventDebugDrawer

### M5 — Tauri package

- macOS arm64、sidecar Bridge、窗体/图标

---

## 11. Success criteria

哥哥可以：

1. 打开一整窗，绑定项目 cwd。
2. Grok 读/改/跑命令过程 **可视化**（工具时间线 + 消息流）。
3. Diff 基于 **真实工作区相对 baseline** 展示；Accept/Reject **稳定可预期**，不依赖 Grok discard。
4. 刷新页面或重连后，能从 Event Store **replay** 当前会话。
5. 不依赖 Cursor Pro / Claude。
6. 体感是「我的 Agent 窗」，不是网页聊天室。

---

## 12. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| ACP 字段文档不全 | Adapter 内抓包固化映射表；单测锁映射 |
| 过度抽象拖慢首发 | 只实现 Grok Adapter；接口薄；不写假 Provider |
| 非 git 仓库 Snapshot 成本 | 混合策略 C；gitignore；按需备份 |
| Diff 与「未保存缓冲」混淆 | v1 假设写盘；文案写清「工作区变更」 |
| `grok` 路径漂移 | `GROK_BIN`，默认 `~/.grok/bin/grok` |
| 商标/外观 | 自有命名图标；不复制 Cursor 资源 |
| 范围膨胀到 IDE fork | 锁死：独立窗 + Domain 层 + 单 Provider 实现 |

---

## 13. Open decisions (defaulted)

| Topic | Default | 可改 |
|-------|---------|------|
| 产品名 | Agent Pane | 哥哥起名 |
| 主题 | Cursor-like dark | 后加 Nib Glass |
| Transport | stdio 主路径 | serve 备选 |
| Snapshot 策略 | 混合 C（git 优先） | 可强制 A 或 B |
| Event Store 路径 | `~/.agent-pane/sessions/` | 项目内 `.agent-pane/` |
| 自动批准 / auto-keep | 默认关 | UI 开关 |
| 项目路径 | `~/projects/agent-pane` | — |

---

## 14. External review disposition

| 建议 | 处置 |
|------|------|
| Event Store | **采纳 · 必做（M0 spine）** |
| Provider 无关 Event Model | **采纳 · 必做** |
| Diff 不依赖 ACP / 用 Git·FS | **采纳 · 必做（M3，模块 M0 可建空壳）** |
| Workspace Snapshot | **采纳 · 必做（M3，接口 M0 可建）** |
| Tool 统一状态机 | **采纳**（并入 Domain Event） |
| Todo 用 Task Model | **采纳**（薄模型，不绑死 plan） |
| Domain / Adapter 分层 | **采纳**（v1 只写 Grok 实现） |
| Diff Engine 独立模块 | **采纳** |
| 多 Provider 实现 | **不采纳进 v1**（只留接口） |

---

## 15. References

- Cursor Agent UI 截图（2026-07-09）— 视觉基准  
- Cursor.app 逆向：composer/toolFormer 嵌在 workbench；**不 fork，只参考表面**  
- Grok ACP：`~/.grok/docs/user-guide/15-agent-mode.md`  
- Grok headless：`14-headless-mode.md`  
- Nib Glass：`~/UI-Templates/Nib-Glass/nib-glass-style-guide.md`  
- CLI：`~/.grok/bin/grok` · `grok agent stdio|serve|leader`  
- 外部架构评审（2026-07-09）— Event Store / Domain Event / Diff / Snapshot  

---
