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
  QuaseSession,
  QuaseToolError,
  type ConnectivityResult,
  type QuaseClientHandle,
  type QuaseClientFactory,
  type QuaseApi,
  type QuaseIdentity,
  type QuaseInboxItem,
  type QuaseInboxResult,
  type QuasePost,
  type QuaseDmThread,
  type QuaseConversation,
  type QuaseReplyResult,
  type QuaseUser,
} from "./src/quase-client.js";

export { shouldRespond, type RespondPolicy, type RespondSubject } from "./src/respond-policy.js";

export {
  mapEvent,
  dedupeEventsByRef,
  isIgnored,
  type QuaseInboxEvent,
  type QuaseEventType,
  type DispatchableInbound,
  type ReplyTarget,
  type ConversationScope,
  type MapResult,
  type MapperDeps,
} from "./src/mapper.js";

export { routeOutbound, type OutboundResult, type OutboundDeps } from "./src/outbound.js";

export { buildQuaseDispatch, defaultDispatchRuntime, type QuaseDispatchRuntime } from "./src/dispatch.js";

export { startQuasePoller, QuasePoller, type PollerDeps } from "./src/poller.js";
