// Loader-backed smoke test: proves the built plugin "installs and registers cleanly".
//
// It does two independent checks:
//   1. Import check  — import the built dist/index.js default export and assert it is a
//      well-formed channel-plugin entry (id, register, channelPlugin, configSchema) whose
//      channel object exposes a working config adapter. Always runs; headless; no gateway.
//   2. CLI check     — pack the plugin, `openclaw plugins install` the tarball into an
//      isolated state dir, then `openclaw plugins inspect quase --json` and assert the
//      channel loaded/registered from the built dist/index.js. This is the real
//      "installs cleanly" proof.
//
// Exit 0 on success, non-zero (with a message) on any failure.

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

// Build a shell command string (execSync is shell-based by design — avoids the
// shell+args-array deprecation) with each token quoted if it contains whitespace/quotes.
function run(cmd, args, opts = {}) {
  const quoted = [cmd, ...args]
    .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(" ");
  return execSync(quoted, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// ---------------------------------------------------------------------------
// 0. Build
// ---------------------------------------------------------------------------
console.log("• building…");
run("pnpm", ["build"]);

const distIndex = join(repoRoot, "dist", "index.js");
const distSetup = join(repoRoot, "dist", "setup-entry.js");
const distChannel = join(repoRoot, "dist", "src", "channel.js");
const manifest = join(repoRoot, "openclaw.plugin.json");
for (const f of [distIndex, distSetup, distChannel, manifest]) {
  assert(existsSync(f), `expected build artifact missing: ${f}`);
}
console.log("✓ build artifacts present (dist/index.js, dist/setup-entry.js, dist/src/channel.js, manifest)");

// ---------------------------------------------------------------------------
// 1. Import check — the built entry is well-formed and inert-registerable
// ---------------------------------------------------------------------------
const entryMod = await import(pathToFileURL(distIndex).href);
const entry = entryMod.default;
assert(entry && typeof entry === "object", "dist/index.js has no default export object");
assert(entry.id === "quase", `entry.id !== "quase" (got ${JSON.stringify(entry.id)})`);
assert(typeof entry.register === "function", "entry.register is not a function");
assert(entry.channelPlugin && entry.channelPlugin.id === "quase", "entry.channelPlugin.id !== \"quase\"");
assert(entry.configSchema && typeof entry.configSchema === "object", "entry.configSchema missing");

const inspectFn = entry.channelPlugin.config?.inspectAccount;
assert(typeof inspectFn === "function", "channelPlugin.config.inspectAccount is not a function");
const inspection = inspectFn({ channels: { quase: { token: "qse_agt_smoke" } } });
assert(
  inspection && inspection.configured === true && inspection.tokenStatus === "available",
  `inspectAccount did not report a configured account: ${JSON.stringify(inspection)}`,
);
assert(!JSON.stringify(inspection).includes("qse_agt_smoke"), "inspectAccount leaked the token value");

const setupMod = await import(pathToFileURL(distSetup).href);
assert(setupMod.default?.plugin?.id === "quase", "setup-entry default.plugin.id !== \"quase\"");
console.log("✓ import check: built entry + setup entry are well-formed; config adapter works without leaking the token");

// ---------------------------------------------------------------------------
// 2. CLI check — pack, install into isolated state, inspect
// ---------------------------------------------------------------------------
const stateDir = mkdtempSync(join(tmpdir(), "quase-smoke-"));
const configPath = join(stateDir, "config.json");
writeFileSync(configPath, "{}\n");
const cliEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath };

try {
  console.log("• packing…");
  const packOut = run("pnpm", ["pack", "--pack-destination", stateDir]);
  // pnpm prints the tarball path on the last line — absolute when --pack-destination is used.
  const lastLine = packOut.trim().split(/\r?\n/).pop().trim();
  const tgz = isAbsolute(lastLine) ? lastLine : join(stateDir, lastLine);
  assert(existsSync(tgz), `packed tarball not found: ${tgz}`);

  // Precondition (Finding #2): the tarball must ship the built dist/ so an installed
  // package loads runtimeExtensions from JS, not TS source. This is proven end-to-end
  // below: the install + inspect only succeeds if `dist/index.js` shipped and loaded
  // (asserted via plugin.source ending in dist/index.js).
  console.log("• installing into isolated state…");
  run("pnpm", ["exec", "openclaw", "plugins", "install", tgz, "--force"], { env: cliEnv });

  console.log("• inspecting…");
  const inspectJson = run("pnpm", ["exec", "openclaw", "plugins", "inspect", "quase", "--json"], {
    env: cliEnv,
    stdio: ["ignore", "pipe", "ignore"], // JSON on stdout; drop warning noise on stderr
  });
  const parsed = JSON.parse(inspectJson);
  const p = parsed.plugin;
  assert(p, "inspect --json returned no plugin");
  assert(p.id === "quase", `inspect: plugin.id !== "quase" (got ${JSON.stringify(p.id)})`);
  assert(p.status === "loaded", `inspect: plugin.status !== "loaded" (got ${JSON.stringify(p.status)})`);
  assert(Array.isArray(p.channelIds) && p.channelIds.includes("quase"), "inspect: channelIds does not include \"quase\"");
  assert(
    String(p.source).replace(/\\/g, "/").endsWith("dist/index.js"),
    `inspect: plugin.source is not the built dist/index.js (got ${JSON.stringify(p.source)})`,
  );
  console.log(`✓ CLI check: quase channel installed and loaded (status=${p.status}, channelIds=${JSON.stringify(p.channelIds)})`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log("\nSMOKE PASS: the quase channel plugin installs and registers cleanly.");
