import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-runtime";
import {
  quaseChannelConfigSchema,
  QUASE_CHANNEL_ID,
  QUASE_DEFAULT_BASE_URL,
  QUASE_TOKEN_ENV_VAR,
  DEFAULT_POLL_INTERVAL,
  MIN_POLL_INTERVAL,
  tokenLast4,
  type QuaseAccountConfig,
} from "./config.js";
import { QuaseSession } from "./quase-client.js";
import { buildQuaseDispatch } from "./dispatch.js";
import { startQuasePoller } from "./poller.js";

export { QUASE_CHANNEL_ID };

/** MCP client name/version presented to Quase (cosmetic identity on the transport). */
const QUASE_CLIENT_VERSION = "0.1.0";

/** Account id used when the channel is configured single-account (no named accounts). */
export const DEFAULT_ACCOUNT_ID = "default";

/** A resolved Quase account: the config surface plus the account id it came from. */
export interface QuaseResolvedAccount extends QuaseAccountConfig {
  accountId?: string | null;
}

/** What {@link inspectAccount} reports — status only, never the token value. */
export interface QuaseAccountInspection {
  enabled: boolean;
  configured: boolean;
  tokenStatus: "available" | "missing";
}

type ConfigRecord = Record<string, unknown>;

/** The `channels.quase` block, if present, as an open record. */
function readChannelSection(cfg: OpenClawConfig): ConfigRecord | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = channels?.[QUASE_CHANNEL_ID];
  return section && typeof section === "object" ? (section as ConfigRecord) : undefined;
}

/**
 * The effective account block: a named account (`channels.quase.accounts.<id>`) merged
 * over the channel-level defaults, or the channel-level block for the single-account case.
 */
function readAccountBlock(cfg: OpenClawConfig, accountId?: string | null): ConfigRecord {
  const section = readChannelSection(cfg);
  if (!section) return {};
  const accounts = section.accounts as Record<string, unknown> | undefined;
  const id = accountId ?? undefined;
  if (
    id &&
    id !== DEFAULT_ACCOUNT_ID &&
    accounts &&
    typeof accounts === "object" &&
    accounts[id] &&
    typeof accounts[id] === "object"
  ) {
    return { ...section, ...(accounts[id] as ConfigRecord) };
  }
  return section;
}

/**
 * Resolve the token to a literal string. Accepts: a literal string; a `$NAME`/`${NAME}`
 * env template; an env SecretRef (`{ source: "env", id }`) as written by the wizard's
 * applyUseEnv; and falls back to the QUASE_AGENT_TOKEN env var when the config token is
 * blank. Returns "" when no token is available anywhere.
 */
function resolveTokenValue(block: ConfigRecord): string {
  const raw = block.token;

  if (typeof raw === "string" && raw.trim() !== "") {
    const tpl = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    if (tpl) {
      const fromEnv = process.env[tpl[1]];
      if (fromEnv && fromEnv.trim() !== "") return fromEnv;
    } else {
      return raw;
    }
  }

  if (raw && typeof raw === "object") {
    const ref = raw as { source?: unknown; id?: unknown };
    if (ref.source === "env" && typeof ref.id === "string") {
      const fromEnv = process.env[ref.id];
      if (fromEnv && fromEnv.trim() !== "") return fromEnv;
    }
  }

  const fallback = process.env[QUASE_TOKEN_ENV_VAR];
  return fallback && fallback.trim() !== "" ? fallback : "";
}

function coerceInt(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return n;
}

/**
 * ChannelConfigAdapter.resolveAccount — read-time resolver. Never throws on a missing
 * token (the channel is inert; a missing/invalid token is reported by verifyConnectivity),
 * so `token` may be "".
 */
function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): QuaseResolvedAccount {
  const block = readAccountBlock(cfg, accountId);
  const baseUrl =
    typeof block.baseUrl === "string" && block.baseUrl.trim() !== "" ? block.baseUrl : QUASE_DEFAULT_BASE_URL;
  const allowFrom = Array.isArray(block.allowFrom)
    ? block.allowFrom.filter((x): x is string => typeof x === "string")
    : [];
  const respondAllowFrom = Array.isArray(block.respondAllowFrom)
    ? block.respondAllowFrom.filter((x): x is string => typeof x === "string")
    : [];
  return {
    token: resolveTokenValue(block),
    pollInterval: coerceInt(block.pollInterval, DEFAULT_POLL_INTERVAL, MIN_POLL_INTERVAL),
    baseUrl,
    allowFrom,
    respondAllowFrom,
    accountId: accountId ?? null,
  };
}

