# Wave 4 — `grok agent serve`（Daemon ACP）完整规划

**Date:** 2026-07-16  
**Status:** Design + **implementation in progress** (W4-B…F code landed 2026-07-16; smoke `apps/bridge/scripts/smoke-serve.ts`)  
**Parent:** [`docs/architecture-agent-core-multi-front.md`](../../architecture-agent-core-multi-front.md) rev 3  
**Prerequisite:** Phase 0 Wave 1–3 landed  
（session 身份 · `AgentProvider` Host 契约 · `acp-text` / `acp-stdio-transport` · `createAgentProvider` 工厂）  
**Upstream pin:** Grok CLI **0.2.101**（`~/.grok/bin/grok`）  
**Naming:** `serve`（不是 studio / server 产品名）。CLI：`grok agent serve`。

---

## 0. 为什么现在做（动机，不是情怀）

| 今天的痛 | stdio 现状 | serve 能解什么 |
|----------|------------|----------------|
| 多 live 会话 | 每个 Pane session 一个 `GrokAcpAdapter` → **一个 child process** | 一个 daemon 上多 `session/new`，少 N 次冷启动 |
| 切会话 / 重发 | 每次 resume ≈ spawn + `initialize` + `session/new` | daemon 常驻；reconnect 后可续 in-flight（上游文档承诺） |
| Bridge 重启 | 子进程全死 | daemon 可独立于 Bridge 存活（可选外部托管） |
| 适配器膨胀 | 进程生命周期绑死在 adapter | 进程生命周期上提到 **DaemonSupervisor**；adapter 只当 ACP 客户端 |

**不是目标：** 用 serve 重写 agent loop、取代 Bridge、或默认改成远程公网代理。

**与 local-gate 一致：** serve 仍是 **out-of-process Core**（优先级 2），不是 embed。  
进程边界：`UI → Bridge(8787) → Daemon(2419) → tools/hooks`。

---

## 1. 上游事实（已探针，0.2.101）

### 1.1 CLI

```bash
grok agent serve --bind 127.0.0.1:2419 --secret <token>
# env: GROK_AGENT_SECRET
# --remote / --grok-ws-* : 中继模式，本规划默认不做
```

启动横幅（实测）：

```
Address:  127.0.0.1:2419
Secret:   <token>
WebSocket URL: ws://127.0.0.1:2419/ws?server-key=<token>
```

### 1.2 握手（2026-07-16 本机探针）

| 项 | 结论 |
|----|------|
| Path | **`/ws?server-key=<secret>`**（根路径 404；**不是** `Authorization: Bearer`） |
| 帧格式 | **一条 WebSocket text frame = 一个 JSON-RPC 对象**（无需再拼 newline；与 stdio 的 NDJSON 不同） |
| 协议 | 与 stdio **同一套 ACP**：`initialize` → `session/new` → `session/prompt` / `session/update` |
| Auth | `initialize` 返回 `authMethods: [cached_token, grok.com]`，`defaultAuthMethodId: "cached_token"`；有 `~/.grok/auth.json` 时可直接 `session/new` |
| 多会话 | 标准 ACP：同一连接上可多次 `session/new`（实现时用 checklist 验证并发） |
| 重连 | 官方文档：agent 跨重连持久；in-flight 可续。**仍需我方 checklist 验证**，不可当口号 |

### 1.3 与 `leader` 的区别（勿混）

| 模式 | 传输 | 用途 |
|------|------|------|
| **stdio** | 子进程 stdin/stdout | 今天默认；一会话一进程 |
| **serve** | localhost WebSocket ACP | 本规划；长生命周期 daemon |
| **leader** | `~/.grok/leader.sock` 等 | 多 CLI 客户端共享后端；**不是** Pane 第二 Provider |
| **headless + relay** | 出站连公网/中继 | 浏览器远程场景；**非 v1** |

v1 **只做 serve**。leader / relay 写在 Non-goals。

---

## 2. 目标拓扑

### 2.1 进程图（目标）

