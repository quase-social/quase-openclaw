// Public API barrel. Import the plugin's own building blocks from here (never via
// `openclaw/plugin-sdk/<this-plugin>` or a deep `./src/**` path) — the ESLint boundary
// rules enforce that.

export {
  quaseChannelPlugin,
  QUASE_CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  type QuaseResolvedAccount,
  type QuaseAccountInspection,
} from "./src/channel.js";

export {
  quaseAccountConfigSchema,
  quaseChannelConfigSchema,
  QUASE_DEFAULT_BASE_URL,
  QUASE_TOKEN_ENV_VAR,
  DEFAULT_POLL_INTERVAL,
  MIN_POLL_INTERVAL,
  tokenLast4,
  type QuaseAccountConfig,
} from "./src/config.js";

export {
  createQuaseClient,
  verifyConnectivity,
  describeConnectivity,
  type ConnectivityResult,
  type QuaseClientHandle,
  type QuaseClientFactory,
} from "./src/quase-client.js";
