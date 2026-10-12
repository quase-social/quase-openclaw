import { describe, it, expect, vi } from "vitest";
import { mapEvent, dedupeEventsByRef, isIgnored, type QuaseInboxEvent, type MapperDeps } from "./mapper.js";
import type { QuaseApi, QuaseDmMessage, QuaseDmThread, QuasePost, QuaseConversation } from "./quase-client.js";

const AGENT = "user_agent";
const OWNER = "user_owner";

/** The default event `createdAt`; `at(ms)` is that instant shifted by `ms`, in the server's isoformat. */
const EVENT_AT = "2026-07-05T15:00:00+00:00";
function at(ms: number): string {
  return new Date(Date.parse(EVENT_AT) + ms).toISOString().replace("Z", "+00:00");
}

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
    ...overrides,
  } as QuaseApi;
}

function dmThread(participants: string[], lastMessage?: { fromUserId: string; content: string }): QuaseDmThread {
  return {
    conversationId: "conv_1",
    participantProfiles: participants.map((userId) => ({ userId, handle: userId })),
    messages: lastMessage
      ? [{ messageId: "dmsg_1", fromUserId: lastMessage.fromUserId, fromHandle: "x", content: lastMessage.content, createdAt: at(-100) }]
      : [],
  };
}

function msg(messageId: string, fromUserId: string, content: string, createdAt: string): QuaseDmMessage {
  return { messageId, fromUserId, fromHandle: fromUserId, content, createdAt };
}

type ScriptedPage = { messages: QuaseDmMessage[]; next?: string };

/**
 * A `getDmThread` stub serving scripted pages keyed by `afterReplyId` (`""` = the first page). An
 * unknown cursor returns an empty, final page — the server's unknown-anchor behavior.
 */
function pagedThread(pages: Record<string, ScriptedPage>, participants: string[] = [AGENT, OWNER]) {
  return vi.fn(async (_conversationId: string, opts?: { limit?: number; afterReplyId?: string }): Promise<QuaseDmThread> => {
    const page = pages[opts?.afterReplyId ?? ""] ?? { messages: [] };
    return {
      conversationId: "conv_1",
      participantProfiles: participants.map((userId) => ({ userId, handle: userId })),
      messages: page.messages,
      nextAfterReplyId: page.next,
    };
  });
}

/** The `afterReplyId` of every `getDmThread` call, in order. */
function cursorsOf(getDmThread: ReturnType<typeof vi.fn>): (string | undefined)[] {
  return getDmThread.mock.calls.map((c) => (c[1] as { afterReplyId?: string } | undefined)?.afterReplyId);
}

