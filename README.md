# Agent Pane

整窗 Agent UI（Cursor Agent 布局灵感）+ 本机 **Grok ACP** 后端。

```
React UI  ──WS──►  Bridge  ──Domain Event Store──► UI
                     │
                     ├─ GrokAcpAdapter (stdio)
                     ├─ Workspace Snapshot
                     └─ Diff Engine (git/fs)
```

## 要求

- Node 20+
- 已安装并登录 Grok CLI（`~/.grok/bin/grok`）
- 建议在 **git 仓库** 里工作（Diff / Reject 最稳）

## 启动

```bash
cd ~/projects/agent-pane
npm install
npm run build -w @agent-pane/shared

# 终端 1
npm run dev:bridge

# 终端 2
npm run dev:web
```

浏览器打开：http://127.0.0.1:5173

1. 填工作区绝对路径  
2. 点 **新会话**  
3. 发消息  

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `GROK_BIN` | `~/.grok/bin/grok` | Grok CLI 路径 |
| `AGENT_PANE_PORT` | `8787` | Bridge 端口 |
| `AGENT_PANE_PERMISSION` | `auto` | `auto` 会给 grok `--always-approve` |
| `VITE_BRIDGE_WS` | `ws://127.0.0.1:8787` | 前端 WS |

## 数据目录

- Event Store: `~/.agent-pane/sessions/<id>/events.jsonl`
- Snapshots: `~/.agent-pane/snapshots/<id>/`

## Spec

`docs/superpowers/specs/2026-07-09-agent-pane-design.md`
