import { describe, it, expect, vi } from "vitest";
import { QuasePoller, startQuasePoller, type PollerDeps } from "./poller.js";
import { QuaseToolError, type QuaseApi, type QuaseInboxItem, type QuaseInboxResult } from "./quase-client.js";
import type { DispatchableInbound, QuaseInboxEvent, MapResult, MapperDeps } from "./mapper.js";

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

/** One `check_inbox` page of a drained backlog (warm watermark "WM0"); `next` = older items remain. */
function page(items: QuaseInboxItem[], next?: string): QuaseInboxResult {
  return { ...inbox(items, "WM0"), truncated: next != null, nextAfterInboxItemId: next };
}

/** `n` distinct reply items `${prefix}0…`, one second apart (ascending) from 01:00:00. */
function items(n: number, prefix = "i"): QuaseInboxItem[] {
  return Array.from({ length: n }, (_, i) => item(`${prefix}${i}`, new Date(Date.UTC(2026, 6, 5, 1, 0, i)).toISOString()));
}

function dispatchedIds(dispatch: ReturnType<typeof vi.fn>): string[] {
  return dispatch.mock.calls.map((c) => (c[0] as DispatchableInbound).itemId);
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
    // the tick reads by watermark only — never filtered by read state
    expect((client.checkInbox as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatchObject({ since: "WM0", unreadOnly: false });
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
    const log = vi.fn();
    const { poller } = makePoller({ client, dispatch, log, mapEvent: mapStub(new Set(["x"])) });

    await poller.init();
    await poller.tick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T01:00:00Z" });
    // respond-policy silence is expected — no "ignored" line for it
    expect(log.mock.calls.some((c) => String(c[0]).includes("ignored"))).toBe(false);
  });

  it("logs a non-policy ignore (e.g. a deleted DM) and still advances past it", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(inbox([item("gone", "2026-07-05T01:00:00Z", "dm_reply")], "WM0")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const mapEvent = vi.fn(async (): Promise<MapResult> => ({ ignored: true, reason: "dm-message-unavailable" }));
    const { poller } = makePoller({ client, dispatch, log, mapEvent });

    await poller.init();
    await poller.tick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("quase poller ignored gone: dm-message-unavailable");
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T01:00:00Z" });
  });

  it("init wires one DM anchor cache + a log sink into the mapper deps, shared across ticks", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(inbox([item("a", "2026-07-05T01:00:00Z", "dm_reply")], "WM0"))
        .mockResolvedValueOnce(inbox([item("b", "2026-07-05T02:00:00Z", "dm_reply")], "WM0")),
    });
    const mapEvent = mapStub();
    const { poller } = makePoller({ client, mapEvent });

    await poller.init();
    await poller.tick();
    await poller.tick();

    expect(mapEvent).toHaveBeenCalledTimes(2);
    const [first, second] = mapEvent.mock.calls.map((c) => (c as unknown[])[1] as MapperDeps);
    expect(first.dmAnchors).toBeInstanceOf(Map);
    expect(second.dmAnchors).toBe(first.dmAnchors);
    expect(typeof first.log).toBe("function");
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

