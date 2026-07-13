import { describe, it, expect, vi } from "vitest";
import { QuaseSession, QuaseToolError, type QuaseClientHandle } from "./quase-client.js";
import type { QuaseAccountConfig } from "./config.js";

const cfg: QuaseAccountConfig = {
  token: "qse_agt_secretTOKEN1234",
  pollInterval: 20,
  baseUrl: "https://quase.social/mcp",
  allowFrom: [],
  respondAllowFrom: [],
};

type ToolResult = { structuredContent?: unknown; content?: unknown; isError?: boolean };
type CallToolFn = (req: { name: string; arguments?: Record<string, unknown> }) => Promise<ToolResult>;

/** Build a session over a stubbed client whose callTool is driven by `respond`. */
function sessionWith(respond: CallToolFn) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const closes: number[] = [];
  let factoryCalls = 0;
  const connect = vi.fn().mockResolvedValue(undefined);

  const factory = (): QuaseClientHandle => {
    const idx = factoryCalls++;
    return {
      client: {
        connect,
        callTool: (async (req: { name: string; arguments?: Record<string, unknown> }) => {
          calls.push({ name: req.name, args: req.arguments ?? {} });
          return respond(req);
        }) as unknown as QuaseClientHandle["client"]["callTool"],
        close: vi.fn(async () => {
          closes.push(idx);
        }),
      },
      transport: { close: vi.fn().mockResolvedValue(undefined) },
    } as unknown as QuaseClientHandle;
  };

  const session = new QuaseSession(cfg, "0.1.0", factory);
  return { session, calls, closes, connect, getFactoryCalls: () => factoryCalls };
}

/** One-tool stub: every callTool returns the same structuredContent payload. */
function returning(payload: unknown): CallToolFn {
  return async () => ({ structuredContent: payload });
}

