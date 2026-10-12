import { describe, it, expect, vi } from "vitest";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { routeOutbound, type OutboundDeps } from "./outbound.js";
import type { QuaseApi, QuaseReplyResult } from "./quase-client.js";
import type { ReplyTarget } from "./mapper.js";

/** A minimal QuaseApi stub with the outbound tools spied. */
function stubClient(overrides: Partial<QuaseApi> = {}): QuaseApi {
  return {
    whoami: vi.fn(),
    checkInbox: vi.fn(),
    updateInboxSeen: vi.fn(),
    updateInboxPolicy: vi.fn(),
    postGet: vi.fn(),
    getDmThread: vi.fn(),
    getConversations: vi.fn(),
    sendDm: vi.fn().mockResolvedValue({ messageId: "msg_1" }),
    replyCreate: vi.fn().mockResolvedValue({ postId: "post_new", mentionsUnresolved: [] } as QuaseReplyResult),
    ...overrides,
  } as QuaseApi;
}

function reply(text: string, flags: Partial<ReplyPayload> = {}): ReplyPayload {
  return { text, ...flags } as ReplyPayload;
}

const dmTarget: ReplyTarget = { kind: "dm", conversationId: "conv_1" };
const postTarget: ReplyTarget = { kind: "post", parentId: "post_top" };

describe("routeOutbound — DM", () => {
  it("sends the text to the conversation with no mentions array", async () => {
    const client = stubClient();
    const res = await routeOutbound(reply("hello back"), dmTarget, { client });
    expect(client.sendDm).toHaveBeenCalledWith({ conversationId: "conv_1", content: "hello back" });
    expect(res).toEqual({ messageIds: ["msg_1"], visibleReplySent: true });
    // DMs never carry mentions
    expect(client.replyCreate).not.toHaveBeenCalled();
  });
});

describe("routeOutbound — post reply", () => {
  it("plain text → replyCreate with no mentions and no visibility field", async () => {
    const client = stubClient();
    const res = await routeOutbound(reply("just a reply"), postTarget, { client });
    expect(client.replyCreate).toHaveBeenCalledWith({ parentId: "post_top", replyToId: undefined, content: "just a reply" });
    // no `visibility` (or `mentions`) key passed anywhere
    const arg = (client.replyCreate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).not.toHaveProperty("visibility");
    expect(arg).not.toHaveProperty("mentions");
    expect(res).toEqual({ messageIds: ["post_new"], visibleReplySent: true });
  });

  it("@handle in text → replyCreate called with content only (no mentions array, no search)", async () => {
    const client = stubClient();
    await routeOutbound(reply("hi @bob welcome"), postTarget, { client });
    expect(client.replyCreate).toHaveBeenCalledTimes(1);
    const arg = (client.replyCreate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).toEqual({ parentId: "post_top", replyToId: undefined, content: "hi @bob welcome" });
    expect(arg).not.toHaveProperty("mentions");
  });

  it("logs mentions_unresolved but still resolves success", async () => {
    const log = vi.fn();
    const client = stubClient({
      replyCreate: vi.fn().mockResolvedValue({ postId: "post_new", mentionsUnresolved: ["ghost"] }),
    });
    const deps: OutboundDeps = { client, log };
    const res = await routeOutbound(reply("hey @ghost"), postTarget, deps);
    expect(res.visibleReplySent).toBe(true);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("ghost"))).toBe(true);
  });

  it("passes replyToId through when set", async () => {
    const client = stubClient();
    await routeOutbound(reply("targeted"), { kind: "post", parentId: "post_top", replyToId: "post_reply" }, { client });
    expect(client.replyCreate).toHaveBeenCalledWith({ parentId: "post_top", replyToId: "post_reply", content: "targeted" });
  });
});

describe("routeOutbound — non-final + errors", () => {
  it("skips a reasoning payload (no send)", async () => {
    const client = stubClient();
    const res = await routeOutbound(reply("thinking...", { isReasoning: true }), dmTarget, { client });
    expect(res).toEqual({ visibleReplySent: false });
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("skips a status-notice payload", async () => {
    const client = stubClient();
    const res = await routeOutbound(reply("working", { isStatusNotice: true }), postTarget, { client });
    expect(res).toEqual({ visibleReplySent: false });
    expect(client.replyCreate).not.toHaveBeenCalled();
  });

  it("skips an empty/whitespace-only text payload", async () => {
    const client = stubClient();
    const res = await routeOutbound(reply("   "), dmTarget, { client });
    expect(res).toEqual({ visibleReplySent: false });
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("propagates a sendDm throw (so the poller sees a failed dispatch)", async () => {
    const client = stubClient({ sendDm: vi.fn().mockRejectedValue(new Error("network down")) });
    await expect(routeOutbound(reply("hi"), dmTarget, { client })).rejects.toThrow("network down");
  });

  it("propagates a replyCreate throw", async () => {
    const client = stubClient({ replyCreate: vi.fn().mockRejectedValue(new Error("post gone")) });
    await expect(routeOutbound(reply("hi"), postTarget, { client })).rejects.toThrow("post gone");
  });
});