```
  Web / Tauri WebView
           │  WS+HTTP  127.0.0.1:8787
           ▼
    ┌──────────────────────────────┐
    │  Bridge (Pane Host)          │
    │  SessionManager              │
    │  EventStore / history        │
    │  Customize / PTY / …         │
    │                              │
    │  DaemonSupervisor  ──────────┼── spawn|adopt `grok agent serve`
    │  AcpWsTransport    ──────────┼── ws://127.0.0.1:2419/ws?server-key=…
    │  DaemonAcpProvider[] ────────┤   每 live Pane session 一个 Provider 视图
    └──────────────▲───────────────┘   共享一条（或有限条）daemon 连接
                   │ ACP JSON-RPC
                   ▼
         grok agent serve (0.2.101)
         Core: sessions · tools · hooks
```

### 2.2 与今天对比

```
Today (stdio):
  LiveSession A → GrokAcpAdapter A → child A
  LiveSession B → GrokAcpAdapter B → child B

Serve (target):
  DaemonSupervisor → 1× (or pool) serve process
  LiveSession A → DaemonAcpProvider A ─┐
  LiveSession B → DaemonAcpProvider B ─┴→ shared AcpWsTransport / connection pool
```

### 2.3 身份法则（继承 Phase 0，不重写）

| ID | serve 下变化？ |
|----|----------------|
| Pane `sessionId` **A** | **不变** — 唯一 UI / EventStore 键 |
| `providerSessionId` **B** | 仍是 Core 句柄；resume 策略 **继续** `session/new` + digest（直到单独项目证明 `session/load` 可靠） |
| daemon 连接 | **不是** session id；属于 Host 连接池 |

---

## 3. 设计决策（锁死，避免半吊子）

### D1 — 默认仍是 stdio；serve 显式打开

| 开关 | 值 |
|------|-----|
| `AGENT_PANE_PROVIDER` | `stdio`（默认）/ `serve` / `daemon`（别名） |
| 可选细化 | `AGENT_PANE_SERVE_URL` · `AGENT_PANE_SERVE_SECRET` · `AGENT_PANE_SERVE_BIND` · `AGENT_PANE_SERVE_MANAGE=auto\|external\|off` |

**产品默认不切 serve**，直到 smoke 清单全绿。开发 / 重度多开会话可开。

### D2 — Daemon 生命周期：`auto` 优先

| 模式 | 行为 |
|------|------|
| **`auto`（推荐默认）** | Bridge 启动时：若 `bind` 上已有健康 serve 且 secret 匹配 → **adopt**；否则 **spawn** 子进程，Bridge 退出时 **可选** kill（见 D3） |
| **`external`** | 只连接；不 spawn、不 kill。适合哥哥长期挂着 daemon |
| **`off`** | 强制 stdio（忽略 `AGENT_PANE_PROVIDER=serve` 的误配时 fallback 策略见 §7） |

### D3 — Bridge 退出是否杀 daemon

| 策略 | 何时 |
|------|------|
| **spawned-by-us → kill on Bridge exit** | `auto` 且我们 spawn 的 |
| **adopted / external → never kill** | 别人起的或 external 模式 |
| 写 pid + secret 到 `~/.agent-pane/daemon.json`（mode, pid, bind, secret-hash, startedAt） | 便于 adopt / 排障；**secret 明文仅内存 + 进程 env，磁盘只存 hash 或 keychain 路径** |

### D4 — 连接与会话基数

| 层 | 基数 |
|----|------|
| Serve 进程 | **1**（本机 Pane 默认；不做多 daemon 分片 v1） |
| WebSocket 连接 | **1 条共享**（**required** on 0.2.101）。实测多 WS 时 update 只打到一条连接、另一条 `session/prompt` 超时——不可用「每 live 一条」。demux 靠 `params.sessionId` |
| `DaemonAcpProvider` 实例 | **每 live Pane session 一个**（对齐 `SessionManager.live`） |
| Core `sessionId` B | 每 `start()` 一次 `session/new` |

这样 Host 代码几乎不改：`createAgentProvider()` 仍返回 `AgentProvider`；只是底层共享 transport。

### D5 — Transport 抽象（Wave 3 的真正收获点）

今天：`AcpStdioTransport` 绑死 `ChildProcess`。  
Wave 4：抽 **无 I/O 语义接口**：

