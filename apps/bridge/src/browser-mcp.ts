#!/usr/bin/env node
/**
 * Standalone MCP stdio server — proxies browser tools to Agent Pane HTTP API.
 * Bundled to apps/desktop/sidecar/browser-mcp.cjs
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.AGENT_PANE_HTTP ?? "http://127.0.0.1:8787";

const TOOLS = [
  {
    name: "browser_navigate",
    description: "Navigate the Agent Pane browser to a URL (http/https).",
    inputSchema: {
      type: "object" as const,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    description: "Accessibility / text snapshot of the current page.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "browser_click",
    description: "Click an element by CSS selector.",
    inputSchema: {
      type: "object" as const,
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    name: "browser_type",
    description: "Type text into an element by CSS selector.",
    inputSchema: {
      type: "object" as const,
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browser_screenshot",
    description: "Screenshot the current page (returns base64 PNG).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "browser_back",
    description: "Go back in browser history.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  return res.json();
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "browser_navigate": {
      const data = await apiPost("/api/browser/navigate", { url: args.url });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    case "browser_back": {
      const data = await apiPost("/api/browser/back");
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    case "browser_screenshot": {
      const data = (await apiPost("/api/browser/screenshot")) as {
        screenshotBase64?: string;
      };
      return {
        content: [
          {
            type: "text",
            text: data.screenshotBase64
              ? `screenshot ok (${data.screenshotBase64.length} chars base64)`
              : JSON.stringify(data),
          },
        ],
      };
    }
    case "browser_snapshot": {
      const data = (await apiPost("/api/browser/snapshot")) as {
        snapshot?: string;
      };
      return {
        content: [{ type: "text", text: String(data.snapshot ?? "") }],
      };
    }
    case "browser_click": {
      const data = await apiPost("/api/browser/click", {
        selector: args.selector,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    case "browser_type": {
      const data = await apiPost("/api/browser/type", {
        selector: args.selector,
        text: args.text,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: "agent-pane-browser", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await callTool(request.params.name, args);
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: e instanceof Error ? e.message : String(e),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((e) => {
  console.error("[browser-mcp]", e);
  process.exit(1);
});
