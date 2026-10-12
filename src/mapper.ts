import type { QuaseApi, QuaseDmMessage, QuaseParticipant } from "./quase-client.js";
import { shouldRespond, type RespondPolicy } from "./respond-policy.js";

/**
 * The event → inbound-message mapper: pure and poller-agnostic (any cross-call cache is
 * caller-owned and passed in via {@link MapperDeps}). Its input is a NORMALIZED
 * Quase inbox event that a webhook payload can also produce (the phase's one forward-looking
 * design constraint — webhook delivery becomes a second front door into this same mapper).
 * It applies the respond policy, hydrates the referenced post/conversation, and computes the
 * conversation identity + reply target — channel-neutral (no OpenClaw session key yet; that
 * is the poller/dispatch's job).
 */

/** The conversational wake types. `group_broadcast` is webhook-only (dormant in polling v1). */
export type QuaseEventType = "dm_reply" | "mention" | "reply" | "group_broadcast";

/** The normalized inbound event. Poll AND webhook both produce this shape. */
export interface QuaseInboxEvent {
  itemId: string;
  type: QuaseEventType;
  refId: string;
  refType: string;
  fromUserId: string;
  fromHandle: string;
  fromDisplayName?: string;
  createdAt: string;
  contentSnippet?: string;
  groupId?: string;
}

/** Where the conversation lives (drives the session key downstream). */
export type ConversationScope =
  | { scope: "main" } // owner 1:1 DM → agent main session
  | { scope: "conversation"; conversationId: string } // other DM → per-conversation
  | { scope: "post"; postId: string }; // post thread → per-post (top-level post_...)

/** Where a reply goes back (drives send_dm vs reply_create). */
export type ReplyTarget =
  | { kind: "dm"; conversationId: string }
  | { kind: "post"; parentId: string; replyToId?: string };

/** What the poller dispatches: channel-neutral, fully hydrated, with a reply target. */
export interface DispatchableInbound {
  itemId: string;
  createdAt: string;
  conversation: ConversationScope;
  text: string;
  sender: { userId: string; handle: string; displayName?: string };
  replyTarget: ReplyTarget;
}

/** A mapped event is either dispatchable or ignored (with a reason, for logging). */
export type MapResult = DispatchableInbound | { ignored: true; reason: string };

export function isIgnored(result: MapResult): result is { ignored: true; reason: string } {
  return "ignored" in result;
}

/** Dependencies the mapper needs — injected so it unit-tests fully offline. */
export interface MapperDeps {
  client: QuaseApi;
  policy: RespondPolicy;
  agentUserId: string;
  /** Optional caller-owned cache: conversationId → DM page anchor (see {@link mapDmReply}). A shortcut only. */
  dmAnchors?: Map<string, string>;
  /** Optional sink for hydration cost warnings. */
  log?: (msg: string) => void;
}

/** `get_dm_thread` page size — the server max (its default is 10). */
const DM_THREAD_PAGE_LIMIT = 200;
/** A single walk past this many pages (2,000 messages) logs a cost warning. */
const DM_THREAD_WARN_PAGES = 10;
/** Runaway guard only (200k messages) — far above any real thread; the visited-cursor set catches cycles. */
const DM_THREAD_MAX_PAGES = 1000;
/** A `dm_reply` row is written in the same `send_dm` request as its message (ms apart). Generous on purpose. */
const DM_MATCH_WINDOW_MS = 10 * 60_000;
/** Bound the anchor cache (one entry per DM conversation; an evicted one only costs a full walk). */
const DM_ANCHORS_MAX = 500;

/** The sender identity a respond decision is made on. */
function subjectOf(event: QuaseInboxEvent) {
  return { fromUserId: event.fromUserId, fromHandle: event.fromHandle, groupId: event.groupId };
}

/**
 * Collapse a poll batch so a `mention` and a `reply` for the SAME post (`refId`) map once,
 * preferring the `reply` (Quase's own dedup usually prevents this, but guard anyway). Only
 * mention/reply are collapsed; each `dm_reply` / `group_broadcast` passes through untouched.
 */
export function dedupeEventsByRef(events: QuaseInboxEvent[]): QuaseInboxEvent[] {
  const postEventIndex = new Map<string, number>(); // refId → index in `out`
  const out: QuaseInboxEvent[] = [];
  for (const event of events) {
    if ((event.type === "mention" || event.type === "reply") && event.refId) {
      const existing = postEventIndex.get(event.refId);
      if (existing !== undefined) {
        // Prefer the reply over the mention for the same post.
        if (event.type === "reply") out[existing] = event;
        continue;
      }
      postEventIndex.set(event.refId, out.length);
    }
    out.push(event);
  }
  return out;
}

