import { describe, it, expect, vi } from "vitest";
import { buildQuaseDispatch, type QuaseDispatchRuntime } from "./dispatch.js";
import type { QuaseApi } from "./quase-client.js";
import type { DispatchableInbound } from "./mapper.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

const cfg = { session: { store: "/store" } } as unknown as OpenClawConfig;

function stubRuntime(): QuaseDispatchRuntime {
  const inboundRun = vi.fn().mockResolvedValue(undefined);
  return {
    runChannelInboundEvent: inboundRun,
    buildChannelInboundEventContext: vi.fn().mockReturnValue({ SessionKey: "ctx-session" }),
    resolveAgentRoute: vi.fn().mockReturnValue({
      agentId: "agent1",
      channel: "quase",
      accountId: "acct",
      sessionKey: "resolved:session",
      mainSessionKey: "agent:agent1:main",
    }),
    buildAgentSessionKey: vi.fn().mockReturnValue("built:key"),
    resolveStorePath: vi.fn().mockReturnValue("/resolved/store"),
    recordInboundSession: vi.fn(),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
  } as unknown as QuaseDispatchRuntime;
}

function stubClient(): QuaseApi {
  return {
    whoami: vi.fn(),
    checkInbox: vi.fn(),
    updateInboxSeen: vi.fn(),
    updateInboxPolicy: vi.fn(),
    postGet: vi.fn(),
    getDmThread: vi.fn(),
    getConversations: vi.fn(),
    sendDm: vi.fn().mockResolvedValue({ messageId: "msg" }),
    replyCreate: vi.fn().mockResolvedValue({ postId: "post_new", mentions: [], mentionsDropped: [] }),
    searchUsers: vi.fn().mockResolvedValue([]),
  } as QuaseApi;
}

const ownerDm: DispatchableInbound = {
  itemId: "i1",
  createdAt: "2026-07-05T01:00:00Z",
  conversation: { scope: "main" },
  text: "hello agent",
  sender: { userId: "user_owner", handle: "solo" },
  replyTarget: { kind: "dm", conversationId: "conv_1" },
};

const otherDm: DispatchableInbound = {
  itemId: "i2",
  createdAt: "2026-07-05T02:00:00Z",
  conversation: { scope: "conversation", conversationId: "conv_2" },
  text: "hi",
  sender: { userId: "user_bob", handle: "bob" },
  replyTarget: { kind: "dm", conversationId: "conv_2" },
};

const postThread: DispatchableInbound = {
  itemId: "i3",
  createdAt: "2026-07-05T03:00:00Z",
  conversation: { scope: "post", postId: "post_top" },
  text: "mention me",
  sender: { userId: "user_owner", handle: "solo" },
  replyTarget: { kind: "post", parentId: "post_top", replyToId: "post_reply" },
};

/** Pull the Assembled turn out of the (spied) runChannelInboundEvent call. */
function capturedTurn(runtime: QuaseDispatchRuntime) {
  const spy = runtime.runChannelInboundEvent as unknown as ReturnType<typeof vi.fn>;
  const params = spy.mock.calls[0][0];
  return { params, turn: params.adapter.resolveTurn(), ingest: params.adapter.ingest() };
}

describe("buildQuaseDispatch — Assembled turn shape", () => {
  it("owner DM → main session key; assembled turn (no runDispatch); ctxPayload from buildContext", async () => {
    const runtime = stubRuntime();
    const client = stubClient();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client, runtime });
    await dispatch(ownerDm);

    expect(runtime.resolveAgentRoute).toHaveBeenCalledWith({
      cfg,
      channel: "quase",
      accountId: "acct",
      peer: { kind: "direct", id: "conv_1" },
    });

    const { params, turn, ingest } = capturedTurn(runtime);
    expect(params.channel).toBe("quase");
    expect(params.accountId).toBe("acct");
    expect(turn).not.toHaveProperty("runDispatch"); // Assembled path
    expect(turn.channel).toBe("quase");
    expect(turn.cfg).toBe(cfg);
    expect(turn.agentId).toBe("agent1");
    expect(turn.routeSessionKey).toBe("agent:agent1:main"); // owner → main
    expect(turn.storePath).toBe("/resolved/store");
    expect(turn.ctxPayload).toEqual({ SessionKey: "ctx-session" });
    expect(turn.delivery.durable).toBe(false);
    expect(ingest).toMatchObject({ id: "i1", rawText: "hello agent" });
  });

  it("other DM → per-peer direct session key", async () => {
    const runtime = stubRuntime();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client: stubClient(), runtime });
    await dispatch(otherDm);

    expect(runtime.buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "agent1",
      channel: "quase",
      accountId: "acct",
      peer: { kind: "direct", id: "conv_2" },
      dmScope: "per-peer",
    });
    expect(capturedTurn(runtime).turn.routeSessionKey).toBe("built:key");
  });

  it("post thread → channel-kind session key by the top-level post", async () => {
    const runtime = stubRuntime();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client: stubClient(), runtime });
    await dispatch(postThread);

    expect(runtime.buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "agent1",
      channel: "quase",
      accountId: "acct",
      peer: { kind: "channel", id: "post_top" },
    });
  });
});

describe("buildQuaseDispatch — delivery routes back to Quase", () => {
  it("DM delivery calls send_dm with the agent's visible text", async () => {
    const runtime = stubRuntime();
    const client = stubClient();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client, runtime });
    await dispatch(ownerDm);

    const { turn } = capturedTurn(runtime);
    const result = await turn.delivery.deliver({ text: "the reply" });
    expect(client.sendDm).toHaveBeenCalledWith({ conversationId: "conv_1", content: "the reply" });
    expect(result).toEqual({ messageIds: ["msg"], visibleReplySent: true });
  });

  it("post delivery calls reply_create in-thread (parent + reply_to)", async () => {
    const runtime = stubRuntime();
    const client = stubClient();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client, runtime });
    await dispatch(postThread);

    const { turn } = capturedTurn(runtime);
    await turn.delivery.deliver({ text: "in-thread reply" });
    expect(client.replyCreate).toHaveBeenCalledWith({
      parentId: "post_top",
      replyToId: "post_reply",
      content: "in-thread reply",
      mentions: undefined,
    });
  });

  it("delivery skips a reasoning payload (nothing posted)", async () => {
    const runtime = stubRuntime();
    const client = stubClient();
    const dispatch = buildQuaseDispatch({ cfg, accountId: "acct", client, runtime });
    await dispatch(ownerDm);

    const { turn } = capturedTurn(runtime);
    const result = await turn.delivery.deliver({ text: "thinking", isReasoning: true });
    expect(client.sendDm).not.toHaveBeenCalled();
    expect(result).toEqual({ visibleReplySent: false });
  });
});
