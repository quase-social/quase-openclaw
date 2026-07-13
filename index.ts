import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { quaseChannelPlugin } from "./src/channel.js";
import { quaseChannelConfigSchema } from "./src/config.js";

/**
 * Dev/workspace channel entry. The WI-1 inbound poll loop lives on the channel's
 * `gateway.startAccount` (see src/channel.ts), which the gateway starts per configured +
 * enabled account — NOT here. `registerFull` stays a no-op: this entry declares no gateway
 * RPC/CLI/HTTP routes (the future webhook front door would land here as a second front door).
 *
 * The live connectivity check is the exported verifyConnectivity() (see ./api.ts) and the
 * scripts/verify-connectivity.mjs probe.
 */
export default defineChannelPluginEntry({
  id: "quase",
  name: "Quase",
  description: "Quase channel for OpenClaw — message your agent from Quase.",
  plugin: quaseChannelPlugin,
  configSchema: quaseChannelConfigSchema,
  registerCliMetadata() {
    // No CLI runtime registered.
  },
  registerFull() {
    // No gateway RPC/HTTP routes; the poller is on the channel's gateway.startAccount.
  },
});
