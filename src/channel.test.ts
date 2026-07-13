import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  inspectAccount,
  applyAccountConfig,
  resolveAccount,
  validateInput,
  resolveTokenValue,
  quaseChannelPlugin,
  quaseSetupWizard,
  QUASE_CHANNEL_ID,
  QUASE_TOKEN_ENV_VAR,
} from "./channel.js";

// Minimal config builder: the account config lives under channels.quase (open-world index).
function cfgWith(quase: Record<string, unknown>): OpenClawConfig {
  return { channels: { [QUASE_CHANNEL_ID]: quase } } as unknown as OpenClawConfig;
}

// Deterministic control of the token env var that resolveTokenValue reads.
const ORIGINAL_TOKEN_ENV = process.env[QUASE_TOKEN_ENV_VAR];
function setTokenEnv(value: string | undefined): void {
  if (value === undefined) delete process.env[QUASE_TOKEN_ENV_VAR];
  else process.env[QUASE_TOKEN_ENV_VAR] = value;
}

describe("inspectAccount (status without materializing the secret)", () => {
  beforeEach(() => setTokenEnv(undefined));
  afterEach(() => setTokenEnv(ORIGINAL_TOKEN_ENV));

  it("reports configured + available and returns no token value", () => {
    const res = inspectAccount(cfgWith({ token: "qse_agt_x", pollInterval: 20 }));
    expect(res).toEqual({ enabled: true, configured: true, tokenStatus: "available" });
    expect(JSON.stringify(res)).not.toContain("qse_agt_x");
  });

  it("reports missing when there is no token anywhere", () => {
    const res = inspectAccount(cfgWith({ pollInterval: 20 }));
    expect(res).toMatchObject({ configured: false, tokenStatus: "missing" });
  });

  it("reports available when the env var supplies the token", () => {
    setTokenEnv("qse_agt_fromenv");
    const res = inspectAccount(cfgWith({}));
    expect(res).toMatchObject({ configured: true, tokenStatus: "available" });
    expect(JSON.stringify(res)).not.toContain("qse_agt_fromenv");
  });

  it("is reachable via the assembled plugin object at plugin.config.inspectAccount", () => {
    const res = quaseChannelPlugin.config.inspectAccount?.(cfgWith({ token: "qse_agt_x" }));
    expect(res).toMatchObject({ configured: true, tokenStatus: "available" });
  });
});

describe("resolveAccount", () => {
  beforeEach(() => setTokenEnv(undefined));
  afterEach(() => setTokenEnv(ORIGINAL_TOKEN_ENV));

  it("resolves the token and fills defaults", () => {
    const acct = resolveAccount(cfgWith({ token: "qse_agt_a" }));
    expect(acct.token).toBe("qse_agt_a");
    expect(acct.pollInterval).toBe(20);
    expect(acct.baseUrl).toContain("quase.social");
    expect(acct.allowFrom).toEqual([]);
  });

  it("falls back to the env var when the config token is blank", () => {
    setTokenEnv("qse_agt_env");
    expect(resolveAccount(cfgWith({})).token).toBe("qse_agt_env");
  });

  it("resolves an env SecretRef token object", () => {
    setTokenEnv("qse_agt_ref");
    const acct = resolveAccount(
      cfgWith({ token: { source: "env", provider: "default", id: QUASE_TOKEN_ENV_VAR } }),
    );
    expect(acct.token).toBe("qse_agt_ref");
  });

  it("never throws on a missing token (channel is inert)", () => {
    expect(() => resolveAccount(cfgWith({}))).not.toThrow();
    expect(resolveAccount(cfgWith({})).token).toBe("");
  });
});

describe("applyAccountConfig", () => {
  it("writes the token into channels.quase without mutating the input config", () => {
    const start = cfgWith({});
    const next = applyAccountConfig({ cfg: start, accountId: "default", input: { token: "qse_agt_new" } }) as {
      channels: { quase: { token?: string } };
    };
    expect(next.channels.quase.token).toBe("qse_agt_new");
    expect((start as unknown as { channels: { quase: { token?: string } } }).channels.quase.token).toBeUndefined();
  });

  it("writes baseUrl when provided", () => {
    const next = applyAccountConfig({
      cfg: cfgWith({}),
      accountId: "default",
      input: { token: "t", baseUrl: "https://example.test/mcp" },
    }) as { channels: { quase: { baseUrl?: string } } };
    expect(next.channels.quase.baseUrl).toBe("https://example.test/mcp");
  });

  it("writes a named account under accounts.<id>", () => {
    const next = applyAccountConfig({ cfg: cfgWith({}), accountId: "bot2", input: { token: "t2" } }) as {
      channels: { quase: { accounts: Record<string, { token?: string }> } };
    };
    expect(next.channels.quase.accounts.bot2.token).toBe("t2");
  });
});

describe("validateInput", () => {
  it("passes when a token is provided", () => {
    expect(validateInput({ cfg: cfgWith({}), accountId: "default", input: { token: "t" } })).toBeNull();
  });

  it("passes when useEnv is set (env-provided token)", () => {
    expect(validateInput({ cfg: cfgWith({}), accountId: "default", input: { useEnv: true } })).toBeNull();
  });

  it("fails with a message when no token is provided", () => {
    expect(validateInput({ cfg: cfgWith({}), accountId: "default", input: {} })).toMatch(/token is required/);
  });
});

describe("quaseSetupWizard", () => {
  beforeEach(() => setTokenEnv(undefined));
  afterEach(() => setTokenEnv(ORIGINAL_TOKEN_ENV));

  const credential = () => quaseSetupWizard.credentials[0];

  it("declares the token credential with the preferred env var", () => {
    expect(quaseSetupWizard.channel).toBe("quase");
    expect(credential().inputKey).toBe("token");
    expect(credential().preferredEnvVar).toBe(QUASE_TOKEN_ENV_VAR);
  });

  it("status.resolveConfigured reflects token presence", async () => {
    expect(await quaseSetupWizard.status.resolveConfigured({ cfg: cfgWith({ token: "qse_agt_x" }) })).toBe(true);
    expect(await quaseSetupWizard.status.resolveConfigured({ cfg: cfgWith({}) })).toBe(false);
  });

  it("credential.inspect reports configured state and env availability", () => {
    setTokenEnv("qse_agt_envval");
    const state = credential().inspect({ cfg: cfgWith({ token: "qse_agt_lit" }), accountId: "default" });
    expect(state.accountConfigured).toBe(true);
    expect(state.hasConfiguredValue).toBe(true);
    expect(state.envValue).toBe("qse_agt_envval");
  });

  it("applyUseEnv writes an env SecretRef that resolveTokenValue then reads from the env var", async () => {
    setTokenEnv("qse_agt_viaenvref");
    const applyUseEnv = credential().applyUseEnv;
    if (!applyUseEnv) throw new Error("applyUseEnv is not defined");
    const next = (await applyUseEnv({ cfg: cfgWith({}), accountId: "default" })) as {
      channels: { quase: { token: { source: string; id: string } } };
    };
    expect(next.channels.quase.token).toMatchObject({ source: "env", id: QUASE_TOKEN_ENV_VAR });
    expect(resolveTokenValue(next.channels.quase)).toBe("qse_agt_viaenvref");
  });
});
