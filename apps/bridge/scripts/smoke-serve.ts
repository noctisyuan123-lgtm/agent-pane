/**
 * Smoke: DaemonSupervisor + serve-mode adapter (session/new only).
 *
 *   cd apps/bridge && npx tsx scripts/smoke-serve.ts
 *
 * Uses port 12421 by default so it won't fight a daily daemon on 2419.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonSupervisor } from "../src/daemon-supervisor.js";
import { createGrokServeProvider } from "../src/provider-api.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

process.env.AGENT_PANE_PROVIDER = "serve";
process.env.AGENT_PANE_SERVE_BIND =
  process.env.AGENT_PANE_SERVE_BIND ?? "127.0.0.1:12421";
process.env.AGENT_PANE_SERVE_MANAGE =
  process.env.AGENT_PANE_SERVE_MANAGE ?? "auto";
process.env.AGENT_PANE_SERVE_SECRET =
  process.env.AGENT_PANE_SERVE_SECRET ?? "agent-pane-smoke-secret";

DaemonSupervisor.resetShared();

const provider = await createGrokServeProvider({ autoApprove: true });
provider.onEvent((e) => {
  if (process.env.AGENT_PANE_DEBUG) console.log("event", e.type);
});

const started = await provider.start({
  cwd: repoRoot,
  permissionMode: "auto",
});

console.log("started", {
  id: provider.id,
  domain: started.domainSessionId.slice(0, 8),
  provider: String(started.providerSessionId).slice(0, 8),
  alive: provider.isAlive(),
});

await provider.stop();
const info = DaemonSupervisor.shared().current;
console.log("daemon", {
  bind: info?.bind,
  managed: info?.managed,
  pid: info?.pid,
});
await DaemonSupervisor.shared().shutdown();
console.log("smoke-serve OK");