/** ChannelConfigAdapter.listAccountIds — named accounts, else the single default account. */
function listAccountIds(cfg: OpenClawConfig): string[] {
  const section = readChannelSection(cfg);
  if (!section) return [];
  const accounts = section.accounts as Record<string, unknown> | undefined;
  if (accounts && Object.keys(accounts).length > 0) return Object.keys(accounts);
  return [DEFAULT_ACCOUNT_ID];
}

/**
 * ChannelConfigAdapter.inspectAccount — status without materializing the secret. Reports
 * `configured`/`tokenStatus` based on whether a token resolves (from config OR env), and
 * NEVER returns the token value itself.
 */
function inspectAccount(cfg: OpenClawConfig, accountId?: string | null): QuaseAccountInspection {
  const block = readAccountBlock(cfg, accountId);
  const hasToken = resolveTokenValue(block) !== "";
  const enabled = block.enabled !== false;
  return {
    enabled,
    configured: hasToken,
    tokenStatus: hasToken ? "available" : "missing",
  };
}

// The setup `input` bag (openclaw's ChannelSetupInput) is wide; WI-0 only reads these keys.
interface QuaseSetupInput {
  token?: string;
  baseUrl?: string;
  useEnv?: boolean;
}

function cloneConfig(cfg: OpenClawConfig): OpenClawConfig {
  return structuredClone(cfg);
}

/** Get (creating if needed) the write target block for an account inside a cloned config. */
function ensureTargetBlock(cfg: OpenClawConfig, accountId: string): ConfigRecord {
  const root = cfg as { channels?: Record<string, ConfigRecord> };
  const channels = (root.channels ??= {});
  const section = (channels[QUASE_CHANNEL_ID] ??= {});
  if (accountId && accountId !== DEFAULT_ACCOUNT_ID) {
    const accounts = ((section.accounts as Record<string, ConfigRecord>) ??= {} as Record<string, ConfigRecord>);
    return (accounts[accountId] ??= {});
  }
  return section;
}

/**
 * ChannelSetupAdapter.applyAccountConfig — write token (and baseUrl if provided) into the
 * config. Note: openclaw's ChannelSetupInput has no `pollInterval` field, so pollInterval
 * is not written here; it stays at the schema default unless set directly in config.
 */
function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: QuaseSetupInput;
}): OpenClawConfig {
  const { accountId, input } = params;
  const next = cloneConfig(params.cfg);
  const target = ensureTargetBlock(next, accountId);
  if (typeof input.token === "string" && input.token.trim() !== "") {
    target.token = input.token;
  }
  if (typeof input.baseUrl === "string" && input.baseUrl.trim() !== "") {
    target.baseUrl = input.baseUrl;
  }
  return next;
}

/** ChannelSetupAdapter.validateInput — require a token unless the env var is being used. */
function validateInput(params: { cfg: OpenClawConfig; accountId: string; input: QuaseSetupInput }): string | null {
  const { input } = params;
  if (input.useEnv) return null;
  if (typeof input.token !== "string" || input.token.trim() === "") {
    return `A Quase agent token is required. Mint one with create_agent on Quase, or set ${QUASE_TOKEN_ENV_VAR}.`;
  }
  return null;
}

/** Write an env SecretRef into config so resolveAccount reads the token from the env var. */
function applyEnvRef(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const next = cloneConfig(cfg);
  const target = ensureTargetBlock(next, accountId);
  target.token = { source: "env", provider: "default", id: QUASE_TOKEN_ENV_VAR };
  return next;
}

/**
 * Non-network setup wizard. Reports configured/unconfigured status and prompts for the
 * token (or the QUASE_AGENT_TOKEN env var). The live whoami probe is intentionally NOT
 * here — it lives in the exported verifyConnectivity() so onboarding stays fast/offline.
 */