```ts
// apps/bridge/src/acp-transport.ts
export interface AcpTransport {
  isAlive(): boolean;
  send(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  reply(id: number | string, result: unknown): void;
  replyError(id: number | string, message: string, code?: number): void;
  setHandlers(handlers: AcpHandlers): void;
  /** Close this client view; may or may not tear down shared socket. */
  close(): void;
}
```

| 实现 | 底层 |
|------|------|
| `AcpStdioTransport` | child stdio NDJSON（现有，实现 interface） |
| `AcpWsTransport` | `ws` text frames + 同一 pending-id 表 |

**Domain 映射（`acp-text` + adapter 事件映射）禁止分叉两份。**  
目标结构：

```
GrokAcpSession  (shared: map ACP ↔ DomainEvent, rewind, permissions)
   ├─ uses AcpTransport
   │
GrokAcpAdapter     = packaging (PATH, always-approve flags) + stdio spawn + GrokAcpSession
DaemonAcpProvider  = packaging (secret, reconnect) + shared WS + GrokAcpSession
```

若抽取成本过高，**允许 v1 复制最少 glue**，但 **事件映射函数必须复用** `acp-text` + 现有 map 函数（禁止第三份 `switch (sessionUpdate)`）。

### D6 — 安全（硬约束）

1. **只绑 `127.0.0.1`**（默认 `2419`；可用 env 改，禁止 `0.0.0.0` 除非显式 `AGENT_PANE_SERVE_ALLOW_LAN=1` 且文档警告）。  
2. **必须有 secret**；spawn 时由 Bridge 生成 cryptographically random（≥32 bytes hex），经 `GROK_AGENT_SECRET` 注入子进程。  
3. Secret **不下发 UI**、不进 DomainEvent、不进 git。  
4. URL 形态固定：`ws://127.0.0.1:${port}/ws?server-key=${secret}`。  
5. 日志：允许打 bind / pid / “connected”；**禁止**打完整 secret 或 query string。  
6. 与产品设计一致：serve **必须**带 secret（见 `2026-07-09-agent-pane-design.md` §7）。

### D7 — Resume / load 策略不在本波重开

- 保持 Phase 0：**resume = `session/new` + history digest**。  
- `session/load` 仍单独可靠性项目（历史 hang）。  
- serve 的「跨重连 persist」指 **daemon 进程与 in-flight 工具**，不是偷偷改成 `session/load`。

### D8 — 失败回退

| 失败 | 行为 |
|------|------|
| serve spawn 失败 / port 占用且 secret 不匹配 | 明确错误；**可选** `AGENT_PANE_SERVE_FALLBACK_STDIO=1` 时降级 stdio 并 `status` 广播 |
| WS 断线 | 指数退避重连（上限 N）；live sessions 标记 degraded；重连成功后 **不自动** 假设 B 仍有效 → 按现有 resume 路径 `session/new`+digest |
| `initialize` 协议不兼容 | fail loud（pin 策略） |

---

## 4. 模块与文件落点

| 路径 | 职责 |
|------|------|
| `apps/bridge/src/acp-transport.ts` | `AcpTransport` / `AcpHandlers` 类型 |
| `apps/bridge/src/acp-stdio-transport.ts` | 实现 interface；行为不变 |
| `apps/bridge/src/acp-ws-transport.ts` | **新建** WS JSON-RPC |
| `apps/bridge/src/daemon-supervisor.ts` | **新建** spawn / adopt / health / secret / pid file |
| `apps/bridge/src/daemon-acp-provider.ts` | **新建** `implements AgentProvider` |
| `apps/bridge/src/grok-acp-session.ts` | **可选抽取** 共享 session 逻辑（若 v1 不做完整抽取，则 Daemon 调共用 map 函数） |
| `apps/bridge/src/provider-api.ts` | `createAgentProvider` 真正分支到 serve |
| `apps/bridge/src/session-manager.ts` | 尽量零改；最多注入 shared supervisor 引用 |
| `docs/.../phase0-...md` | Wave 4 勾 done |
| `README.md` | serve 开关与安全说明 |
| `~/.agent-pane/daemon.json` | 运行时状态（gitignore 已有 `~/.agent-pane`） |

**不碰：** glass UI、Customize、ports `8787` 协议、WebView。

---

## 5. 关键路径（序列）

### 5.1 Bridge 启动（`auto`）

