import type { QuaseApi } from "./quase-client.js";
import { shouldRespond, type RespondPolicy } from "./respond-policy.js";

/**
 * The event → inbound-message mapper: pure and poller-agnostic. Its input is a NORMALIZED
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
}

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

/** Hydrate a `dm_reply` into a dispatchable inbound (owner-1:1 → main, else per-conversation). */
async function mapDmReply(event: QuaseInboxEvent, deps: MapperDeps): Promise<DispatchableInbound> {
  const conversationId = event.refId;
  const thread = await deps.client.getDmThread(conversationId);

  let participants = thread.participantProfiles;
  if (participants.length === 0) {
    // Thread not hydratable via get_dm_thread — fall back to the conversation list.
    const conversations = await deps.client.getConversations();
    const match = conversations.find((c) => c.conversationId === conversationId);
    if (match) participants = match.participantProfiles;
  }

  const lastMessage = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1] : undefined;
  const text = lastMessage?.content || event.contentSnippet || "";

  // Owner-1:1 predicate (§5.8): participants minus the agent === exactly {ownerUserId}.
  const others = participants.map((p) => p.userId).filter((id) => id && id !== deps.agentUserId);
  const isOwnerDm = deps.policy.ownerUserId != null && others.length === 1 && others[0] === deps.policy.ownerUserId;

  return {
    itemId: event.itemId,
    createdAt: event.createdAt,
    conversation: isOwnerDm ? { scope: "main" } : { scope: "conversation", conversationId },
    text,
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
 * event costs no network. Hydration errors propagate so the poller counts a failed dispatch
 * and does not advance the watermark.
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
