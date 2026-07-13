import { z } from "zod";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

/** The channel id used throughout the gateway config (`cfg.channels.quase`). */
export const QUASE_CHANNEL_ID = "quase";

/** Default Quase MCP endpoint (Streamable HTTP). */
export const QUASE_DEFAULT_BASE_URL = "https://quase.social/mcp";

/** Env var the setup wizard prefers for the agent token. */
export const QUASE_TOKEN_ENV_VAR = "QUASE_AGENT_TOKEN";

/** Default and minimum inbound poll interval, in seconds. Shared by the schema and resolver. */
export const DEFAULT_POLL_INTERVAL = 20;
export const MIN_POLL_INTERVAL = 5;

/**
 * The WI-0 config surface for a single Quase account. This Zod schema is the single
 * source of truth; the JSON-Schema in openclaw.plugin.json is verified against it by a
 * parity test (see config.parity.test.ts).
 *
 * - token:           the Quase agent bearer (qse_agt_...). Sensitive; never logged in full.
 * - pollInterval:    seconds between inbound polls.
 * - baseUrl:         Quase MCP endpoint.
 * - allowFrom:       OpenClaw's owner-pin entry for DM routing. Keep this to the single
 *                    owner (a 2nd non-wildcard entry breaks OpenClaw's main-DM owner pin).
 * - respondAllowFrom: the plugin-side respond allowlist, gated in the mapper (separate from
 *                    OpenClaw's allowFrom by design). Entries: a bare handle, a `user_...`
 *                    id, or a `group_...` id. Empty ⇒ owner-only (silence by default).
 */
export const quaseAccountConfigSchema = z.object({
  token: z.string().min(1),
  pollInterval: z.number().int().min(MIN_POLL_INTERVAL).default(DEFAULT_POLL_INTERVAL),
  // zod 4 top-level format helper; chained z.string().url() is deprecated in v4.
  baseUrl: z.url().default(QUASE_DEFAULT_BASE_URL),
  allowFrom: z.array(z.string()).default([]),
  respondAllowFrom: z.array(z.string()).default([]),
});

/** Resolved account config (defaults applied). */
export type QuaseAccountConfig = z.infer<typeof quaseAccountConfigSchema>;

/**
 * The openclaw channel-config schema (JSON Schema + uiHints) built from the Zod schema.
 * `token` is marked sensitive so the gateway UI masks it.
 */
export const quaseChannelConfigSchema = buildChannelConfigSchema(quaseAccountConfigSchema, {
  uiHints: {
    token: { label: "Quase agent token", sensitive: true },
    baseUrl: { label: "Quase MCP endpoint", advanced: true },
    pollInterval: { label: "Inbound poll interval (seconds)", advanced: true },
    respondAllowFrom: { label: "Respond allowlist (handles / user_ / group_ ids)", advanced: true },
  },
});

/**
 * Safe-to-log fingerprint of a token: the last 4 characters only. Never log the full
 * token. Returns "" for an empty/missing token.
 */
export function tokenLast4(token: string | undefined | null): string {
  if (!token) return "";
  return token.length <= 4 ? token : token.slice(-4);
}
