import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const entry = path.join(root, "apps/bridge/src/index.ts");
const mcpEntry = path.join(root, "apps/bridge/src/browser-mcp.ts");
const sidecar = path.join(__dirname, "../sidecar/bridge.cjs");
const mcpSidecar = path.join(__dirname, "../sidecar/browser-mcp.cjs");
const resource = path.join(__dirname, "../src-tauri/resources/bridge.cjs");
const mcpResource = path.join(
  __dirname,
  "../src-tauri/resources/browser-mcp.cjs"
);

for (const p of [sidecar, resource, mcpSidecar, mcpResource]) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

const external = ["node-pty", "playwright", "playwright-core"];

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: sidecar,
  packages: "bundle",
  external,
  sourcemap: false,
  logLevel: "info",
});

await esbuild.build({
  entryPoints: [mcpEntry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: mcpSidecar,
  packages: "bundle",
  sourcemap: false,
  logLevel: "info",
});

fs.copyFileSync(sidecar, resource);
fs.copyFileSync(mcpSidecar, mcpResource);
console.log("[bundle-bridge] wrote", sidecar);
console.log("[bundle-bridge] wrote", mcpSidecar);
console.log("[bundle-bridge] copied", resource);
console.log("[bundle-bridge] copied", mcpResource);