describe("QuasePoller.tick — hydration failure classification", () => {
  /** Tick over items a (01:00) and b (02:00), where mapping `a` throws `err`. */
  async function tickWithMapFailure(err: Error) {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(inbox([item("a", "2026-07-05T01:00:00Z"), item("b", "2026-07-05T02:00:00Z")], "WM0")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const mapEvent = vi.fn(async (event: QuaseInboxEvent): Promise<MapResult> => {
      if (event.itemId === "a") throw err;
      return dispatchableFrom(event);
    });
    const { poller } = makePoller({ client, dispatch, log, mapEvent });
    await poller.init();
    await poller.tick();
    return { client, dispatch, log };
  }

  it("skips a deterministic tool error (no retryable) and keeps going", async () => {
    const { client, dispatch, log } = await tickWithMapFailure(new QuaseToolError("post_get", "You do not have access to this post"));
    expect(dispatchedIds(dispatch)).toEqual(["b"]);
    expect(log.mock.calls.some((c) => String(c[0]).includes("skipping a"))).toBe(true);
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T02:00:00Z" });
  });

  it("stops on a retryable:true tool error (nothing dispatched, watermark unchanged)", async () => {
    const { client, dispatch } = await tickWithMapFailure(new QuaseToolError("post_get", "internal error", true));
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.updateInboxSeen).not.toHaveBeenCalled();
  });

  it("stops on a transport error (plain Error)", async () => {
    const { client, dispatch, log } = await tickWithMapFailure(new Error("socket hang up"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.updateInboxSeen).not.toHaveBeenCalled();
    expect(log.mock.calls.some((c) => String(c[0]).includes("map failed for a"))).toBe(true);
  });
});

describe("QuasePoller.tick — paged inbox drain", () => {
  it("drains every page before dispatching, oldest→newest", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0")) // init
        .mockResolvedValueOnce(page([item("d", "2026-07-05T04:00:00Z"), item("c", "2026-07-05T03:00:00Z")], "cur1")) // newest page
        .mockResolvedValueOnce(page([item("b", "2026-07-05T02:00:00Z"), item("a", "2026-07-05T01:00:00Z")])), // older, last
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    expect(dispatchedIds(dispatch)).toEqual(["a", "b", "c", "d"]);
    expect(client.checkInbox).toHaveBeenNthCalledWith(2, { since: "WM0", unreadOnly: false, limit: 100 });
    expect(client.checkInbox).toHaveBeenNthCalledWith(3, { since: "WM0", unreadOnly: false, limit: 100, afterInboxItemId: "cur1" });
    expect(client.updateInboxSeen).toHaveBeenCalledWith({ seenAt: "2026-07-05T04:00:00Z" });
  });

  it("an empty page with a cursor keeps draining", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(page([item("b", "2026-07-05T02:00:00Z")], "cur1"))
        .mockResolvedValueOnce(page([], "cur2"))
        .mockResolvedValueOnce(page([item("a", "2026-07-05T01:00:00Z")])),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    expect(client.checkInbox).toHaveBeenCalledTimes(4);
    expect(dispatchedIds(dispatch)).toEqual(["a", "b"]);
  });

  it("an item repeated across pages is dispatched once", async () => {
    const d = item("d", "2026-07-05T04:00:00Z");
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(page([d, item("c", "2026-07-05T03:00:00Z")], "cur1"))
        .mockResolvedValueOnce(page([d, item("a", "2026-07-05T01:00:00Z")])),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const { poller } = makePoller({ client, dispatch });

    await poller.init();
    await poller.tick();

    expect(dispatchedIds(dispatch)).toEqual(["a", "c", "d"]);
  });

  it("stops at the page cap, logs the skipped remainder, and dispatches each fetched item once", async () => {
    let n = 0;
    const checkInbox = vi
      .fn()
      .mockResolvedValueOnce(inbox([], "WM0"))
      .mockImplementation(async () => {
        const i = n++;
        return page([item(`p${i}`, new Date(Date.UTC(2026, 6, 5, 3, 0, 0) - i * 1000).toISOString())], `cur${i}`);
      });
    const client = makeClient({ checkInbox });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { poller } = makePoller({ client, dispatch, log });

    await poller.init();
    checkInbox.mockClear();
    await poller.tick();

    expect(checkInbox).toHaveBeenCalledTimes(20);
    expect(log.mock.calls.some((c) => String(c[0]).includes("older items skipped"))).toBe(true);
    const ids = dispatchedIds(dispatch);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("a cursor that does not advance stops the drain with a log", async () => {
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(page([item("b", "2026-07-05T02:00:00Z")], "cur1"))
        .mockResolvedValueOnce(page([item("a", "2026-07-05T01:00:00Z")], "cur1")), // stuck
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { poller } = makePoller({ client, dispatch, log });

    await poller.init();
    await poller.tick();

    expect(client.checkInbox).toHaveBeenCalledTimes(3); // init + 2 pages
    expect(log.mock.calls.some((c) => String(c[0]).includes("cursor did not advance"))).toBe(true);
    expect(dispatchedIds(dispatch)).toEqual(["a", "b"]);
  });

  it("an abort mid-drain stops before the next page and dispatches/writes nothing", async () => {
    let abort = () => {};
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockImplementationOnce(async () => {
          abort();
          return page([item("a", "2026-07-05T01:00:00Z")], "cur1");
        }),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { poller, controller } = makePoller({ client, dispatch, log });
    abort = () => controller.abort();

    await poller.init();
    await poller.tick();

    expect(client.checkInbox).toHaveBeenCalledTimes(2); // init + page 1 only
    expect(log.mock.calls.some((c) => /backlog exceeds|older items skipped/.test(String(c[0])))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(client.updateInboxSeen).not.toHaveBeenCalled();
  });

  it("a >500-item drained tick whose watermark write fails re-dispatches nothing next tick", async () => {
    const backlog = items(600);
    const pages: Record<string, QuaseInboxResult> = {};
    for (let p = 0; p < 6; p++) {
      const newestFirst = backlog.slice(600 - (p + 1) * 100, 600 - p * 100).reverse();
      pages[p === 0 ? "" : `cur${p}`] = page(newestFirst, p < 5 ? `cur${p + 1}` : undefined);
    }
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockImplementation(async (args?: { afterInboxItemId?: string }) => pages[args?.afterInboxItemId ?? ""]),
      updateInboxSeen: vi.fn().mockRejectedValue(new Error("update_inbox_seen failed")),
    });
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const { poller } = makePoller({ client, dispatch, log });

    await poller.init();
    await poller.tick(); // dispatches all 600; checkpoints + the final write all fail
    expect(dispatch).toHaveBeenCalledTimes(600);
    expect(log.mock.calls.some((c) => String(c[0]).includes("checkpoint failed"))).toBe(true);

    await poller.tick(); // re-fetches the same 600 since the unchanged watermark
    expect(dispatch).toHaveBeenCalledTimes(600);
  });

  it("checkpoints the watermark every 50 dispatches within a long batch", async () => {
    const backlog = items(120);
    const client = makeClient({
      checkInbox: vi
        .fn()
        .mockResolvedValueOnce(inbox([], "WM0"))
        .mockResolvedValueOnce(page([...backlog].reverse())),
    });
    const { poller } = makePoller({ client });

    await poller.init();
    await poller.tick();

    expect((client.updateInboxSeen as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      { seenAt: backlog[49].createdAt },
      { seenAt: backlog[99].createdAt },
      { seenAt: backlog[119].createdAt },
    ]);
  });
});

