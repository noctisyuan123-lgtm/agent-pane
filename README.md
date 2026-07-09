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

1. 点 **打开项目…** / 顶栏 **选择**（系统文件夹对话框）或左侧 Recent/Projects  
2. 中间输入框写需求，点 **Start**（自动新会话 + 发送）  
3. 或先 **New Agent** 再聊  

> **和 Grok Build 的关系：** Agent Pane 走的是 CLI 里的 `grok agent stdio`（ACP 协议），**不依赖** Grok Build TUI 菜单里有没有「Agent 模式」。只要 `~/.grok/bin/grok` 能登录、能跑 agent 即可。 

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
