import { describe, it, expect, vi } from "vitest";
import { mapEvent, dedupeEventsByRef, isIgnored, type QuaseInboxEvent, type MapperDeps } from "./mapper.js";
import type { QuaseApi, QuaseDmThread, QuasePost, QuaseConversation } from "./quase-client.js";

const AGENT = "user_agent";
const OWNER = "user_owner";

/** A QuaseApi stub — every method is a spy; hydration responses are scripted per test. */
function stubClient(overrides: Partial<QuaseApi> = {}): QuaseApi {
  return {
    whoami: vi.fn(),
    checkInbox: vi.fn(),
    updateInboxSeen: vi.fn(),
    updateInboxPolicy: vi.fn(),
    postGet: vi.fn(),
    getDmThread: vi.fn(),
    getConversations: vi.fn(),
    sendDm: vi.fn(),
    replyCreate: vi.fn(),
    searchUsers: vi.fn(),
    ...overrides,
  } as QuaseApi;
}

function dmThread(participants: string[], lastMessage?: { fromUserId: string; content: string }): QuaseDmThread {
  return {
    conversationId: "conv_1",
    participantProfiles: participants.map((userId) => ({ userId, handle: userId })),
    messages: lastMessage ? [{ fromUserId: lastMessage.fromUserId, fromHandle: "x", content: lastMessage.content }] : [],
  };
}

function post(overrides: Partial<QuasePost>): QuasePost {
  return {
    postId: "post_x",
    content: "post body",
    parentId: null,
    replyToId: null,
    authorUserId: "user_a",
    authorHandle: "alice",
    ...overrides,
  };
}

function event(overrides: Partial<QuaseInboxEvent>): QuaseInboxEvent {
  return {
    itemId: "item_1",
    type: "dm_reply",
    refId: "conv_1",
    refType: "conversation",
    fromUserId: OWNER,
    fromHandle: "solo",
    createdAt: "2026-07-05T15:00:00+00:00",
    ...overrides,
  };
}

const ownerPolicy = { ownerUserId: OWNER, respondAllowFrom: [] as string[] };
function deps(client: QuaseApi, policy = ownerPolicy): MapperDeps {
  return { client, policy, agentUserId: AGENT };
}

describe("mapEvent — DMs", () => {
  it("owner 1:1 dm_reply → main session + dm reply target", async () => {
    const client = stubClient({
      getDmThread: vi.fn().mockResolvedValue(dmThread([AGENT, OWNER], { fromUserId: OWNER, content: "hello agent" })),
    });
    const res = await mapEvent(event({ type: "dm_reply", refId: "conv_1" }), deps(client));
    expect(isIgnored(res)).toBe(false);
    if (isIgnored(res)) return;
    expect(res.conversation).toEqual({ scope: "main" });
    expect(res.replyTarget).toEqual({ kind: "dm", conversationId: "conv_1" });
    expect(res.text).toBe("hello agent");
  });

  it("non-owner allowlisted dm_reply → per-conversation session", async () => {
    const client = stubClient({
      getDmThread: vi.fn().mockResolvedValue(dmThread([AGENT, "user_bob"], { fromUserId: "user_bob", content: "yo" })),
    });
    const policy = { ownerUserId: OWNER, respondAllowFrom: ["user_bob"] };
    const res = await mapEvent(event({ type: "dm_reply", refId: "conv_9", fromUserId: "user_bob", fromHandle: "bob" }), deps(client, policy));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "conversation", conversationId: "conv_9" });
    expect(res.replyTarget).toEqual({ kind: "dm", conversationId: "conv_9" });
  });

  it("multi-party DM including the owner → per-conversation (NOT main)", async () => {
    const client = stubClient({
      getDmThread: vi.fn().mockResolvedValue(dmThread([AGENT, OWNER, "user_third"], { fromUserId: OWNER, content: "group dm" })),
    });
    const res = await mapEvent(event({ type: "dm_reply", refId: "conv_multi" }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "conversation", conversationId: "conv_multi" });
  });

  it("falls back to getConversations when the thread has no participants", async () => {
    const conv: QuaseConversation = { conversationId: "conv_1", participantProfiles: [{ userId: AGENT, handle: "botly" }, { userId: OWNER, handle: "solo" }] };
    const client = stubClient({
      getDmThread: vi.fn().mockResolvedValue({ conversationId: "conv_1", participantProfiles: [], messages: [{ fromUserId: OWNER, fromHandle: "solo", content: "hi" }] }),
      getConversations: vi.fn().mockResolvedValue([conv]),
    });
    const res = await mapEvent(event({ type: "dm_reply", refId: "conv_1" }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "main" });
    expect(client.getConversations).toHaveBeenCalledTimes(1);
  });
});