describe("QuaseSession wrappers (result parsing)", () => {
  it("whoami maps identity + unread count", async () => {
    const { session } = sessionWith(
      returning({
        user_id: "user_agent",
        handle: "botly",
        profile: { account_type: "agent", owner_user_id: "user_owner" },
        unread_inbox_count: 3,
      }),
    );
    expect(await session.whoami()).toEqual({
      userId: "user_agent",
      handle: "botly",
      accountType: "agent",
      ownerUserId: "user_owner",
      unreadInboxCount: 3,
    });
  });

  it("checkInbox parses live items incl. ref_id/ref_type + the watermark", async () => {
    const { session, calls } = sessionWith(
      returning({
        items: [
          {
            item_id: "b0504657-8e24",
            type: "reply",
            ref_id: "post_2c72",
            ref_type: "post",
            from_user_id: "user_5e7d",
            from_handle: "media",
            from_display_name: "Media",
            created_at: "2026-07-05T15:27:58.873432+00:00",
            content_snippet: "Media ✅ …",
          },
        ],
        unread_count: 1,
        last_seen_inbox_at: "2026-07-05T15:00:00+00:00",
        server_time: "2026-07-05T15:30:00+00:00",
      }),
    );
    const res = await session.checkInbox({ since: "2026-07-05T15:00:00+00:00", limit: 50 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      itemId: "b0504657-8e24",
      type: "reply",
      refId: "post_2c72",
      refType: "post",
      fromUserId: "user_5e7d",
      fromHandle: "media",
      fromDisplayName: "Media",
      createdAt: "2026-07-05T15:27:58.873432+00:00",
    });
    expect(res.lastSeenInboxAt).toBe("2026-07-05T15:00:00+00:00");
    expect(res.serverTime).toBe("2026-07-05T15:30:00+00:00");
    expect(res.unreadCount).toBe(1);
    // snake_case args are passed through
    expect(calls[0]).toEqual({ name: "check_inbox", args: { since: "2026-07-05T15:00:00+00:00", limit: 50 } });
  });

  it("checkInbox returns null watermark when never set", async () => {
    const { session } = sessionWith(returning({ items: [], last_seen_inbox_at: null, server_time: "t" }));
    const res = await session.checkInbox();
    expect(res.lastSeenInboxAt).toBeNull();
    expect(res.items).toEqual([]);
  });

  it("updateInboxSeen advances the watermark via seen_at", async () => {
    const { session, calls } = sessionWith(returning({}));
    await session.updateInboxSeen({ seenAt: "2026-07-05T15:27:58.873432+00:00" });
    expect(calls[0]).toEqual({ name: "update_inbox_seen", args: { seen_at: "2026-07-05T15:27:58.873432+00:00" } });
  });

  it("postGet maps a top-level post from the LIVE nested `post` shape (parent_id null)", async () => {
    const { session } = sessionWith(
      returning({
        post: {
          post_id: "post_top",
          content: "full body",
          parent_id: null,
          reply_to_id: null,
          author_user_id: "user_a",
          author_handle: "alice",
          visibility_type: "shared",
        },
      }),
    );
    expect(await session.postGet("post_top")).toEqual({
      postId: "post_top",
      content: "full body",
      parentId: null,
      replyToId: null,
      authorUserId: "user_a",
      authorHandle: "alice",
      visibilityType: "shared",
    });
  });

  it("postGet maps a reply nested under `post` (parent + reply_to hierarchy present)", async () => {
    const { session } = sessionWith(
      returning({
        post: { post_id: "post_reply", content: "the reply", parent_id: "post_top", reply_to_id: "post_mid", author_user_id: "u", author_handle: "h" },
      }),
    );
    const p = await session.postGet("post_reply");
    expect(p.content).toBe("the reply");
    expect(p.parentId).toBe("post_top");
    expect(p.replyToId).toBe("post_mid");
  });

  it("getDmThread maps the LIVE shape: participants under post, messages under replies with author_*", async () => {
    const { session } = sessionWith(
      returning({
        post: {
          conversation_id: "conv_1",
          participant_profiles: [
            { user_id: "user_agent", handle: "botly" },
            { user_id: "user_owner", handle: "solo" },
          ],
        },
        replies: [{ author_user_id: "user_owner", author_handle: "solo", content: "hi there", created_at: "t" }],
        reply_count: 1,
      }),
    );
    const t = await session.getDmThread("conv_1");
    expect(t.conversationId).toBe("conv_1");
    expect(t.participantProfiles).toEqual([
      { userId: "user_agent", handle: "botly" },
      { userId: "user_owner", handle: "solo" },
    ]);
    expect(t.messages[0]).toMatchObject({ fromUserId: "user_owner", fromHandle: "solo", content: "hi there" });
  });

  it("getConversations maps the LIVE `result` key", async () => {
    const { session } = sessionWith(
      returning({ result: [{ conversation_id: "conv_1", participant_profiles: [{ user_id: "u", handle: "h" }] }] }),
    );
    const list = await session.getConversations();
    expect(list).toEqual([{ conversationId: "conv_1", participantProfiles: [{ userId: "u", handle: "h" }] }]);
  });

  it("updateInboxPolicy reads (no arg) and writes (inbox_policy) the resulting policy", async () => {
    const { session, calls } = sessionWith(returning({ inbox_policy: { mentions: ["*"], replies: ["*"], dm_messages: ["*"] } }));
    const read = await session.updateInboxPolicy();
    expect(calls[0]).toEqual({ name: "update_inbox_policy", args: {} });
    expect(read).toEqual({ mentions: ["*"], replies: ["*"], dm_messages: ["*"] });

    await session.updateInboxPolicy({ mentions: ["*"], replies: ["*"], dm_messages: ["*"], reactions: ["system"] });
    expect(calls[1]).toEqual({
      name: "update_inbox_policy",
      args: { inbox_policy: { mentions: ["*"], replies: ["*"], dm_messages: ["*"], reactions: ["system"] } },
    });
  });

  it("getConversations maps a bare array", async () => {
    const { session } = sessionWith(returning([{ conversation_id: "conv_2", participant_profiles: [] }]));
    const list = await session.getConversations();
    expect(list).toEqual([{ conversationId: "conv_2", participantProfiles: [] }]);
  });

  it("sendDm posts content to the conversation", async () => {
    const { session, calls } = sessionWith(returning({ message_id: "msg_1" }));
    const res = await session.sendDm({ conversationId: "conv_1", content: "reply body" });
    expect(res.messageId).toBe("msg_1");
    expect(calls[0]).toEqual({ name: "send_dm", args: { conversation_id: "conv_1", content: "reply body" } });
  });

  it("replyCreate passes mentions as {handle, display_name} and echoes mentions_dropped", async () => {
    const { session, calls } = sessionWith(
      returning({
        post_id: "post_new",
        mentions: [{ handle: "bob", user_id: "user_bob" }],
        mentions_dropped: ["ghost"],
      }),
    );
    const res = await session.replyCreate({
      parentId: "post_top",
      content: "hi @bob",
      replyToId: "post_reply",
      mentions: [{ handle: "bob", displayName: "Bob" }],
    });
    expect(res.postId).toBe("post_new");
    expect(res.mentions).toEqual([{ handle: "bob", userId: "user_bob" }]);
    expect(res.mentionsDropped).toEqual(["ghost"]);
    expect(calls[0]).toEqual({
      name: "reply_create",
      args: {
        parent_id: "post_top",
        content: "hi @bob",
        reply_to_id: "post_reply",
        mentions: [{ handle: "bob", display_name: "Bob" }],
      },
    });
  });

  it("searchUsers maps user_id/handle/display_name", async () => {
    const { session } = sessionWith(returning({ users: [{ user_id: "user_bob", handle: "bob", display_name: "Bob" }] }));
    expect(await session.searchUsers("bob")).toEqual([{ userId: "user_bob", handle: "bob", displayName: "Bob" }]);
  });
});

