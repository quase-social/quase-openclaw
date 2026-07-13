import { buildChannelInboundEventContext, runChannelInboundEvent } from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentRoute, buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { QUASE_CHANNEL_ID } from "./config.js";
import type { QuaseApi } from "./quase-client.js";
import type { DispatchableInbound } from "./mapper.js";
import { routeOutbound } from "./outbound.js";

/**
 * Turn a hydrated {@link DispatchableInbound} into a run through the OpenClaw agent loop, via
 * the **Assembled-turn** path (Phase 1 confirmed shapes): no `runDispatch` field, so the
 * kernel builds the dispatcher and threads the agent's reply back through `delivery.deliver`,
 * which routes it to Quase via {@link routeOutbound}.
 *
 * The route + session key are computed **explicitly per event** (plan decision #3): owner 1:1
 * DM → `mainSessionKey`; other DM → a `per-peer` direct key; post thread → a `channel`-kind
 * key by the top-level post. This is deterministic and independent of the operator's `dmScope`.
 *
 * The OpenClaw runtime functions are injected (defaulting to the real imports) so this
 * unit-tests with spies and — if a non-bundled plugin cannot reach the standalone functions
 * at runtime (Risk #1) — only this wiring swaps, never {@link routeOutbound}'s logic.
 */
export interface QuaseDispatchRuntime {
  runChannelInboundEvent: typeof runChannelInboundEvent;
  buildChannelInboundEventContext: typeof buildChannelInboundEventContext;
  resolveAgentRoute: typeof resolveAgentRoute;
  buildAgentSessionKey: typeof buildAgentSessionKey;
  resolveStorePath: typeof resolveStorePath;
  recordInboundSession: typeof recordInboundSession;
  dispatchReplyWithBufferedBlockDispatcher: typeof dispatchReplyWithBufferedBlockDispatcher;
}

/** The real OpenClaw runtime functions (public plugin-sdk subpaths). */
export function defaultDispatchRuntime(): QuaseDispatchRuntime {
  return {
    runChannelInboundEvent,
    buildChannelInboundEventContext,
    resolveAgentRoute,
    buildAgentSessionKey,
    resolveStorePath,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
  };
}

export interface DispatchDeps {
  cfg: OpenClawConfig;
  accountId?: string;
  client: QuaseApi;
  log?: (msg: string) => void;
  runtime?: QuaseDispatchRuntime;
}

/** The route peer an event resolves against (direct DM peer, or channel-kind post peer). */
function routePeer(inbound: DispatchableInbound): { kind: "direct" | "channel"; id: string } {
  if (inbound.replyTarget.kind === "dm") return { kind: "direct", id: inbound.replyTarget.conversationId };
  return { kind: "channel", id: inbound.replyTarget.parentId };
}

/** ConversationFacts for buildContext: post threads are `channel`-kind, DMs are `direct`. */
function conversationFacts(inbound: DispatchableInbound): { kind: "direct" | "channel"; id: string } {
  if (inbound.conversation.scope === "post") return { kind: "channel", id: inbound.conversation.postId };
  const id = inbound.replyTarget.kind === "dm" ? inbound.replyTarget.conversationId : "";
  return { kind: "direct", id };
}

/** ReplyPlanFacts target: the DM conversation or the top-level post, plus an optional reply id. */
function replyFacts(inbound: DispatchableInbound): { to: string; replyToId?: string } {
  if (inbound.replyTarget.kind === "dm") return { to: inbound.replyTarget.conversationId };
  return { to: inbound.replyTarget.parentId, replyToId: inbound.replyTarget.replyToId };
}

/**
 * Build the per-account dispatch closure. Returns a function that dispatches one inbound item
 * and resolves/rejects with the run outcome — a rejection is the poller's "failed dispatch"
 * signal (watermark not advanced).
 */
export function buildQuaseDispatch(deps: DispatchDeps): (inbound: DispatchableInbound) => Promise<void> {
  const runtime = deps.runtime ?? defaultDispatchRuntime();
  const { cfg, accountId, client, log } = deps;
  const channel = QUASE_CHANNEL_ID;
  const store = (cfg as { session?: { store?: string } }).session?.store;

  return async function dispatch(inbound: DispatchableInbound): Promise<void> {
    const route = runtime.resolveAgentRoute({ cfg, channel, accountId, peer: routePeer(inbound) });
    const agentId = route.agentId;

    let routeSessionKey: string;
    if (inbound.conversation.scope === "main") {
      routeSessionKey = route.mainSessionKey ?? route.sessionKey;
    } else if (inbound.conversation.scope === "conversation") {
      routeSessionKey = runtime.buildAgentSessionKey({
        agentId,
        channel,
        accountId,
        peer: { kind: "direct", id: inbound.conversation.conversationId },
        dmScope: "per-peer",
      });
    } else {
      routeSessionKey = runtime.buildAgentSessionKey({
        agentId,
        channel,
        accountId,
        peer: { kind: "channel", id: inbound.conversation.postId },
      });
    }

    const storePath = runtime.resolveStorePath(store, { agentId });
    const timestamp = Date.parse(inbound.createdAt);

    const ctxPayload = runtime.buildChannelInboundEventContext({
      channel,
      accountId,
      messageId: inbound.itemId,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      from: inbound.sender.handle || inbound.sender.userId,
      sender: { id: inbound.sender.userId, name: inbound.sender.displayName ?? inbound.sender.handle },
      conversation: conversationFacts(inbound),
      route: { agentId, accountId: route.accountId, routeSessionKey, mainSessionKey: route.mainSessionKey },
      reply: replyFacts(inbound),
      message: { rawBody: inbound.text, bodyForAgent: inbound.text },
    });

    await runtime.runChannelInboundEvent({
      channel,
      accountId,
      raw: inbound,
      adapter: {
        ingest: () => ({
          id: inbound.itemId,
          rawText: inbound.text,
          timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
        }),
        // Assembled path: NO runDispatch → the kernel dispatches and feeds delivery.deliver.
        resolveTurn: () => ({
          cfg,
          channel,
          accountId,
          agentId,
          routeSessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: runtime.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher: runtime.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: false as const,
            deliver: (payload: ReplyPayload) => routeOutbound(payload, inbound.replyTarget, { client, log }),
          },
        }),
      },
    });
  };
}