describe("mapEvent — posts", () => {
  it("mention on a top-level post → per-post session, no replyToId", async () => {
    const client = stubClient({ postGet: vi.fn().mockResolvedValue(post({ postId: "post_top", parentId: null, content: "the full post" })) });
    const res = await mapEvent(event({ type: "mention", refId: "post_top", refType: "post" }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "post", postId: "post_top" });
    expect(res.replyTarget).toEqual({ kind: "post", parentId: "post_top", replyToId: undefined });
    expect(res.text).toBe("the full post");
  });

  it("reply to a reply (parentId != null) → postId = parentId, replyToId = refId", async () => {
    const client = stubClient({ postGet: vi.fn().mockResolvedValue(post({ postId: "post_reply", parentId: "post_top" })) });
    const res = await mapEvent(event({ type: "reply", refId: "post_reply", refType: "post" }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "post", postId: "post_top" });
    expect(res.replyTarget).toEqual({ kind: "post", parentId: "post_top", replyToId: "post_reply" });
  });

  it("group_broadcast maps through the post branch (dormant — poller never emits it)", async () => {
    const client = stubClient({ postGet: vi.fn().mockResolvedValue(post({ postId: "post_bcast", parentId: null })) });
    const res = await mapEvent(event({ type: "group_broadcast", refId: "post_bcast", refType: "post", groupId: "group_fleet" }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.conversation).toEqual({ scope: "post", postId: "post_bcast" });
  });
});

describe("mapEvent — respond gate", () => {
  it("non-owner, non-allowlisted → ignored with NO hydration call", async () => {
    const client = stubClient();
    const res = await mapEvent(event({ type: "dm_reply", fromUserId: "user_stranger", fromHandle: "stranger" }), deps(client));
    expect(res).toEqual({ ignored: true, reason: "respond-policy" });
    expect(client.getDmThread).not.toHaveBeenCalled();
    expect(client.postGet).not.toHaveBeenCalled();
    expect(client.getConversations).not.toHaveBeenCalled();
  });
});

describe("dedupeEventsByRef", () => {
  it("collapses a mention + reply for the same post, preferring the reply", () => {
    const events = [
      event({ itemId: "m", type: "mention", refId: "post_1", refType: "post" }),
      event({ itemId: "r", type: "reply", refId: "post_1", refType: "post" }),
      event({ itemId: "d", type: "dm_reply", refId: "conv_1" }),
    ];
    const out = dedupeEventsByRef(events);
    expect(out.map((e) => e.itemId)).toEqual(["r", "d"]);
  });

  it("prefers the reply regardless of order", () => {
    const out = dedupeEventsByRef([
      event({ itemId: "r", type: "reply", refId: "post_1", refType: "post" }),
      event({ itemId: "m", type: "mention", refId: "post_1", refType: "post" }),
    ]);
    expect(out.map((e) => e.itemId)).toEqual(["r"]);
  });

  it("leaves distinct refIds untouched", () => {
    const events = [
      event({ itemId: "a", type: "reply", refId: "post_1", refType: "post" }),
      event({ itemId: "b", type: "reply", refId: "post_2", refType: "post" }),
    ];
    expect(dedupeEventsByRef(events).map((e) => e.itemId)).toEqual(["a", "b"]);
  });
});
