import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { quaseChannelPlugin } from "./src/channel.js";
import { quaseChannelConfigSchema } from "./src/config.js";

/**
 * Dev/workspace channel entry. INERT for WI-0: it registers the Quase channel so the
 * gateway sees it configured and valid, but starts no poller, no background service, and
 * no gateway routes. Inbound polling + outbound send land in WI-1.
 *
 * The live connectivity check is exposed as the exported verifyConnectivity() (see
 * ./api.ts) and the scripts/verify-connectivity.mjs probe, not as a gateway runtime here.
 */
export default defineChannelPluginEntry({
  id: "quase",
  name: "Quase",
  description: "Quase channel for OpenClaw — message your agent from Quase.",
  plugin: quaseChannelPlugin,
  configSchema: quaseChannelConfigSchema,
  registerCliMetadata() {
    // INERT (WI-0): no CLI runtime registered.
  },
  registerFull() {
    // INERT (WI-0): no poller, no background service, no gateway routes.
  },
});
