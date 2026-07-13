import { describe, it, expect, vi } from "vitest";
import { QuasePoller, startQuasePoller, type PollerDeps } from "./poller.js";
import type { QuaseApi, QuaseInboxItem, QuaseInboxResult } from "./quase-client.js";
import type { DispatchableInbound, QuaseInboxEvent, MapResult } from "./mapper.js";

const AGENT = "user_agent";
const OWNER = "user_owner";

function makeClient(overrides: Partial<QuaseApi> = {}): QuaseApi {
  return {
    whoami: vi.fn().mockResolvedValue({ userId: AGENT, handle: "botly", accountType: "agent", ownerUserId: OWNER }),
    checkInbox: vi.fn(),
    updateInboxSeen: vi.fn().mockResolvedValue(undefined),
    updateInboxPolicy: vi.fn().mockResolvedValue({ mentions: ["*"], replies: ["*"], dm_messages: ["*"] }),
    postGet: vi.fn(),
    getDmThread: vi.fn(),
    getConversations: vi.fn(),
    sendDm: vi.fn(),
    replyCreate: vi.fn(),
    searchUsers: vi.fn(),
    ...overrides,
  } as QuaseApi;
}

function item(id: string, createdAt: string, type = "reply"): QuaseInboxItem {
  return {
    itemId: id,
    type,
    refId: `post_${id}`,
    refType: "post",
    fromUserId: OWNER,
    fromHandle: "solo",
    createdAt,
    contentSnippet: "",
  };
}

function inbox(items: QuaseInboxItem[], lastSeen: string | null, serverTime = "2026-07-05T00:00:00Z"): QuaseInboxResult {
  return { items, lastSeenInboxAt: lastSeen, serverTime, unreadCount: items.length };
}

function dispatchableFrom(event: QuaseInboxEvent): DispatchableInbound {
  return {
    itemId: event.itemId,
    createdAt: event.createdAt,
    conversation: { scope: "post", postId: event.refId },
    text: "text",
    sender: { userId: event.fromUserId, handle: event.fromHandle },
    replyTarget: { kind: "post", parentId: event.refId },
  };
}

/** A mapper stub: dispatchable by default; items in `ignore` return ignored (no hydration). */
function mapStub(ignore: Set<string> = new Set()) {
  return vi.fn(async (event: QuaseInboxEvent): Promise<MapResult> => {
    if (ignore.has(event.itemId)) return { ignored: true, reason: "respond-policy" };
    return dispatchableFrom(event);
  });
}

function makePoller(deps: Partial<PollerDeps> & { client: QuaseApi }) {
  const controller = new AbortController();
  const full: PollerDeps = {
    respondAllowFrom: [],
    dispatch: vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: 20_000,
    abortSignal: controller.signal,
    mapEvent: mapStub(),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...deps,
  };
  return { poller: new QuasePoller(full), deps: full, controller };
}

