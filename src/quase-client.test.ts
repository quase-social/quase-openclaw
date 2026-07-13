import { describe, it, expect, vi } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  verifyConnectivity,
  describeConnectivity,
  type QuaseClientHandle,
} from "./quase-client.js";
import type { QuaseAccountConfig } from "./config.js";

const cfg: QuaseAccountConfig = {
  token: "qse_agt_secretTOKEN1234",
  pollInterval: 20,
  baseUrl: "https://quase.social/mcp",
  allowFrom: [],
  respondAllowFrom: [],
};

/** Build a factory returning a per-instance stubbed client (no prototype mutation). */
function stubFactory(overrides: {
  connect?: ReturnType<typeof vi.fn>;
  callTool?: ReturnType<typeof vi.fn>;
}): { factory: () => QuaseClientHandle; handle: QuaseClientHandle } {
  const handle = {
    client: {
      connect: overrides.connect ?? vi.fn().mockResolvedValue(undefined),
      callTool: overrides.callTool ?? vi.fn().mockResolvedValue({ structuredContent: {} }),
      close: vi.fn().mockResolvedValue(undefined),
    },
    transport: { close: vi.fn().mockResolvedValue(undefined) },
  } as unknown as QuaseClientHandle;
  return { factory: () => handle, handle };
}

describe("verifyConnectivity", () => {
  it("connected when whoami reports account_type agent (structuredContent envelope)", async () => {
    const { factory } = stubFactory({
      callTool: vi.fn().mockResolvedValue({
        structuredContent: {
          user_id: "u1",
          handle: "botly",
          profile: { account_type: "agent", owner_user_id: "owner1" },
        },
      }),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res).toEqual({
      status: "connected",
      userId: "u1",
      handle: "botly",
      accountType: "agent",
      ownerUserId: "owner1",
    });
  });

  it("connected when identity arrives as JSON text in a content block", async () => {
    const { factory } = stubFactory({
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({ user_id: "u2", handle: "agenty", profile: { account_type: "agent" } }),
          },
        ],
      }),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res.status).toBe("connected");
    if (res.status === "connected") {
      expect(res.userId).toBe("u2");
      expect(res.handle).toBe("agenty");
    }
  });

  it("wrong_account_type when the account authenticates as human", async () => {
    const { factory } = stubFactory({
      callTool: vi.fn().mockResolvedValue({
        structuredContent: { user_id: "h1", handle: "human", profile: { account_type: "human" } },
      }),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res).toMatchObject({ status: "wrong_account_type", accountType: "human", handle: "human" });
  });

  it("unauthorized on a 401 StreamableHTTPError", async () => {
    const { factory } = stubFactory({
      connect: vi.fn().mockRejectedValue(new StreamableHTTPError(401, "invalid_token")),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res).toEqual({ status: "unauthorized" });
  });

  it("unreachable on a generic connect error (e.g. ECONNREFUSED)", async () => {
    const { factory } = stubFactory({
      connect: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 203.0.113.1:443")),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res.status).toBe("unreachable");
  });

  it("closes the client on the happy path (single close — client tears down its transport)", async () => {
    const { factory, handle } = stubFactory({
      callTool: vi.fn().mockResolvedValue({
        structuredContent: { user_id: "u", handle: "h", profile: { account_type: "agent" } },
      }),
    });
    await verifyConnectivity(cfg, "0.1.0", factory);
    expect(handle.client.close).toHaveBeenCalledTimes(1);
    // transport is NOT closed separately — that would double-free a half-open transport.
    expect(handle.transport.close).not.toHaveBeenCalled();
  });

  it("closes the client even after a 401 (no double-close)", async () => {
    const { factory, handle } = stubFactory({
      connect: vi.fn().mockRejectedValue(new StreamableHTTPError(401, "invalid_token")),
    });
    await verifyConnectivity(cfg, "0.1.0", factory);
    expect(handle.client.close).toHaveBeenCalledTimes(1);
    expect(handle.transport.close).not.toHaveBeenCalled();
  });

  it("never leaks the token into the result or its detail", async () => {
    const { factory } = stubFactory({
      connect: vi.fn().mockRejectedValue(new Error(`boom for token=${cfg.token} at host`)),
    });
    const res = await verifyConnectivity(cfg, "0.1.0", factory);
    expect(res.status).toBe("unreachable");
    expect(JSON.stringify(res)).not.toContain(cfg.token);
    expect(describeConnectivity(res)).not.toContain(cfg.token);
  });
});

describe("describeConnectivity", () => {
  it("maps each status to a human message; never includes a token", () => {
    expect(describeConnectivity({ status: "connected", userId: "u", handle: "h", accountType: "agent" })).toContain(
      "@h",
    );
    expect(describeConnectivity({ status: "wrong_account_type", userId: "u", handle: "h", accountType: "human" })).toMatch(
      /not an agent/,
    );
    expect(describeConnectivity({ status: "unauthorized" })).toMatch(/missing or invalid/);
    expect(describeConnectivity({ status: "unreachable", detail: "dns failure" })).toMatch(/Cannot reach Quase/);
  });
});