const quaseSetupWizard: ChannelSetupWizard = {
  channel: QUASE_CHANNEL_ID,
  status: {
    configuredLabel: "Configured",
    unconfiguredLabel: "Needs a Quase agent token",
    resolveConfigured: ({ cfg, accountId }) => inspectAccount(cfg, accountId ?? null).configured,
  },
  credentials: [
    {
      inputKey: "token",
      providerHint: "Quase",
      credentialLabel: "Quase agent token",
      preferredEnvVar: QUASE_TOKEN_ENV_VAR,
      envPrompt: `Use the ${QUASE_TOKEN_ENV_VAR} environment variable for the Quase agent token?`,
      keepPrompt: "Keep the existing Quase agent token?",
      inputPrompt: "Paste the Quase agent token (qse_agt_...):",
      allowEnv: () => true,
      inspect: ({ cfg, accountId }) => {
        const block = readAccountBlock(cfg, accountId);
        const literal = typeof block.token === "string" ? block.token : "";
        const hasRef = block.token != null && typeof block.token === "object";
        const envValue = process.env[QUASE_TOKEN_ENV_VAR];
        const resolved = resolveTokenValue(block);
        return {
          accountConfigured: resolved !== "",
          hasConfiguredValue: literal.trim() !== "" || hasRef,
          resolvedValue: resolved || undefined,
          envValue: envValue || undefined,
        };
      },
      applyUseEnv: ({ cfg, accountId }) => applyEnvRef(cfg, accountId),
    },
  ],
};

// WI-1: DMs are "direct"; post threads are isolated "channel"-kind sessions keyed by the
// top-level post. `threads: true` is honest advertising (isolation actually comes from the
// channel-kind peer key). (ChatType = "direct"|"group"|"channel".)
const quaseCapabilities = {
  chatTypes: ["direct", "channel"] as ("direct" | "channel")[],
  media: false,
  reactions: false,
  threads: true,
};

const quaseConfigAdapter = { listAccountIds, resolveAccount, inspectAccount };

/**
 * gateway.startAccount — the per-account inbound poll loop (WI-1). Opens a persistent Quase
 * session, builds the dispatch closure, and runs the poller until `ctx.abortSignal` aborts
 * (the promise this returns resolves on teardown). An unconfigured account (no token) stays
 * idle. Never logs the token — only its last-4 fingerprint.
 */
async function startAccount(ctx: ChannelGatewayContext<QuaseResolvedAccount>): Promise<void> {
  const account = ctx.account;
  const log = (msg: string) => ctx.log?.info(msg);

  if (!account.token) {
    log(`quase[${ctx.accountId}] not configured (no token) — poller idle`);
    return;
  }

  const pollInterval = account.pollInterval ?? DEFAULT_POLL_INTERVAL;
  const respondAllowFrom = account.respondAllowFrom ?? [];

  const session = new QuaseSession(account, QUASE_CLIENT_VERSION);
  const dispatch = buildQuaseDispatch({ cfg: ctx.cfg, accountId: ctx.accountId, client: session, log });

  log(`quase[${ctx.accountId}] poller starting (token …${tokenLast4(account.token)}, every ${pollInterval}s)`);
  await startQuasePoller({
    client: session,
    respondAllowFrom,
    dispatch,
    pollIntervalMs: pollInterval * 1000,
    abortSignal: ctx.abortSignal,
    log,
    onClose: () => session.close(),
  });
}

const quaseChannelBase = createChannelPluginBase<QuaseResolvedAccount>({
  id: QUASE_CHANNEL_ID,
  meta: {
    id: QUASE_CHANNEL_ID,
    label: "Quase",
    selectionLabel: "Quase",
    blurb: "Message your self-hosted agent from Quase.",
    docsPath: "/channels/quase",
    markdownCapable: true,
  },
  capabilities: quaseCapabilities,
  configSchema: quaseChannelConfigSchema,
  config: quaseConfigAdapter,
  setup: { applyAccountConfig, validateInput },
  setupWizard: quaseSetupWizard,
});

/**
 * The live Quase channel plugin (WI-1): the `base` plus a `gateway.startAccount` poll loop
 * that dispatches inbound DMs/mentions/replies into the agent and delivers replies back to
 * Quase (send_dm / reply_create). Outbound is replies-only — the per-turn delivery adapter,
 * not a standing send tool.
 *
 * `createChannelPluginBase` widens `capabilities`/`config` to optional in its return type,
 * but the runtime object supplies both — reassert them so the base satisfies
 * `createChatChannelPlugin`'s required-field type.
 */
export const quaseChannelPlugin = createChatChannelPlugin<QuaseResolvedAccount>({
  base: {
    ...quaseChannelBase,
    capabilities: quaseCapabilities,
    config: quaseConfigAdapter,
    gateway: { startAccount },
  },
});

// Exposed for unit tests and the setup entry.
export {
  listAccountIds,
  resolveAccount,
  inspectAccount,
  applyAccountConfig,
  validateInput,
  resolveTokenValue,
  quaseSetupWizard,
};
export { QUASE_TOKEN_ENV_VAR, QUASE_DEFAULT_BASE_URL } from "./config.js";
