import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");
const entry = path.join(root, "apps/bridge/src/index.ts");
const sidecar = path.join(__dirname, "../sidecar/bridge.cjs");
const resource = path.join(__dirname, "../src-tauri/resources/bridge.cjs");

for (const p of [sidecar, resource]) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: sidecar,
  packages: "bundle",
  sourcemap: false,
  logLevel: "info",
});

fs.copyFileSync(sidecar, resource);
console.log("[bundle-bridge] wrote", sidecar);
console.log("[bundle-bridge] copied", resource);