/** Sent within [row − window, row]? Unparsable on either side ⇒ can't tell, so don't exclude. */
function sentJustBefore(messageCreatedAt: string | undefined, itemCreatedAt: string): boolean {
  const sent = messageCreatedAt != null ? Date.parse(messageCreatedAt) : NaN;
  const announced = Date.parse(itemCreatedAt);
  if (Number.isNaN(sent) || Number.isNaN(announced)) return true;
  return sent <= announced && sent >= announced - DM_MATCH_WINDOW_MS;
}

/**
 * Is `message` the one this `dm_reply` row announces? The row stores NO message id — only the
 * sender, the first 80 code points of the text (`content_snippet`), and a timestamp stamped
 * milliseconds after the message's own (same request). The snippet check is a PREFIX test: the
 * server truncates by code point, so comparing against a JS 80-unit slice breaks on astral
 * characters. No snippet ⇒ sender + time only. The time window's lower bound keeps an old
 * identical-prefix message from standing in for a deleted trigger.
 */
function announces(event: QuaseInboxEvent, message: QuaseDmMessage): boolean {
  return (
    message.fromUserId === event.fromUserId &&
    (event.contentSnippet == null || message.content.startsWith(event.contentSnippet)) &&
    sentJustBefore(message.createdAt, event.createdAt)
  );
}

interface DmWalk {
  complete: boolean; // reached the end of the thread (null cursor)
  match?: QuaseDmMessage; // the LATEST message the item announces
  matchAnchor?: string; // the after_reply_id that fetched match's page — strictly older than match
  participants: QuaseParticipant[];
}

/**
 * Walk `get_dm_thread` forward from `start` (undefined = the oldest message) to the end of the
 * thread, keeping the latest message the item {@link announces}. Loops on the cursor, not page
 * size (the server returns empty-but-more pages). A repeated cursor is a server bug — stop
 * (incomplete) rather than spin. A long walk is logged so its O(n) cost is visible.
 */
async function walkDmThread(event: QuaseInboxEvent, deps: MapperDeps, start?: string): Promise<DmWalk> {
  const conversationId = event.refId;
  const visited = new Set<string>();
  let participants: QuaseParticipant[] | undefined;
  let match: QuaseDmMessage | undefined;
  let matchAnchor: string | undefined;
  let anchor = start;
  let pages = 0;
  let complete = false;
  while (pages < DM_THREAD_MAX_PAGES) {
    if (anchor !== undefined) visited.add(anchor);
    const page = await deps.client.getDmThread(conversationId, { limit: DM_THREAD_PAGE_LIMIT, afterReplyId: anchor });
    pages++;
    participants ??= page.participantProfiles;
    for (const message of page.messages) {
      if (announces(event, message)) {
        match = message; // oldest-first ⇒ the last match is the latest
        matchAnchor = anchor;
      }
    }
    if (!page.nextAfterReplyId) {
      complete = true;
      break;
    }
    if (visited.has(page.nextAfterReplyId)) break; // cursor cycled — don't spin
    anchor = page.nextAfterReplyId;
  }
  if (pages > DM_THREAD_WARN_PAGES) {
    deps.log?.(`quase dm hydration: walked ${pages} pages (~${pages * DM_THREAD_PAGE_LIMIT} messages) of ${conversationId}`);
  }
  return { complete, match, matchAnchor, participants: participants ?? [] };
}

/** Cache `anchor` for `conversationId`, most-recently-used last, bounded. */
function rememberAnchor(anchors: Map<string, string>, conversationId: string, anchor: string | undefined): void {
  anchors.delete(conversationId);
  if (anchor === undefined) return; // match was on the thread's first page — nothing to skip
  anchors.set(conversationId, anchor);
  if (anchors.size > DM_ANCHORS_MAX) {
    const oldest = anchors.keys().next().value;
    if (oldest !== undefined) anchors.delete(oldest);
  }
}

