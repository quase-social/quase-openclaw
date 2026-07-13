// Live inbox probe (WI-1 dev-only). Resolves §5.5's two open questions against the real
// Quase API: (a) the `dm_reply` ref_type value + that ref_id is a conv_...; (b) whether
// check_inbox(since=X) is inclusive of X. NOT shipped (not in package.json "files").
//
// Usage:
//   pnpm build && node scripts/probe-inbox.mjs [token]
//   node scripts/probe-inbox.mjs [token] --since 2026-07-05T15:27:58.873432+00:00
//
// Precondition: send the agent a DM AND a reply/@mention first, so the inbox has one of each
// type to inspect. Token: first CLI arg, else $QUASE_AGENT_TOKEN. Base URL: $QUASE_BASE_URL,
// else the default MCP endpoint. Read-only — never advances the watermark.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const distApi = resolve(import.meta.dirname, "../dist/api.js");
if (!existsSync(distApi)) {
  console.error("dist/api.js not found — run `pnpm build` first.");
  process.exit(2);
}

const { QuaseSession, QUASE_DEFAULT_BASE_URL, QUASE_TOKEN_ENV_VAR } = await import(pathToFileURL(distApi).href);

const args = process.argv.slice(2);
const sinceIdx = args.indexOf("--since");
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
const token = (sinceIdx === 0 ? undefined : args[0] && !args[0].startsWith("--") ? args[0] : undefined) ?? process.env[QUASE_TOKEN_ENV_VAR];

if (!token) {
  console.error(`No token. Pass it as an argument or set ${QUASE_TOKEN_ENV_VAR}.`);
  process.exit(2);
}

const baseUrl = process.env.QUASE_BASE_URL ?? QUASE_DEFAULT_BASE_URL;
const cfg = { token, pollInterval: 20, baseUrl, allowFrom: [], respondAllowFrom: [] };
const session = new QuaseSession(cfg, "0.1.0");

try {
  const res = await session.checkInbox(since ? { since, limit: 50 } : { limit: 50 });
  console.log(`server_time: ${res.serverTime}`);
  console.log(`last_seen_inbox_at (watermark): ${res.lastSeenInboxAt}`);
  console.log(`items: ${res.items.length}${since ? ` (since=${since})` : ""}\n`);

  for (const it of res.items) {
    console.log(
      `- [${it.type}] item=${it.itemId} ref_type=${it.refType} ref_id=${it.refId} from=@${it.fromHandle} created=${it.createdAt}`,
    );
  }

  const dmReply = res.items.find((it) => it.type === "dm_reply");
  console.log("\n--- §5.5 findings ---");
  if (dmReply) {
    console.log(`dm_reply ref_type = "${dmReply.refType}"  ref_id = "${dmReply.refId}" (expect a conv_... id)`);
  } else {
    console.log("No dm_reply item present — send the agent a DM first, then re-run.");
  }
  if (since) {
    const boundaryHit = res.items.some((it) => it.createdAt === since);
    console.log(`since=X boundary: an item with created_at === "${since}" ${boundaryHit ? "IS" : "is NOT"} returned ⇒ ${boundaryHit ? "inclusive" : "exclusive"}.`);
  } else {
    console.log("Re-run with `--since <an item's created_at>` to test boundary inclusivity.");
  }
} catch (err) {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await session.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
}