describe("QuaseSession transport behavior", () => {
  it("reconnects exactly once on a transport drop and does not double-close", async () => {
    let n = 0;
    const { session, closes, getFactoryCalls } = sessionWith(async () => {
      n += 1;
      if (n === 1) throw new Error("socket hang up"); // first invoke: transport drop
      return { structuredContent: { user_id: "u", handle: "h", profile: { account_type: "agent" } } };
    });
    const id = await session.whoami();
    expect(id.userId).toBe("u");
    expect(getFactoryCalls()).toBe(2); // initial connect + exactly one reconnect
    expect(closes).toEqual([0]); // the dropped handle closed once; no double-free
  });

  it("does not reconnect on a tool-level error (surfaces QuaseToolError)", async () => {
    const { session, getFactoryCalls } = sessionWith(async () => ({ isError: true, content: [{ type: "text", text: "bad request" }] }));
    await expect(session.checkInbox()).rejects.toBeInstanceOf(QuaseToolError);
    expect(getFactoryCalls()).toBe(1); // no reconnect for a tool error
  });

  it("treats an { error } payload (isError=false) as a tool error — so a failed send surfaces", async () => {
    const { session, getFactoryCalls } = sessionWith(async () => ({
      structuredContent: { error: "Cannot reply to a nested reply (max one level of nesting)" },
    }));
    await expect(session.replyCreate({ parentId: "post_top", content: "x" })).rejects.toBeInstanceOf(QuaseToolError);
    expect(getFactoryCalls()).toBe(1); // application error, not a transport drop → no reconnect
  });

  it("never leaks the token in a thrown transport error", async () => {
    const { session } = sessionWith(async () => {
      throw new Error(`connect failed with Authorization: Bearer ${cfg.token}`);
    });
    let caught: unknown;
    try {
      await session.whoami();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(cfg.token);
    expect((caught as Error).message).toContain("***");
  });

  it("close() tears down the client once", async () => {
    const { session, closes } = sessionWith(returning({ user_id: "u", handle: "h", profile: { account_type: "agent" } }));
    await session.whoami();
    await session.close();
    await session.close(); // idempotent
    expect(closes).toEqual([0]);
  });
});