describe("QuasePoller — cold start + re-entrancy", () => {
  it("widens the agent-default inbox policy at init (merges, preserves others, logs before→after)", async () => {
    const agentDefault = {
      mentions: ["fleet"],
      replies: ["*"],
      dm_messages: ["system"],
      reactions: ["system"],
      group_activity: ["system"],
      annotations: ["system"],
      system: ["system"],
    };
    const updateInboxPolicy = vi
      .fn()
      .mockResolvedValueOnce(agentDefault) // read
      .mockResolvedValueOnce({}); // write
    const log = vi.fn();
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")), updateInboxPolicy });
    const { poller } = makePoller({ client, log });

    await poller.init();

    // read (no arg), then write the merged policy
    expect(updateInboxPolicy).toHaveBeenCalledTimes(2);
    expect(updateInboxPolicy.mock.calls[0]).toEqual([]); // read
    expect(updateInboxPolicy.mock.calls[1][0]).toEqual({ ...agentDefault, mentions: ["*"], dm_messages: ["*"] }); // others preserved
    const widened = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("widened inbox policy"));
    expect(widened).toHaveLength(1);
    expect(widened[0]).toContain("mentions [fleet]→[*]");
    expect(widened[0]).toContain("dm_messages [system]→[*]");
    expect(widened[0]).not.toContain("replies");
  });

  it("widens only mentions for the live dev-agent state (DMs already open)", async () => {
    const updateInboxPolicy = vi
      .fn()
      .mockResolvedValueOnce({ mentions: ["fleet"], replies: ["*"], dm_messages: ["*"] })
      .mockResolvedValueOnce({});
    const log = vi.fn();
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")), updateInboxPolicy });
    const { poller } = makePoller({ client, log });

    await poller.init();

    expect(updateInboxPolicy.mock.calls[1][0]).toEqual({ mentions: ["*"], replies: ["*"], dm_messages: ["*"] });
    expect(log).toHaveBeenCalledWith("quase poller: widened inbox policy mentions [fleet]→[*]");
  });

  it("does not rewrite the inbox policy when the needed categories are already enabled", async () => {
    const updateInboxPolicy = vi.fn().mockResolvedValue({ mentions: ["*"], replies: ["*"], dm_messages: ["*"] });
    const log = vi.fn();
    const client = makeClient({ checkInbox: vi.fn().mockResolvedValue(inbox([], "WM0")), updateInboxPolicy });
    const { poller } = makePoller({ client, log });

    await poller.init();

    expect(updateInboxPolicy).toHaveBeenCalledTimes(1); // read only, no write
    expect(log.mock.calls.some((c) => String(c[0]).includes("widened"))).toBe(false);
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
