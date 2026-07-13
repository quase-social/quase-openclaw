// Live connectivity probe (the "verify/doctor" surface for WI-0).
//
// openclaw's channel `doctor` adapter is a config-repair surface, not a live-network probe,
// so the authenticated whoami check lives here (and in the exported verifyConnectivity()).
//
// Usage:
//   pnpm build && node scripts/verify-connectivity.mjs [token]
// Token resolution: first CLI arg, else $QUASE_AGENT_TOKEN. Base URL: $QUASE_BASE_URL,
// else the default MCP endpoint. Exits 0 only when connected as an agent.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distApi = resolve(import.meta.dirname, "../dist/api.js");
if (!existsSync(distApi)) {
  console.error("dist/api.js not found — run `pnpm build` first.");
  process.exit(2);
}

const { verifyConnectivity, describeConnectivity, QUASE_DEFAULT_BASE_URL, QUASE_TOKEN_ENV_VAR } = await import(
  pathToFileURL(distApi).href
);

const token = process.argv[2] ?? process.env[QUASE_TOKEN_ENV_VAR];
if (!token) {
  console.error(`No token. Pass it as an argument or set ${QUASE_TOKEN_ENV_VAR}.`);
  process.exit(2);
}

const baseUrl = process.env.QUASE_BASE_URL ?? QUASE_DEFAULT_BASE_URL;
const cfg = { token, pollInterval: 20, baseUrl, allowFrom: [] };

const result = await verifyConnectivity(cfg, "0.1.0");
console.log(describeConnectivity(result));
// Set the exit code and let the event loop drain so the MCP transport tears down
// gracefully. A forced process.exit() here races the transport's async close and trips a
// libuv assertion on Windows after a half-open (401) connect. A safety net force-exits if
// a keep-alive socket lingers past the grace window.
process.exitCode = result.status === "connected" ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 3000).unref();
