import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { QuaseApi } from "./quase-client.js";
import type { ReplyTarget } from "./mapper.js";

/**
 * The outbound router: the brain behind the per-turn delivery adapter. Core's reply pipeline
 * feeds the agent's generated reply into `deliver(payload, info)`; this routes it back to
 * Quase — `send_dm` for a DM, `reply_create` in-thread for a post — honoring the pinned
 * quirks (explicit `mentions`, never override reply visibility, no mentions on DMs).
 *
 * Invocation is path-independent: this is the same function whether it's called from the
 * Assembled turn's `delivery.deliver` (primary) or a `message`-adapter fallback (if the
 * non-bundled runtime surface is gated). Only the wiring differs, never this logic.
 */

/** What we report back for a delivery (assignable to OpenClaw's `ChannelDeliveryResult`). */
export interface OutboundResult {
  messageIds?: string[];
  visibleReplySent: boolean;
}

export interface OutboundDeps {
  client: QuaseApi;
  log?: (msg: string) => void;
}

/**
 * The reply pipeline emits reasoning/status/compaction/fallback/error notices alongside the
 * visible answer. Only the visible final text goes to Quase — never post a notice as a reply.
 */
function isNonFinal(payload: ReplyPayload): boolean {
  return Boolean(
    payload.isReasoning ||
      payload.isReasoningSnapshot ||
      payload.isStatusNotice ||
      payload.isCompactionNotice ||
      payload.isFallbackNotice ||
      payload.isError,
  );
}

/** Extract unique `@handle` tokens (preceded by start-of-string or whitespace) from reply text. */
function extractHandles(text: string): string[] {
  const re = /(?:^|\s)@([A-Za-z0-9_]+)/g;
  const handles = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) handles.add(m[1]);
  return [...handles];
}

/** Resolve `@handle` tokens in `text` to a Quase `mentions` array (display_name via search_users). */
async function resolveMentions(text: string, client: QuaseApi): Promise<{ handle: string; displayName?: string }[]> {
  const handles = extractHandles(text);
  const mentions: { handle: string; displayName?: string }[] = [];
  for (const handle of handles) {
    const users = await client.searchUsers(handle);
    const match = users.find((u) => u.handle.toLowerCase() === handle.toLowerCase());
    mentions.push({ handle: match?.handle ?? handle, displayName: match?.displayName });
  }
  return mentions;
}

/**
 * Deliver one reply payload to Quase. Returns `{ visibleReplySent: false }` for skipped
 * (non-final) payloads; a real send returns the sent id + `visibleReplySent: true`. A thrown
 * `send_dm`/`reply_create` error propagates so the poller counts the dispatch as failed
 * (watermark not advanced). A dropped mention is logged, NOT a failure — the reply still posted.
 */
export async function routeOutbound(payload: ReplyPayload, target: ReplyTarget, deps: OutboundDeps): Promise<OutboundResult> {
  if (isNonFinal(payload)) return { visibleReplySent: false };

  const text = (payload.text ?? "").trim();
  if (!text) return { visibleReplySent: false };

  const { client, log } = deps;

  if (target.kind === "dm") {
    // DMs do not support @mentions (v1) — never pass a mentions array.
    const res = await client.sendDm({ conversationId: target.conversationId, content: text });
    return { messageIds: res.messageId ? [res.messageId] : [], visibleReplySent: true };
  }

  // Post: resolve any @handles, then reply in-thread. Do NOT set visibility — replies inherit
  // the parent's visibility (a `private` reply that must stay readable is a known footgun).
  const mentions = await resolveMentions(text, client);
  const res = await client.replyCreate({
    parentId: target.parentId,
    replyToId: target.replyToId,
    content: text,
    mentions: mentions.length > 0 ? mentions : undefined,
  });

  if (res.mentionsDropped.length > 0) {
    log?.(`quase reply_create dropped mentions: ${res.mentionsDropped.join(", ")}`);
  }
  const undelivered = res.mentions.filter((m) => !m.userId).map((m) => m.handle);
  if (undelivered.length > 0) {
    log?.(`quase reply_create mentions not delivered (no user_id): ${undelivered.join(", ")}`);
  }

  return { messageIds: res.postId ? [res.postId] : [], visibleReplySent: true };
}