describe("QuasePoller.tick — dispatch + watermark", () => {
  it("dispatches oldest→newest and advances the watermark to the last dispatched item", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0")) // init: warm start
        .mockResolvedValueOnce(inbox([item("b", "2026-07-05T02:00:00Z"), item("a", "2026-07-05T01:00:00Z")], "WM0")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    expect(dispatch.mock.calls.map((c) => (c[0] as DispatchableInbound).itemId)).toEqual(["a", "b"]);
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T02:00:00Z" });
  });

  it("stops at the first dispatch failure and advances only to the last success", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(
          inbox(
            [item("a", "2026-07-05T01:00:00Z"), item("b", "2026-07-05T02:00:00Z"), item("c", "2026-07-05T03:00:00Z")],
            "WM0",
          ),
        ),
    });
    const dispatch = vi.fn(async (inb: DispatchableInbound) => {
      if (inb.itemId === "b") throw new Error("dispatch boom");
    });
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    // a dispatched, b attempted+failed, c never attempted
    expect(dispatch.mock.calls.map((c) => (c[0] as DispatchableInbound).itemId)).toEqual(["a", "b"]);
    // watermark advanced only to a's createdAt (the last success)
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T01:00:00Z" });
  });

  it("dedupes a duplicate item across ticks (dispatched once)", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0")) // init
        .mockResolvedValueOnce(inbox([item("a", "2026-07-05T01:00:00Z")], "WM0")) // tick 1
        .mockResolvedValueOnce(inbox([item("a", "2026-07-05T01:00:00Z"), item("b", "2026-07-05T02:00:00Z")], "WM0")), // tick 2: a re-appears
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();
    await poller.tick();

    expect(dispatch.mock.calls.map((c) => (c[0] as DispatchableInbound).itemId)).toEqual(["a", "b"]);
  });

  it("advances the watermark past ignored items without dispatching them", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(inbox([item("x", "2026-07-05T01:00:00Z")], "WM0")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch, mapEvent: mapStub(new Set(["x"])) });

    await poller.init();
    await poller.tick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T01:00:00Z" });
  });

  it("filters out group_broadcast (poller never sources it)", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(inbox([item("g", "2026-07-05T01:00:00Z", "group_broadcast")], "WM0")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("QuasePoller — cold start + re-entrancy", () => {
  it("enables quiet-by-default inbox categories at init (merges, preserves others)", async () => {
    const updateInboxPolicy = vi
      .fn()
      .mockResolvedValueOnce({ mentions: ["system"], replies: ["system"], dm_messages: ["system"], reactions: ["system"] }) // read
      .mockResolvedValueOnce({}); // write
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")), updateInboxPolicy });
    const { poller } = makePoller({ client });

    await poller.init();

    // read (no arg), then write the merged policy
    expect(updateInboxPolicy).toHaveBeenCalledTimes(2);
    expect(updateInboxPolicy.mock.calls[0]).toEqual([]); // read
    expect(updateInboxPolicy.mock.calls[1][0]).toEqual({
      mentions: ["*"],
      replies: ["*"],
      dm_messages: ["*"],
      reactions: ["system"], // preserved
    });
  });

  it("does not rewrite the inbox policy when the needed categories are already enabled", async () => {
    const updateInboxPolicy = vi.fn().mockResolvedValue({ mentions: ["*"], replies: ["*"], dm_messages: ["*"] });
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")), updateInboxPolicy });
    const { poller } = makePoller({ client });

    await poller.init();

    expect(updateInboxPolicy).toHaveBeenCalledTimes(1); // read only, no write
  });

  it("cold start pins the watermark to serverTime and does not replay history", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        // init: never-seen watermark, with history present in the payload
        .mockResolvedValueOnce(inbox([item("old", "2026-07-01T00:00:00Z")], null, "2026-07-05T00:00:00Z"))
        // first real tick since serverTime → nothing new
        .mockResolvedValueOnce(inbox([], "2026-07-05T00:00:00Z")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T00:00:00Z" });

    await poller.tick();
    expect(dispatch).not.toHaveBeenCalled(); // history was NOT replayed
  });

  it("a tick fired while a previous tick is in flight no-ops", async () => {
    let resolveInbox: ((v: QuaseInboxResult) => void) | undefined;
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0")) // init
        .mockImplementationOnce(() => new Promise<QuaseInboxResult>((r) => (resolveInbox = r))), // tick 1: hangs
    });
    const { poller } = makePoller({ client });
    await poller.init();
    (client.checkInbox as ReturnType<typeof vi.fn>).mockClear();

    const p1 = poller.tick(); // enters, sets busy, awaits the hanging checkInbox
    const p2 = poller.tick(); // busy → no-op
    resolveInbox?.(inbox([], "WM0"));
    await Promise.all([p1, p2]);

    expect(client.checkInbox).toHaveBeenCalledTimes(1); // only the in-flight tick fetched
  });
});

describe("startQuasePoller — loop teardown", () => {
  it("stops on abort and closes exactly once", async () => {
    const controller = new AbortController();
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")) });
    const onClose = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn(async () => {
      controller.abort();
    });

    await startQuasePoller({
      client,
      respondAllowFrom: [],
      dispatch: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 20_000,
      abortSignal: controller.signal,
      mapEvent: mapStub(),
      sleep,
      onClose,
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not start ticking if aborted before init completes", async () => {
    const controller = new AbortController();
    controller.abort(); // already aborted
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")) });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn().mockResolvedValue(undefined);

    await startQuasePoller({
      client,
      respondAllowFrom: [],
      dispatch,
      pollIntervalMs: 20_000,
      abortSignal: controller.signal,
      mapEvent: mapStub(),
      sleep: vi.fn().mockResolvedValue(undefined),
      onClose,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1); // still closes
  });
});
