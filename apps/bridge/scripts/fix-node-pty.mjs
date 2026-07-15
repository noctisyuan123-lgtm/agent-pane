#!/usr/bin/env node
/** Ensure node-pty spawn-helper is executable (npm packs it without +x). */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

try {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  const prebuilds = path.join(root, "prebuilds");
  if (!fs.existsSync(prebuilds)) process.exit(0);
  for (const plat of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, plat, "spawn-helper");
    if (fs.existsSync(helper)) {
      fs.chmodSync(helper, 0o755);
      console.log("[fix-node-pty] chmod +x", helper);
    }
  }
} catch (e) {
  console.warn("[fix-node-pty]", e instanceof Error ? e.message : e);
}