/**
 * Hydrate a `dm_reply` into a dispatchable inbound (owner-1:1 → main, else per-conversation).
 * `get_dm_thread` is oldest-first and paged, so walk it to the end and take the LATEST message
 * the item {@link announces} — never "the last message", which is stale past one page, is the
 * agent's own reply once it has answered, or belongs to a sibling DM in the same tick. No match ⇒
 * the message was deleted (or hidden) after the row was read: ignore the item. Never fall back to
 * the snippet (that resurrects deleted text) or to another message.
 *
 * `deps.dmAnchors` lets the walk start at the page anchor of the conversation's last match instead
 * of the oldest message. It is a shortcut only: an anchored walk that finds a match returns exactly
 * what a full walk would (the latest match is at/after any match, so it's after the anchor), and an
 * anchored walk that misses or is incomplete is redone from the start. The anchor is strictly older
 * than the matched message, so retrying the same item after a failed dispatch still finds it.
 */
async function mapDmReply(event: QuaseInboxEvent, deps: MapperDeps): Promise<MapResult> {
  const conversationId = event.refId;
  const cached = deps.dmAnchors?.get(conversationId);

  let walk = await walkDmThread(event, deps, cached);
  if (cached !== undefined && (!walk.match || !walk.complete)) {
    walk = await walkDmThread(event, deps); // the shortcut missed — decide on a full walk
  }
  // Stopped short of the end: the newest messages (where the trigger most likely is) were never read.
  if (!walk.complete) return { ignored: true, reason: "dm-thread-incomplete" };
  if (!walk.match) return { ignored: true, reason: "dm-message-unavailable" };
  if (deps.dmAnchors) rememberAnchor(deps.dmAnchors, conversationId, walk.matchAnchor);

  let participants = walk.participants;
  if (participants.length === 0) {
    // Thread not hydratable via get_dm_thread — fall back to the conversation list.
    const conversations = await deps.client.getConversations();
    const found = conversations.find((c) => c.conversationId === conversationId);
    if (found) participants = found.participantProfiles;
  }

  // Owner-1:1 predicate (§5.8): participants minus the agent === exactly {ownerUserId}.
  const others = participants.map((p) => p.userId).filter((id) => id && id !== deps.agentUserId);
  const isOwnerDm = deps.policy.ownerUserId != null && others.length === 1 && others[0] === deps.policy.ownerUserId;

  return {
    itemId: event.itemId,
    createdAt: event.createdAt,
    conversation: isOwnerDm ? { scope: "main" } : { scope: "conversation", conversationId },
    text: walk.match.content,
    sender: { userId: event.fromUserId, handle: event.fromHandle, displayName: event.fromDisplayName },
    replyTarget: { kind: "dm", conversationId },
  };
}

/** Hydrate a `mention`/`reply`/`group_broadcast` post into a dispatchable inbound (per-post thread). */
async function mapPostEvent(event: QuaseInboxEvent, deps: MapperDeps): Promise<DispatchableInbound> {
  const post = await deps.client.postGet(event.refId);
  const topLevelId = post.parentId ?? event.refId;
  const text = post.content || event.contentSnippet || "";

  return {
    itemId: event.itemId,
    createdAt: event.createdAt,
    conversation: { scope: "post", postId: topLevelId },
    text,
    sender: { userId: event.fromUserId, handle: event.fromHandle, displayName: event.fromDisplayName },
    // Target the specific reply only when the referenced post is itself a reply (parentId != null).
    replyTarget: { kind: "post", parentId: topLevelId, replyToId: post.parentId != null ? event.refId : undefined },
  };
}

/**
 * Map a normalized event to a dispatchable inbound, or ignore it. The respond gate runs
 * FIRST and short-circuits before any hydration — an ignored (non-owner, non-allowlisted)
 * event costs no network. Hydration errors propagate: the poller retries transport/transient
 * failures and skips deterministic Quase tool errors.
 */
export async function mapEvent(event: QuaseInboxEvent, deps: MapperDeps): Promise<MapResult> {
  if (!shouldRespond(subjectOf(event), deps.policy)) {
    return { ignored: true, reason: "respond-policy" };
  }

  switch (event.type) {
    case "dm_reply":
      return mapDmReply(event, deps);
    case "mention":
    case "reply":
      return mapPostEvent(event, deps);
    case "group_broadcast":
      // DORMANT: the poller never emits this in v1 (group_broadcast is webhook-only, with no
      // inbox backstop). The branch exists so the future webhook front door reuses this mapper.
      return mapPostEvent(event, deps);
    default: {
      const exhaustive: never = event.type;
      return { ignored: true, reason: `unhandled-type:${String(exhaustive)}` };
    }
  }
}
