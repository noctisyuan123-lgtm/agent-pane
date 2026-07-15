import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** ACP mcpServers entry for the Agent Pane browser tools. */
export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env?: Array<{ name: string; value: string }>;
};

/** Resolve directory of the running bridge script (works in CJS bundle). */
function moduleDir(): string {
  const fromEnv = process.env.AGENT_PANE_BRIDGE_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  // ESM / tsx
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (import.meta?.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    /* CJS bundle: import.meta empty */
  }

  // node bridge.cjs → argv[1]
  const entry = process.argv[1];
  if (entry) {
    try {
      return path.dirname(fs.realpathSync(entry));
    } catch {
      return path.dirname(path.resolve(entry));
    }
  }

  return process.cwd();
}

function resolveBrowserMcpScript(): string | null {
  const fromEnv = process.env.AGENT_PANE_BROWSER_MCP;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const here = moduleDir();
  const candidates = [
    path.join(here, "browser-mcp.cjs"),
    path.join(here, "resources", "browser-mcp.cjs"),
    path.join(here, "..", "browser-mcp.cjs"),
    path.join(here, "..", "resources", "browser-mcp.cjs"),
    path.join(here, "browser-mcp.ts"),
    path.resolve(process.cwd(), "apps/bridge/src/browser-mcp.ts"),
    path.resolve(process.cwd(), "apps/desktop/sidecar/browser-mcp.cjs"),
    path.resolve(
      process.cwd(),
      "apps/desktop/src-tauri/resources/browser-mcp.cjs"
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function browserMcpServers(
  httpBase = `http://${process.env.AGENT_PANE_HOST ?? "127.0.0.1"}:${process.env.AGENT_PANE_PORT ?? "8787"}`
): McpServerConfig[] {
  const script = resolveBrowserMcpScript();
  if (!script) {
    console.warn("[agent-pane] browser-mcp script not found — MCP tools disabled");
    return [];
  }

  const env = [{ name: "AGENT_PANE_HTTP", value: httpBase }];

  if (script.endsWith(".cjs") || script.endsWith(".js")) {
    return [
      {
        name: "agent-pane-browser",
        command: process.execPath,
        args: [script],
        env,
      },
    ];
  }

  // Dev: prefer local tsx binary
  try {
    const req = createRequire(path.resolve(process.cwd(), "package.json"));
    const tsxCli = req.resolve("tsx/cli");
    return [
      {
        name: "agent-pane-browser",
        command: process.execPath,
        args: [tsxCli, script],
        env,
      },
    ];
  } catch {
    return [
      {
        name: "agent-pane-browser",
        command: "npx",
        args: ["tsx", script],
        env,
      },
    ];
  }
}