/** Map `e` and return the dispatched text (fails the test if it was ignored). */
async function textOf(e: QuaseInboxEvent, d: MapperDeps): Promise<string> {
  const res = await mapEvent(e, d);
  if (isIgnored(res)) throw new Error(`expected dispatchable, got ignored: ${res.reason}`);
  return res.text;
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
    createdAt: EVENT_AT,
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

describe("mapEvent — dm_reply hydration picks the announced message", () => {
  // t1 < t2 < t3, seconds apart; an item's row is stamped ~80 ms after its message.
  const t1 = at(-30_000);
  const t2 = at(-20_000);
  const t3 = at(-10_000);
  const rowAfter = (t: string) => new Date(Date.parse(t) + 80).toISOString().replace("Z", "+00:00");

  it("pages forward (limit 200) through an empty-but-more page to the newest message", async () => {
    const getDmThread = pagedThread({
      "": { messages: [msg("dmsg_1", OWNER, "one", at(-90_000)), msg("dmsg_2", AGENT, "two", at(-80_000)), msg("dmsg_3", OWNER, "three", at(-70_000))], next: "dmsg_3" },
      dmsg_3: { messages: [], next: "dmsg_3b" },
      dmsg_3b: { messages: [msg("dmsg_12", OWNER, "can you check the build?", at(-100))] },
    });
    const client = stubClient({ getDmThread });
    expect(await textOf(event({ contentSnippet: "can you check the build?" }), deps(client))).toBe("can you check the build?");
    expect(getDmThread).toHaveBeenCalledTimes(3);
    expect(getDmThread).toHaveBeenNthCalledWith(1, "conv_1", { limit: 200 });
    expect(getDmThread).toHaveBeenNthCalledWith(2, "conv_1", { limit: 200, afterReplyId: "dmsg_3" });
    expect(getDmThread).toHaveBeenNthCalledWith(3, "conv_1", { limit: 200, afterReplyId: "dmsg_3b" });
  });

  it("the agent's own reply being newest does not replace the owner's message", async () => {
    const client = stubClient({
      getDmThread: pagedThread({ "": { messages: [msg("dmsg_1", OWNER, "hello", t1), msg("dmsg_2", AGENT, "hi there", t2)] } }),
    });
    const res = await mapEvent(event({ contentSnippet: "hello", createdAt: rowAfter(t1) }), deps(client));
    if (isIgnored(res)) throw new Error("expected dispatchable");
    expect(res.text).toBe("hello");
    expect(res.sender.userId).toBe(OWNER);
  });

  it("two items in one conversation each map to their own message", async () => {
    const client = stubClient({
      getDmThread: pagedThread({
        "": { messages: [msg("dmsg_1", OWNER, "first", t1), msg("dmsg_2", OWNER, "second", t2), msg("dmsg_3", AGENT, "reply", t3)] },
      }),
    });
    expect(await textOf(event({ itemId: "i1", contentSnippet: "first", createdAt: rowAfter(t1) }), deps(client))).toBe("first");
    expect(await textOf(event({ itemId: "i2", contentSnippet: "second", createdAt: rowAfter(t2) }), deps(client))).toBe("second");
  });

  it("two items with no snippets are separated by time alone", async () => {
    const client = stubClient({
      getDmThread: pagedThread({
        "": { messages: [msg("dmsg_1", OWNER, "first", t1), msg("dmsg_2", OWNER, "second", t2), msg("dmsg_3", AGENT, "reply", t3)] },
      }),
    });
    expect(await textOf(event({ itemId: "i1", createdAt: rowAfter(t1) }), deps(client))).toBe("first");
    expect(await textOf(event({ itemId: "i2", createdAt: rowAfter(t2) }), deps(client))).toBe("second");
  });

  it("a missing (deleted) message ⇒ ignored, with no getConversations call", async () => {
    const client = stubClient({
      getDmThread: pagedThread({ "": { messages: [msg("dmsg_1", OWNER, "older", t1), msg("dmsg_2", AGENT, "ack", t2)] } }),
    });
    const res = await mapEvent(event({ contentSnippet: "deleted text", createdAt: rowAfter(t3) }), deps(client));
    expect(res).toEqual({ ignored: true, reason: "dm-message-unavailable" });
    expect(client.getConversations).not.toHaveBeenCalled();
  });

  it("an empty thread ⇒ ignored — never falls back to the snippet", async () => {
    const client = stubClient({ getDmThread: pagedThread({ "": { messages: [] } }) });
    const res = await mapEvent(event({ contentSnippet: "resurrected text" }), deps(client));
    expect(res).toEqual({ ignored: true, reason: "dm-message-unavailable" });
  });

  it("no snippet ⇒ sender + time pick the latest message sent before the row", async () => {
    const client = stubClient({
      getDmThread: pagedThread({ "": { messages: [msg("dmsg_1", OWNER, "a", t1), msg("dmsg_2", OWNER, "b", t3)] } }),
    });
    expect(await textOf(event({ createdAt: t2 }), deps(client))).toBe("a");
  });

  it("matches a snippet that the server truncated by code point (astral characters)", async () => {
    const content = "😀".repeat(50) + " tail" + " and more".repeat(5); // > 80 code points
    const snippet = Array.from(content).slice(0, 80).join("");
    expect(content.slice(0, 80)).not.toBe(snippet); // a UTF-16 slice would NOT equal it
    const client = stubClient({ getDmThread: pagedThread({ "": { messages: [msg("dmsg_1", OWNER, content, at(-100))] } }) });
    expect(await textOf(event({ contentSnippet: snippet }), deps(client))).toBe(content);
  });

  it("an old identical-prefix message cannot stand in for a deleted trigger (10-minute lower bound)", async () => {
    const yesterday = at(-24 * 3_600_000);
    const thread = { "": { messages: [msg("dmsg_1", OWNER, "ok", yesterday), msg("dmsg_2", AGENT, "noted", yesterday)] } };
    const withSnippet = await mapEvent(event({ contentSnippet: "ok" }), deps(stubClient({ getDmThread: pagedThread(thread) })));
    expect(withSnippet).toEqual({ ignored: true, reason: "dm-message-unavailable" });
    const noSnippet = await mapEvent(event({}), deps(stubClient({ getDmThread: pagedThread(thread) })));
    expect(noSnippet).toEqual({ ignored: true, reason: "dm-message-unavailable" });
  });
});

describe("mapEvent — dm_reply page walk guards", () => {
  const trigger = msg("dmsg_t", OWNER, "the trigger", at(-100));

  /** A thread of `n` pages: "" → c1 → … → c(n-1), the trigger on the last page. */
  function chain(n: number): Record<string, ScriptedPage> {
    const pages: Record<string, ScriptedPage> = {};
    for (let i = 0; i < n; i++) {
      const key = i === 0 ? "" : `c${i}`;
      pages[key] = i === n - 1 ? { messages: [trigger] } : { messages: [], next: `c${i + 1}` };
    }
    return pages;
  }

  it("a cursor that repeats itself stops after 2 calls ⇒ dm-thread-incomplete", async () => {
    const getDmThread = vi.fn().mockResolvedValue({ participantProfiles: [], messages: [], nextAfterReplyId: "dmsg_x" });
    const res = await mapEvent(event({ contentSnippet: "the trigger" }), deps(stubClient({ getDmThread })));
    expect(res).toEqual({ ignored: true, reason: "dm-thread-incomplete" });
    expect(getDmThread).toHaveBeenCalledTimes(2);
  });

  it("an A→B→A cursor cycle stops after 3 calls ⇒ dm-thread-incomplete", async () => {
    const getDmThread = pagedThread({ "": { messages: [], next: "A" }, A: { messages: [], next: "B" }, B: { messages: [], next: "A" } });
    const res = await mapEvent(event({ contentSnippet: "the trigger" }), deps(stubClient({ getDmThread })));
    expect(res).toEqual({ ignored: true, reason: "dm-thread-incomplete" });
    expect(getDmThread).toHaveBeenCalledTimes(3);
  });

  it("a long but advancing walk completes and logs its cost once", async () => {
    const log = vi.fn();
    const getDmThread = pagedThread(chain(12));
    const text = await textOf(event({ contentSnippet: "the trigger" }), { ...deps(stubClient({ getDmThread })), log });
    expect(text).toBe("the trigger");
    expect(getDmThread).toHaveBeenCalledTimes(12);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("walked 12 pages");
  });

  it("a walk of 10 pages or fewer does not log", async () => {
    const log = vi.fn();
    const getDmThread = pagedThread(chain(10));
    expect(await textOf(event({ contentSnippet: "the trigger" }), { ...deps(stubClient({ getDmThread })), log })).toBe("the trigger");
    expect(getDmThread).toHaveBeenCalledTimes(10);
    expect(log).not.toHaveBeenCalled();
  });

  it("a cursor that advances forever hits the runaway stop at exactly 1,000 calls", async () => {
    let n = 0;
    const getDmThread = vi.fn(async () => ({ participantProfiles: [], messages: [], nextAfterReplyId: `fresh_${n++}` }));
    const res = await mapEvent(event({ contentSnippet: "the trigger" }), deps(stubClient({ getDmThread })));
    expect(res).toEqual({ ignored: true, reason: "dm-thread-incomplete" });
    expect(getDmThread).toHaveBeenCalledTimes(1000);
  });
});

describe("mapEvent — dm_reply page-anchor cache", () => {
  const old = [msg("dmsg_1", OWNER, "old one", at(-3_600_000)), msg("dmsg_2", AGENT, "old two", at(-3_500_000))];
  const trigger1 = msg("dmsg_10", OWNER, "trigger one", at(-30_000));
  const agentReply = msg("dmsg_11", AGENT, "on it", at(-20_000));
  const trigger2 = msg("dmsg_12", OWNER, "trigger two", at(-10_000));
  const item1 = event({ itemId: "i1", contentSnippet: "trigger one", createdAt: at(-29_920) });
  const item2 = event({ itemId: "i2", contentSnippet: "trigger two", createdAt: at(-9_920) });

  it("steady state: the next DM is found with one call from the cached anchor", async () => {
    const pages: Record<string, ScriptedPage> = { "": { messages: old, next: "c1" }, c1: { messages: [trigger1] } };
    const getDmThread = pagedThread(pages);
    const dmAnchors = new Map<string, string>();
    const d = { ...deps(stubClient({ getDmThread })), dmAnchors };

    expect(await textOf(item1, d)).toBe("trigger one");
    expect(dmAnchors.get("conv_1")).toBe("c1");

    pages.c1 = { messages: [trigger1, agentReply, trigger2] };
    getDmThread.mockClear();
    expect(await textOf(item2, d)).toBe("trigger two");
    expect(getDmThread).toHaveBeenCalledTimes(1);
    expect(getDmThread).toHaveBeenCalledWith("conv_1", { limit: 200, afterReplyId: "c1" });
  });

  it("retrying the same item after a failed dispatch finds the same message from the anchor", async () => {
    const getDmThread = pagedThread({ "": { messages: old, next: "c1" }, c1: { messages: [trigger1, agentReply] } });
    const d = { ...deps(stubClient({ getDmThread })), dmAnchors: new Map<string, string>() };

    expect(await textOf(item1, d)).toBe("trigger one");
    getDmThread.mockClear();
    expect(await textOf(item1, d)).toBe("trigger one");
    expect(cursorsOf(getDmThread)).toEqual(["c1"]); // no full walk
  });

  it("an anchored miss falls back to a full walk (vanished anchor, then a deleted trigger)", async () => {
    const getDmThread = pagedThread({ "": { messages: old, next: "c1" }, c1: { messages: [trigger1] } });
    const dmAnchors = new Map([["conv_1", "gone"]]); // unknown anchor ⇒ empty, final page
    const d = { ...deps(stubClient({ getDmThread })), dmAnchors };

    expect(await textOf(item1, d)).toBe("trigger one");
    expect(cursorsOf(getDmThread)).toEqual(["gone", undefined, "c1"]);
    expect(dmAnchors.get("conv_1")).toBe("c1");

    // A deleted trigger with a valid anchor: anchored walk misses, full walk misses ⇒ ignored, anchor kept.
    getDmThread.mockClear();
    const res = await mapEvent(event({ itemId: "i3", contentSnippet: "deleted", createdAt: at(-100) }), d);
    expect(res).toEqual({ ignored: true, reason: "dm-message-unavailable" });
    expect(cursorsOf(getDmThread)).toEqual(["c1", undefined, "c1"]);
    expect(dmAnchors.get("conv_1")).toBe("c1");
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