```
1. read env: PROVIDER=serve, BIND, SECRET?, MANAGE=auto
2. DaemonSupervisor.ensure():
   a. if port open:
        - probe WS with candidate secret (env or daemon.json)
        - initialize ping → ok? adopt
        - else: error "port busy, foreign process"
   b. else:
        - generate secret if missing
        - spawn: grok agent serve --bind 127.0.0.1:PORT --secret ...
        - wait listen + optional initialize probe (timeout 10s)
3. cache shared AcpWsTransport (lazy connect on first session)
```

### 5.2 `createSession` / resume

```
SessionManager:
  adapter = await createAgentProvider(...)  // returns DaemonAcpProvider bound to shared supervisor
  adapter.start({ cwd, domainSessionId, ... })
    → ensure WS connected + initialize once per connection
    → session/new { cwd, mcpServers? }
    → map providerSessionId B
    → emit SessionStarted (A only on wire)
```

### 5.3 Prompt / permission / cancel

与 stdio 路径 **同一** DomainEvent 映射；仅 transport 不同。

### 5.4 `stop()` 语义

| 调用 | 含义 |
|------|------|
| `provider.stop()` | 结束 **该** Core session（若上游有 `session/cancel` / close；否则 best-effort + 本地 live 移除） |
| Bridge shutdown | 关 WS；若 spawned-by-us → kill serve |
| **不要** 在单个 Pane session 关闭时杀掉整个 daemon |

### 5.5 重连

```
WS close → Supervisor.reconnect()
  → 所有 live DaemonAcpProvider.onDead? 或 mark needsResume
  → 下一次 sendPrompt：走 SessionManager 现有 “not alive → resumeSession” 路径
```

与 stdio child 死的体验对齐，避免 serve 特殊 UI。

---

## 6. PR 切片（可合并、可回滚）

| PR | 标题 | 范围 | 完成定义 |
|----|------|------|----------|
| **W4-A** | docs: serve plan + pin notes | 本文 + phase0 / architecture 链接 | 文档 merge |
| **W4-B** | refactor: `AcpTransport` interface | stdio 适配 interface；无行为变化 | 现有 stdio 全绿 |
| **W4-C** | feat: `AcpWsTransport` + probe script | 单元/脚本：initialize + session/new 对真实 0.2.101 | 探针脚本 CI 可选手动 |
| **W4-D** | feat: `DaemonSupervisor` | spawn/adopt/pid/secret/health | 独立可测 |
| **W4-E** | feat: `DaemonAcpProvider` | 实现 `AgentProvider`；复用事件映射 | 单会话 prompt 端到端 |
| **W4-F** | feat: factory + multi-live | `createAgentProvider` 接线；双 session 并行 | multitask smoke |
| **W4-G** | chore: README + fallback + status | 开关文档、降级、status 文案 | 可给哥哥日常开 |

**建议顺序：** A → B → C → D → E → F → G。  
**不要**把 C–E 揉进一个巨型 PR。

**Stop line for “serve usable”:** W4-E 单会话稳定 + W4-F 双会话不串线。

---

## 7. 验收清单（必须手跑 / 可后自动化）

### 7.1 协议 / 安全

- [ ] `ws://127.0.0.1:2419/ws?server-key=…` 连通；错误 secret → 拒绝  
- [ ] 仅 `127.0.0.1` listen  
- [ ] 日志无 secret 明文  
- [ ] `initialize` 后 capabilities 与 stdio 同 pin 可接受（记录 diff）

### 7.2 单会话 parity（对照 stdio）

- [ ] New Agent → 首条 prompt → MessageChunk / tools / MessageDone  
- [ ] PermissionRequested → UI allow/deny → 继续  
- [ ] Cancel 中途 prompt  
- [ ] Undo / rewind：Host 截断 + provider best-effort（允许 providerOk false，行为与 stdio 一致）  
- [ ] Context usage：live → meta 解析仍正确  
- [ ] 历史打开不 spawn；Send 时 resume = new B + digest  

### 7.3 多会话 / 生命周期

- [ ] 两个 live 并行 prompt，事件 `sessionId` 不串  
- [ ] 关一个 Pane session，另一个仍活；**daemon 进程仍在**  
- [ ] 杀 Bridge（spawned-by-us）→ daemon 退出；external 模式 → daemon 仍在  
- [ ] 断 WS 后重连 → 下一 prompt 走 resume 路径不崩  

