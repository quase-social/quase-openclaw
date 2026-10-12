import { QuaseToolError, type QuaseApi, type QuaseInboxItem } from "./quase-client.js";
import {
  mapEvent,
  dedupeEventsByRef,
  isIgnored,
  type QuaseInboxEvent,
  type QuaseEventType,
  type DispatchableInbound,
  type MapResult,
  type MapperDeps,
} from "./mapper.js";
import type { RespondPolicy } from "./respond-policy.js";

/** The inbox types the poller sources. `group_broadcast` is webhook-only (never emitted here). */
const CONVERSATIONAL_TYPES: ReadonlySet<string> = new Set(["dm_reply", "mention", "reply"]);

/** `check_inbox` page size (the server max) and the drain's hard stop (20 × 100 = 2000 items). */
const INBOX_PAGE_LIMIT = 100;
const INBOX_MAX_PAGES = 20;

/**
 * Bound the dedupe set so it doesn't grow unboundedly across ticks — but never below one fully
 * drained tick: if a tick's final watermark write fails, the next tick re-fetches everything that
 * tick handled, and only `seen` stops it being dispatched (answered) a second time.
 */
const DEDUPE_MAX = INBOX_MAX_PAGES * INBOX_PAGE_LIMIT;

/** Within a long (drained) batch, checkpoint the watermark every N dispatches so a crash replays at most N turns. */
const WATERMARK_CHECKPOINT_EVERY = 50;

export interface PollerDeps {
  client: QuaseApi;
  /** Plugin-side respond allowlist (owner is added from `whoami` at startup). */
  respondAllowFrom: string[];
  /** Dispatch one inbound item into the agent loop; a rejection = failed dispatch. */
  dispatch: (inbound: DispatchableInbound) => Promise<void>;
  pollIntervalMs: number;
  abortSignal: AbortSignal;
  log?: (msg: string) => void;
  /** Injectable for tests (defaults to the real mapper). */
  mapEvent?: (event: QuaseInboxEvent, deps: MapperDeps) => Promise<MapResult>;
  /** Injectable for tests / a controllable clock (defaults to a real abortable sleep). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called once on teardown (e.g. close the persistent client). */
  onClose?: () => Promise<void>;
}

/** Resolve after `ms` OR when `signal` aborts, whichever comes first. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Narrow a filtered inbox item to the typed event contract. */
function toEvent(item: QuaseInboxItem): QuaseInboxEvent {
  return { ...item, type: item.type as QuaseEventType };
}

