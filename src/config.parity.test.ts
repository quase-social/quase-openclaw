import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { quaseAccountConfigSchema } from "./config.js";

const manifestPath = fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  channels: string[];
  configSchema: unknown;
  channelConfigs: {
    quase: {
      schema: unknown;
      uiHints: Record<string, { sensitive?: boolean }>;
    };
  };
};

describe("openclaw.plugin.json parity with the Zod schema", () => {
  it("channelConfigs.quase.schema equals z.toJSONSchema(schema, { io: 'input' }) — catches drift", () => {
    // io: "input" so defaulted fields are optional (only `token` is required), matching how
    // a user authors the config. Regenerate the manifest schema if this fails.
    const generated = z.toJSONSchema(quaseAccountConfigSchema, { io: "input" });
    expect(manifest.channelConfigs.quase.schema).toEqual(generated);
  });

  it("marks token as sensitive in the channel uiHints", () => {
    expect(manifest.channelConfigs.quase.uiHints.token.sensitive).toBe(true);
  });

  it("declares the quase channel", () => {
    expect(manifest.channels).toContain("quase");
  });

  it("keeps a permissive plugin-entry configSchema (token lives in the channel config)", () => {
    expect(manifest.configSchema).toMatchObject({ type: "object" });
  });
});
