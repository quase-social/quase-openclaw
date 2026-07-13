import type { QuaseApi, QuaseInboxItem } from "./quase-client.js";
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

/** Bound the dedupe set so it doesn't grow unboundedly across ticks. */
const DEDUPE_MAX = 500;

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
 * The background poll loop: on an interval it pulls new inbox items against the seen
 * watermark, maps + dispatches each, and advances the watermark **only to the last
 * successfully-dispatched item** (stopping at the first failure so nothing is lost). Dedupes
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
   * Enable the inbox categories the poller sources. A Quase agent's inbox is **quiet by
   * default** (every category defaults to `["system"]`), so human-triggered DMs/mentions/
   * replies are filtered out of `check_inbox` until the policy enables them — without this the
   * poller would see nothing. Merges (preserves other categories) and only writes if changed.
   */
  private async ensureInboxPolicy(): Promise<void> {
    const current = await this.deps.client.updateInboxPolicy();
    const merged: Record<string, string[]> = { ...current };
    let changed = false;
    for (const category of ["mentions", "replies", "dm_messages"]) {
      if (!merged[category]?.includes("*")) {
        merged[category] = ["*"];
        changed = true;
      }
    }
    if (changed) {
      await this.deps.client.updateInboxPolicy(merged);
      this.log("quase poller: enabled inbox categories mentions/replies/dm_messages (was quiet-by-default)");
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
        this.mapperDeps = { client: this.deps.client, policy: this.policy, agentUserId: identity.userId };

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
   * One poll tick. No-ops if a previous tick is still in flight (re-entrancy guard). A
   * transport error mid-tick logs and returns WITHOUT advancing the watermark, so the next
   * tick retries from the same cursor.
   */
  async tick(): Promise<void> {
    if (this.busy) return;
    if (!this.mapperDeps) return; // not initialized
    this.busy = true;
    try {
      const res = await this.deps.client.checkInbox({ since: this.watermark ?? undefined, limit: 50 });

      const events = res.items
        .filter((it) => CONVERSATIONAL_TYPES.has(it.type) && !this.seen.has(it.itemId))
        .map(toEvent);
      const batch = dedupeEventsByRef(events).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

      let highWater: string | null = null;
      for (const event of batch) {
        if (this.aborted) break;

        let result: MapResult;
        try {
          result = await (this.deps.mapEvent ?? mapEvent)(event, this.mapperDeps);
        } catch (err) {
          // Hydration failure — stop here; the item re-appears next tick. Don't advance past it.
          this.log(`quase poller map failed for ${event.itemId}: ${sanitize(err)}`);
          break;
        }

        if (isIgnored(result)) {
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
      }

      if (highWater && highWater !== this.watermark) {
        await this.deps.client.updateInboxSeen({ seenAt: highWater });
        this.watermark = highWater;
      }
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