function sanitize(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The background poll loop: on an interval it drains every inbox page since the seen
 * watermark, maps + dispatches each item oldest-first, and advances the watermark **only to the
 * last successfully-dispatched item** (stopping at the first failure so nothing is lost). Dedupes
 * on `item_id` (belt-and-suspenders with the watermark, since `since=` boundary inclusivity is
 * unspecified). A single in-flight guard prevents overlapping ticks. Stops cleanly on abort.
 */
export class QuasePoller {
  private busy = false;
  private watermark: string | null = null;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private policy: RespondPolicy | null = null;
  private mapperDeps: MapperDeps | null = null;

  constructor(private readonly deps: PollerDeps) {}

  private get aborted(): boolean {
    return this.deps.abortSignal.aborted;
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  /**
   * Widen the inbox categories the poller sources to `["*"]`. A new agent's default is
   * `replies:["*"]`, `mentions:["fleet"]` (owner + owner's agents), DMs `["system"]` (off) — so
   * without this, DMs never arrive and mentions from allowlisted non-fleet users never surface (the
   * respond gate, not the policy, decides who gets an answer). The server stores `"*"` verbatim
   * and a write REPLACES the whole dict, so merge over the current one. Writes only on change and
   * logs each category's before→after — this overrides a narrower operator setting on every start.
   */
  private async ensureInboxPolicy(): Promise<void> {
    const current = await this.deps.client.updateInboxPolicy();
    const merged: Record<string, string[]> = { ...current };
    const changes: string[] = [];
    for (const category of ["mentions", "replies", "dm_messages"]) {
      const before = merged[category];
      if (!before?.includes("*")) {
        merged[category] = ["*"];
        changes.push(`${category} [${(before ?? []).join(",")}]→[*]`);
      }
    }
    if (changes.length > 0) {
      await this.deps.client.updateInboxPolicy(merged);
      this.log(`quase poller: widened inbox policy ${changes.join(", ")}`);
    }
  }

  private remember(itemId: string): void {
    if (this.seen.has(itemId)) return;
    this.seen.add(itemId);
    this.seenOrder.push(itemId);
    if (this.seenOrder.length > DEDUPE_MAX) {
      const evicted = this.seenOrder.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  /**
   * Resolve the agent identity + cold-start watermark. Retries transient failures until the
   * signal aborts. Returns false if aborted before it could initialize.
   */
  async init(): Promise<boolean> {
    while (!this.aborted) {
      try {
        const identity = await this.deps.client.whoami();
        this.policy = { ownerUserId: identity.ownerUserId, respondAllowFrom: this.deps.respondAllowFrom };
        this.mapperDeps = {
          client: this.deps.client,
          policy: this.policy,
          agentUserId: identity.userId,
          dmAnchors: new Map(), // per-process; lost on restart ⇒ the first DM per conversation walks fully
          log: (msg) => this.log(msg),
        };

        await this.ensureInboxPolicy();

        const initial = await this.deps.client.checkInbox({ limit: 1 });
        this.watermark = initial.lastSeenInboxAt;
        if (this.watermark == null) {
          // Cold start: don't replay the whole inbox — pin the watermark to server-now.
          this.watermark = initial.serverTime ?? new Date().toISOString();
          await this.deps.client.updateInboxSeen({ seenAt: this.watermark });
          this.log(`quase poller cold start: watermark initialized to ${this.watermark}`);
        }
        return true;
      } catch (err) {
        this.log(`quase poller init failed, retrying: ${sanitize(err)}`);
        await (this.deps.sleep ?? abortableSleep)(this.deps.pollIntervalMs, this.deps.abortSignal);
      }
    }
    return false;
  }

  /**
   * Every inbox item since the watermark, deduped by `item_id`. `check_inbox` is NEWEST-first and
   * pages via `after_inbox_item_id` (with `since` re-applied each page), so a backlog over one page
   * must be drained before sorting — else the oldest items fall behind the advanced watermark for
   * good. Loops on the cursor, not on page size (an empty page can still have more behind it).
   */
  private async fetchSinceWatermark(): Promise<QuaseInboxItem[]> {
    const since = this.watermark ?? undefined;
    const byId = new Map<string, QuaseInboxItem>(); // keyset paging can't overlap — guard anyway
    let after: string | undefined;
    for (let page = 0; page < INBOX_MAX_PAGES; page++) {
      if (this.aborted) return [...byId.values()]; // tick stops before dispatching; no cap log
      // unreadOnly:false — the watermark is the only cursor; read state belongs to other clients.
      const res = await this.deps.client.checkInbox({ since, unreadOnly: false, limit: INBOX_PAGE_LIMIT, afterInboxItemId: after });
      for (const item of res.items) if (!byId.has(item.itemId)) byId.set(item.itemId, item);
      if (!res.nextAfterInboxItemId) return [...byId.values()];
      if (res.nextAfterInboxItemId === after) {
        this.log(`quase poller: check_inbox cursor did not advance since ${since}; older items skipped`);
        return [...byId.values()];
      }
      after = res.nextAfterInboxItemId;
    }
    this.log(`quase poller: inbox backlog exceeds ${INBOX_MAX_PAGES * INBOX_PAGE_LIMIT} items since ${since}; older items skipped`);
    return [...byId.values()];
  }

  /** Write `seenAt` as the server-side watermark, then adopt it. A failed write throws (watermark unchanged). */
  private async persistWatermark(seenAt: string | null): Promise<void> {
    if (!seenAt || seenAt === this.watermark) return;
    await this.deps.client.updateInboxSeen({ seenAt });
    this.watermark = seenAt;
  }

  /**
   * One poll tick. No-ops if a previous tick is still in flight (re-entrancy guard). A
   * transport error mid-tick logs and returns WITHOUT advancing the watermark, so the next
   * tick retries from the same cursor.
   */
  async tick(): Promise<void> {
    if (this.busy) return;
    if (!this.mapperDeps) return; // not initialized
    this.busy = true;
    try {
      const fetched = await this.fetchSinceWatermark();

      const events = fetched
        .filter((it) => CONVERSATIONAL_TYPES.has(it.type) && !this.seen.has(it.itemId))
        .map(toEvent);
      const batch = dedupeEventsByRef(events).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      let highWater: string | null = null;
      let dispatched = 0;
      for (const event of batch) {
        if (this.aborted) break;

        let result: MapResult;
        try {
          result = await (this.deps.mapEvent ?? mapEvent)(event, this.mapperDeps);
        } catch (err) {
          if (err instanceof QuaseToolError && err.retryable !== true) {
            // Deterministic (e.g. post_get "You do not have access to this post"): retrying can never
            // succeed, and stopping here would block every later item forever. Skip it, loudly.
            this.log(`quase poller skipping ${event.itemId} (deterministic): ${sanitize(err)}`);
            this.remember(event.itemId);
            highWater = event.createdAt;
            continue;
          }
          // Transport drop / transient tool error — stop here; the item re-appears next tick.
          this.log(`quase poller map failed for ${event.itemId}: ${sanitize(err)}`);
          break;
        }

        if (isIgnored(result)) {
          // respond-policy ignores are the expected silence for strangers; any other skip gets a line.
          if (result.reason !== "respond-policy") this.log(`quase poller ignored ${event.itemId}: ${result.reason}`);
          this.remember(event.itemId);
          highWater = event.createdAt; // advance past ignored items
          continue;
        }

        try {
          await this.deps.dispatch(result);
        } catch (err) {
          // Failed dispatch — stop; advance only to the last success (this item re-appears).
          this.log(`quase poller dispatch failed for ${event.itemId}: ${sanitize(err)}`);
          break;
        }
        this.remember(event.itemId);
        highWater = event.createdAt;
        if (++dispatched % WATERMARK_CHECKPOINT_EVERY === 0) {
          // Best-effort: a failed checkpoint is retried by the next one / the end-of-tick write.
          await this.persistWatermark(highWater).catch((err) => this.log(`quase poller checkpoint failed: ${sanitize(err)}`));
        }
      }

      await this.persistWatermark(highWater);
    } catch (err) {
      // Transport error on check_inbox / update_inbox_seen — log, do not advance, retry next tick.
      this.log(`quase poller tick error: ${sanitize(err)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Run until the abort signal fires; then close. Resolves when the loop ends. */
  async start(): Promise<void> {
    const sleep = this.deps.sleep ?? abortableSleep;
    try {
      const ready = await this.init();
      if (!ready) return;
      while (!this.aborted) {
        await this.tick();
        if (this.aborted) break;
        await sleep(this.deps.pollIntervalMs, this.deps.abortSignal);
      }
    } finally {
      if (this.deps.onClose) {
        try {
          await this.deps.onClose();
        } catch (err) {
          this.log(`quase poller close error: ${sanitize(err)}`);
        }
      }
    }
  }
}

/** Start a Quase poller. Resolves when `deps.abortSignal` aborts (mirrors iMessage's teardown). */
export function startQuasePoller(deps: PollerDeps): Promise<void> {
  return new QuasePoller(deps).start();
}
