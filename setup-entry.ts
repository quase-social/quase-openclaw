import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { quaseChannelPlugin } from "./src/channel.js";

/**
 * Lightweight setup-only entry (loaded for onboarding / disabled-inspection surfaces
 * before the full runtime). No CLI regs, background services, or heavy imports.
 */
export default defineSetupPluginEntry(quaseChannelPlugin);