### 7.4 回归

- [ ] `AGENT_PANE_PROVIDER` 未设置 → 行为与今天完全一致（stdio）  
- [ ] pin 0.2.101；升级需单独 PR  

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|------|------|------|
| 单 WS 上多 session 并发 prompt 被上游串行/互斥 | 中 | 先测；不行则每 live 一连接（D4 v1.1） |
| 重连后 in-flight 状态与 Pane EventStore 分叉 | 中 | 不宣称透明续传；统一走 dead→resume |
| secret 出现在进程列表 / 日志 | 中 | env 注入；日志脱敏；文档警告 `ps` 可见性 |
| port `2419` 与其他工具冲突 | 低 | env 可配；adopt 前 probe |
| 映射逻辑复制漂移 | 高 | D5 强制共用 map；code review 门禁 |
| `session/load` 诱惑 | 中 | D7 明文禁止本波重开 |
| serve 成为默认导致调试变难 | 低 | 默认 stdio；status 显示 provider mode |

---

## 9. Non-goals（本波明确不做）

1. In-process `EmbeddedCoreProvider`  
2. `grok agent leader` / unix socket 多客户端  
3. `headless` + 公网 WebSocket relay  
4. 浏览器直连 serve（绕过 Bridge）— 破坏 DomainEvent / 权限 UX / local-gate  
5. 改 UI glass / traffic lights  
6. 修复 `session/load` hang  
7. 级联删除 `~/.grok/sessions`  
8. 把 Customize hooks 执行搬进 Bridge  

---

## 10. 环境变量一览（实现契约）

| 变量 | 默认 | 含义 |
|------|------|------|
| `AGENT_PANE_PROVIDER` | `stdio` | `stdio` \| `serve` \| `daemon` |
| `AGENT_PANE_SERVE_BIND` | `127.0.0.1:2419` | serve listen |
| `AGENT_PANE_SERVE_SECRET` | （auto 生成） | 覆盖自动 secret |
| `AGENT_PANE_SERVE_MANAGE` | `auto` | `auto` \| `external` \| `off` |
| `AGENT_PANE_SERVE_FALLBACK_STDIO` | `0` | serve 失败时是否降级 |
| `GROK_BIN` | `~/.grok/bin/grok` | 与现网一致 |
| `GROK_AGENT_SECRET` | — | 传给子进程；与 Pane secret 同源 |

---

## 11. 工作量粗估（一个人 / 妹妹带小兵）

| 切片 | 量级 |
|------|------|
| W4-A 文档 | 0.5d（本文） |
| W4-B transport interface | 0.5–1d |
| W4-C WS transport + 探针 | 1d |
| W4-D supervisor | 1d |
| W4-E provider + 单会话 | 1.5–2d |
| W4-F multi-live + factory | 1d |
| W4-G 文档/降级/抛光 | 0.5d |
| **合计** | **约 6–8 聚焦日**（不含 `session/load` 大坑） |

---

## 12. 成功一句话

> **在不破坏 Phase 0 身份法则、不默认 embed、不重写 UI 的前提下，  
> 用 `grok agent serve` 作为第二 `AgentProvider` 实现：  
> 长生命周期 Core + 共享 ACP 连接 + 与 stdio 同构的 DomainEvent，  
> 开关可控、可回退、可验收。**

---

## Related

- Phase 0: [`2026-07-16-phase0-session-id-provider.md`](./2026-07-16-phase0-session-id-provider.md)  
- Architecture: [`architecture-agent-core-multi-front.md`](../../architecture-agent-core-multi-front.md)  
- Product security note: [`2026-07-09-agent-pane-design.md`](./2026-07-09-agent-pane-design.md) §7  
- ACP research: [`docs/research/acp-resume-patterns.md`](../../research/acp-resume-patterns.md)  
- Upstream: `~/.grok/docs/user-guide/15-agent-mode.md`（Server mode）  
- Code: `provider-api.ts`, `acp-stdio-transport.ts`, `grok-acp-adapter.ts`, `session-manager.ts`

### Changelog

| Rev | Note |
|-----|------|
| 1 | Initial full plan; WS URL / framing verified on grok 0.2.101 local probe |
