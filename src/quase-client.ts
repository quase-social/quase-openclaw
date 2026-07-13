import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { QuaseAccountConfig } from "./config.js";

/**
 * Structured outcome of a live connectivity check against Quase. WI-0's whole point is to
 * report crisp status for each of these cases; the mapping to human text lives in
 * {@link describeConnectivity}.
 */
export type ConnectivityResult =
  | { status: "connected"; userId: string; handle: string; accountType: "agent"; ownerUserId?: string }
  | { status: "wrong_account_type"; userId: string; handle: string; accountType: string }
  | { status: "unauthorized" } // token missing / invalid (401)
  | { status: "unreachable"; detail: string }; // network / DNS / unexpected response

/** Minimal MCP client surface used here — narrow enough to stub per-instance in tests. */
export interface QuaseClientHandle {
  client: Pick<Client, "connect" | "callTool" | "close">;
  transport: { close: () => Promise<void> };
}

/** Factory used by {@link verifyConnectivity} and {@link QuaseSession}; overridable in tests. */
export type QuaseClientFactory = (cfg: QuaseAccountConfig, version: string) => QuaseClientHandle;

/**
 * Build an MCP client + Streamable-HTTP transport that presents the agent token as a
 * static bearer via `requestInit.headers`. No `authProvider` is passed: with a static
 * bearer the SDK's OAuth-recovery branches are skipped, so a rejected token surfaces as a
 * `StreamableHTTPError` with `code === 401` (see {@link verifyConnectivity}).
 */
export function createQuaseClient(cfg: QuaseAccountConfig, version: string): QuaseClientHandle {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
  });
  const client = new Client({ name: "quase-openclaw", version });
  return { client, transport };
}

interface CallToolResultLike {
  structuredContent?: unknown;
  content?: unknown;
  isError?: boolean;
}

interface WhoamiIdentity {
  userId: string;
  handle: string;
  accountType: string;
  ownerUserId?: string;
}

/** Pull the JSON payload out of a CallToolResult: prefer structuredContent, else the first JSON text block. */
function extractResultJson(res: CallToolResultLike): unknown {
  if (res.structuredContent != null) return res.structuredContent;
  const content = res.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string"
      ) {
        try {
          return JSON.parse((item as { text: string }).text);
        } catch {
          // fall through to the next content block
        }
      }
    }
  }
  return undefined;
}

/** Read user_id / handle / profile.account_type from a parsed whoami object. */
function parseWhoamiIdentity(res: CallToolResultLike): WhoamiIdentity | null {
  const raw = extractResultJson(res);
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const profile = (obj.profile && typeof obj.profile === "object" ? obj.profile : {}) as Record<string, unknown>;

  const userId = String(obj.user_id ?? obj.userId ?? profile.user_id ?? "");
  const handle = String(obj.handle ?? profile.handle ?? "");
  const accountType = String(profile.account_type ?? obj.account_type ?? "");
  const ownerRaw = profile.owner_user_id ?? obj.owner_user_id;
  const ownerUserId = ownerRaw != null && ownerRaw !== "" ? String(ownerRaw) : undefined;

  if (!userId && !handle) return null;
  return { userId, handle, accountType, ownerUserId };
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 401) return true;
  if (err instanceof UnauthorizedError) return true;
  return false;
}

/** Never leak the token into an error surfaced to logs/users. */
function sanitizeDetail(err: unknown, token: string): string {
  let msg = err instanceof Error ? err.message : String(err);
  if (token) msg = msg.split(token).join("***");
  return msg;
}

async function safeClose(handle: QuaseClientHandle): Promise<void> {
  // Close via the client only. Client.close() tears down its transport; also calling
  // transport.close() double-frees a half-open transport (e.g. after a 401 mid-connect),
  // which trips a libuv UV_HANDLE_CLOSING assertion on Windows.
  try {
    await handle.client.close();
  } catch {
    // best-effort
  }
}

/**
 * Connect to Quase, resolve the agent's own identity via the `whoami` MCP tool, and
 * return a structured {@link ConnectivityResult}. Pure with respect to config: it takes
 * an already-resolved {@link QuaseAccountConfig} and does not read env directly (token
 * resolution is the channel base's job). Never logs the token.
 */
export async function verifyConnectivity(
  cfg: QuaseAccountConfig,
  version: string,
  factory: QuaseClientFactory = createQuaseClient,
): Promise<ConnectivityResult> {
  const handle = factory(cfg, version);
  try {
    await handle.client.connect(handle.transport as never);
    const res = (await handle.client.callTool({ name: "whoami", arguments: {} })) as CallToolResultLike;

    if (res.isError) {
      return { status: "unreachable", detail: "Quase whoami returned a tool error." };
    }

    const identity = parseWhoamiIdentity(res);
    if (!identity) {
      return { status: "unreachable", detail: "Unexpected whoami response shape." };
    }

    if (identity.accountType === "agent") {
      return {
        status: "connected",
        userId: identity.userId,
        handle: identity.handle,
        accountType: "agent",
        ownerUserId: identity.ownerUserId,
      };
    }
    return {
      status: "wrong_account_type",
      userId: identity.userId,
      handle: identity.handle,
      accountType: identity.accountType,
    };
  } catch (err) {
    if (isUnauthorized(err)) return { status: "unauthorized" };
    return { status: "unreachable", detail: sanitizeDetail(err, cfg.token) };
  } finally {
    await safeClose(handle);
  }
}

/** Map a {@link ConnectivityResult} to a single human-readable status line. */
export function describeConnectivity(result: ConnectivityResult): string {
  switch (result.status) {
    case "connected":
      return `Connected to Quase as @${result.handle} (${result.userId}, agent).`;
    case "wrong_account_type":
      return `Token authenticates as ${result.accountType}, not an agent. Mint an agent token with create_agent on Quase.`;
    case "unauthorized":
      return "Quase agent token is missing or invalid.";
    case "unreachable":
      return `Cannot reach Quase (${result.detail}).`;
  }
}

// ---------------------------------------------------------------------------
// WI-1: persistent tool-wrapper session over the same static-bearer transport.
// ---------------------------------------------------------------------------

/** Agent identity + inbox counters from `whoami` (superset of {@link WhoamiIdentity}). */
export interface QuaseIdentity {
  userId: string;
  handle: string;
  accountType: string;
  ownerUserId?: string;
  unreadInboxCount?: number;
}

/**
 * A normalized inbox notification. Field names are the **live** `check_inbox` shape
 * (`ref_id`/`ref_type` included — richer than the docs); see research §2.2.
 */
export interface QuaseInboxItem {
  itemId: string;
  type: string; // dm_reply | mention | reply | group_broadcast | reaction | …
  refId: string;
  refType: string;
  fromUserId: string;
  fromHandle: string;
  fromDisplayName?: string;
  createdAt: string; // ISO-8601 — the watermark cursor value
  contentSnippet?: string;
  groupId?: string;
}

/** `check_inbox` result: the items plus the server-side watermark + clock. */
export interface QuaseInboxResult {
  items: QuaseInboxItem[];
  lastSeenInboxAt: string | null;
  serverTime: string | null;
  unreadCount?: number;
}

/** A hydrated post (or reply — both share the `post_` prefix). */
export interface QuasePost {
  postId: string;
  content: string;
  parentId: string | null; // top-level post id (null ⇒ this IS the top-level post)
  replyToId: string | null;
  authorUserId: string;
  authorHandle: string;
  visibilityType?: string;
}

/** A DM participant identity (the thread includes the agent itself). */
export interface QuaseParticipant {
  userId: string;
  handle: string;
}

/** A hydrated DM thread: who is in it + its messages (latest last). */
export interface QuaseDmThread {
  conversationId?: string;
  participantProfiles: QuaseParticipant[];
  messages: { fromUserId: string; fromHandle: string; content: string; createdAt?: string }[];
}

/** A conversation summary (for owner detection when a thread is not hydratable). */
export interface QuaseConversation {
  conversationId: string;
  participantProfiles: QuaseParticipant[];
}

/** The `reply_create` result — carries mention-delivery evidence (see research §2.6). */
export interface QuaseReplyResult {
  postId?: string;
  mentions: { handle: string; userId?: string }[];
  mentionsDropped: string[];
}

/** A user resolved via `search_users` (for outbound mention resolution). */
export interface QuaseUser {
  userId: string;
  handle: string;
  displayName?: string;
}

export interface CheckInboxArgs {
  since?: string;
  typeFilter?: string;
  authorHandles?: string[];
  groupId?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface ReplyCreateArgs {
  parentId: string;
  content: string;
  replyToId?: string;
  mentions?: { handle: string; displayName?: string }[];
}

/**
 * The Quase tool surface the WI-1 components depend on. The mapper, poller, and outbound
 * router take this interface (not the concrete session) so they unit-test against a stub —
 * mirroring WI-0's {@link QuaseClientFactory} injection.
 */
/** An inbox notification policy: category → source filters (`"*"` / `"system"` / `"user:<h>"` / `"group:<id>"`). */
export type QuaseInboxPolicy = Record<string, string[]>;

export interface QuaseApi {
  whoami(): Promise<QuaseIdentity>;
  checkInbox(args?: CheckInboxArgs): Promise<QuaseInboxResult>;
  updateInboxSeen(args: { seenAt: string }): Promise<void>;
  /** Read (no arg) or replace the agent's inbox policy; returns the resulting policy. */
  updateInboxPolicy(policy?: QuaseInboxPolicy): Promise<QuaseInboxPolicy>;
  postGet(postId: string): Promise<QuasePost>;
  getDmThread(conversationId: string, opts?: { limit?: number; afterReplyId?: string }): Promise<QuaseDmThread>;
  getConversations(opts?: { limit?: number }): Promise<QuaseConversation[]>;
  sendDm(args: { conversationId: string; content: string }): Promise<{ messageId?: string }>;
  replyCreate(args: ReplyCreateArgs): Promise<QuaseReplyResult>;
  searchUsers(query: string): Promise<QuaseUser[]>;
}

/** A tool-level failure (`isError` on the CallToolResult). Not a transport drop — no reconnect. */
export class QuaseToolError extends Error {
  constructor(
    public readonly tool: string,
    detail: string,
  ) {
    super(`Quase ${tool} returned a tool error: ${detail}`);
    this.name = "QuaseToolError";
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function optString(v: unknown): string | undefined {
  return v != null && v !== "" ? String(v) : undefined;
}

function firstArray(obj: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k] as unknown[];
  }
  return [];
}

function parseInboxItem(raw: unknown): QuaseInboxItem {
  const it = asRecord(raw);
  return {
    itemId: String(it.item_id ?? it.id ?? ""),
    type: String(it.type ?? ""),
    refId: it.ref_id != null ? String(it.ref_id) : "",
    refType: it.ref_type != null ? String(it.ref_type) : "",
    fromUserId: String(it.from_user_id ?? ""),
    fromHandle: String(it.from_handle ?? ""),
    fromDisplayName: optString(it.from_display_name),
    createdAt: String(it.created_at ?? ""),
    contentSnippet: optString(it.content_snippet),
    groupId: optString(it.group_id),
  };
}

function parseParticipants(raw: unknown): QuaseParticipant[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    const rec = asRecord(p);
    return { userId: String(rec.user_id ?? ""), handle: String(rec.handle ?? "") };
  });
}

function parsePost(raw: unknown): QuasePost {
  const p = asRecord(raw);
  return {
    postId: String(p.post_id ?? ""),
    content: String(p.content ?? ""),
    parentId: p.parent_id != null ? String(p.parent_id) : null,
    replyToId: p.reply_to_id != null ? String(p.reply_to_id) : null,
    authorUserId: String(p.author_user_id ?? ""),
    authorHandle: String(p.author_handle ?? ""),
    visibilityType: optString(p.visibility_type),
  };
}

/**
 * A persistent MCP session for the poll loop: one long-lived client+transport, reconnected
 * on a dropped transport (never per-tick). Wraps the Quase tools the WI-1 components call
 * and reuses WI-0's `structuredContent`-else-first-text-block parsing + single-close
 * discipline. Never logs the token.
 */
export class QuaseSession implements QuaseApi {
  private handle: QuaseClientHandle | null = null;

  constructor(
    private readonly cfg: QuaseAccountConfig,
    private readonly version: string,
    private readonly factory: QuaseClientFactory = createQuaseClient,
  ) {}

  /** Connect if not already connected. Idempotent. */
  async ensureConnected(): Promise<void> {
    if (this.handle) return;
    const handle = this.factory(this.cfg, this.version);
    await handle.client.connect(handle.transport as never);
    this.handle = handle;
  }

  /** Tear down the current client (single close — never double-frees the transport). */
  private async reset(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (handle) await safeClose(handle);
  }

  /** Close the session. Safe to call repeatedly. */
  async close(): Promise<void> {
    await this.reset();
  }

  /**
   * Call a tool and return its parsed JSON payload. Reconnects **once** on a transport
   * drop (not on a tool-level error). Tool errors throw {@link QuaseToolError}; any thrown
   * message is sanitized so the token never leaks.
   */
  private async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureConnected();
    try {
      return await this.invoke(name, args);
    } catch (err) {
      if (err instanceof QuaseToolError) throw err; // tool-level — not a transport problem
      // Transport drop / connection error: reconnect once and retry.
      await this.reset();
      try {
        await this.ensureConnected();
        return await this.invoke(name, args);
      } catch (retryErr) {
        if (retryErr instanceof QuaseToolError) throw retryErr;
        throw new Error(sanitizeDetail(retryErr, this.cfg.token));
      }
    }
  }

  private async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.handle) throw new Error("not connected");
    const res = (await this.handle.client.callTool({ name, arguments: args })) as CallToolResultLike;
    const json = extractResultJson(res);
    // Quase signals tool-level failures TWO ways: the MCP `isError` flag, OR an `{ "error": ... }`
    // field in the result payload (with isError left false — e.g. "Cannot reply to a nested
    // reply"). Treat both as failures so a failed send_dm/reply_create surfaces as a rejected
    // dispatch and the poller does NOT advance the watermark past a reply that never posted.
    if (res.isError) {
      const detail = json != null ? (typeof json === "string" ? json : JSON.stringify(json)) : "unknown error";
      throw new QuaseToolError(name, sanitizeDetail(detail, this.cfg.token));
    }
    if (json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string") {
      throw new QuaseToolError(name, sanitizeDetail((json as { error: string }).error, this.cfg.token));
    }
    return json;
  }

  async whoami(): Promise<QuaseIdentity> {
    const raw = asRecord(await this.call("whoami", {}));
    const profile = asRecord(raw.profile);
    const unread = raw.unread_inbox_count ?? profile.unread_inbox_count;
    return {
      userId: String(raw.user_id ?? profile.user_id ?? ""),
      handle: String(raw.handle ?? profile.handle ?? ""),
      accountType: String(profile.account_type ?? raw.account_type ?? ""),
      ownerUserId: optString(profile.owner_user_id ?? raw.owner_user_id),
      unreadInboxCount: typeof unread === "number" ? unread : undefined,
    };
  }

  async checkInbox(args: CheckInboxArgs = {}): Promise<QuaseInboxResult> {
    const toolArgs: Record<string, unknown> = {};
    if (args.since != null) toolArgs.since = args.since;
    if (args.typeFilter != null) toolArgs.type_filter = args.typeFilter;
    if (args.authorHandles != null) toolArgs.author_handles = args.authorHandles;
    if (args.groupId != null) toolArgs.group_id = args.groupId;
    if (args.unreadOnly != null) toolArgs.unread_only = args.unreadOnly;
    if (args.limit != null) toolArgs.limit = args.limit;

    const raw = asRecord(await this.call("check_inbox", toolArgs));
    const items = firstArray(raw, "items", "notifications", "inbox").map(parseInboxItem);
    const lastSeen = raw.last_seen_inbox_at;
    const serverTime = raw.server_time;
    return {
      items,
      lastSeenInboxAt: lastSeen != null ? String(lastSeen) : null,
      serverTime: serverTime != null ? String(serverTime) : null,
      unreadCount: typeof raw.unread_count === "number" ? raw.unread_count : undefined,
    };
  }

  async updateInboxSeen(args: { seenAt: string }): Promise<void> {
    await this.call("update_inbox_seen", { seen_at: args.seenAt });
  }

  async updateInboxPolicy(policy?: QuaseInboxPolicy): Promise<QuaseInboxPolicy> {
    const raw = asRecord(await this.call("update_inbox_policy", policy ? { inbox_policy: policy } : {}));
    const result = asRecord(raw.inbox_policy);
    const out: QuaseInboxPolicy = {};
    for (const [k, v] of Object.entries(result)) out[k] = Array.isArray(v) ? v.map((x) => String(x)) : [];
    return out;
  }

  async postGet(postId: string): Promise<QuasePost> {
    // Live shape: post_get nests the record under `post`.
    const raw = asRecord(await this.call("post_get", { post_id: postId }));
    return parsePost(raw.post ?? raw);
  }

  async getDmThread(conversationId: string, opts: { limit?: number; afterReplyId?: string } = {}): Promise<QuaseDmThread> {
    const toolArgs: Record<string, unknown> = { conversation_id: conversationId };
    if (opts.limit != null) toolArgs.limit = opts.limit;
    if (opts.afterReplyId != null) toolArgs.after_reply_id = opts.afterReplyId;
    const raw = asRecord(await this.call("get_dm_thread", toolArgs));
    // Live shape: the conversation envelope (with participant_profiles) is nested under
    // `post`; messages are under `replies` and carry author_* (not from_*) fields.
    const envelope = asRecord(raw.post);
    const messages = firstArray(raw, "replies", "messages").map((m) => {
      const rec = asRecord(m);
      return {
        fromUserId: String(rec.author_user_id ?? rec.from_user_id ?? ""),
        fromHandle: String(rec.author_handle ?? rec.from_handle ?? ""),
        content: String(rec.content ?? ""),
        createdAt: optString(rec.created_at),
      };
    });
    return {
      conversationId: optString(raw.conversation_id ?? envelope.conversation_id),
      participantProfiles: parseParticipants(envelope.participant_profiles ?? raw.participant_profiles),
      messages,
    };
  }

  async getConversations(opts: { limit?: number } = {}): Promise<QuaseConversation[]> {
    const toolArgs: Record<string, unknown> = {};
    if (opts.limit != null) toolArgs.limit = opts.limit;
    const raw = await this.call("get_conversations", toolArgs);
    // Live shape: the list is under `result`.
    const list = Array.isArray(raw) ? raw : firstArray(asRecord(raw), "result", "conversations", "items");
    return list.map((c) => {
      const rec = asRecord(c);
      return {
        conversationId: String(rec.conversation_id ?? ""),
        participantProfiles: parseParticipants(rec.participant_profiles),
      };
    });
  }

  async sendDm(args: { conversationId: string; content: string }): Promise<{ messageId?: string }> {
    const raw = asRecord(await this.call("send_dm", { conversation_id: args.conversationId, content: args.content }));
    return { messageId: optString(raw.message_id ?? raw.reply_id ?? raw.id) };
  }

  async replyCreate(args: ReplyCreateArgs): Promise<QuaseReplyResult> {
    const toolArgs: Record<string, unknown> = { parent_id: args.parentId, content: args.content };
    if (args.replyToId != null) toolArgs.reply_to_id = args.replyToId;
    if (args.mentions != null) {
      toolArgs.mentions = args.mentions.map((m) => ({ handle: m.handle, display_name: m.displayName }));
    }
    const raw = asRecord(await this.call("reply_create", toolArgs));
    const mentions = (Array.isArray(raw.mentions) ? raw.mentions : []).map((m) => {
      const rec = asRecord(m);
      return { handle: String(rec.handle ?? ""), userId: optString(rec.user_id) };
    });
    const droppedRaw = Array.isArray(raw.mentions_dropped) ? raw.mentions_dropped : [];
    const mentionsDropped = droppedRaw.map((d) => (typeof d === "string" ? d : String(asRecord(d).handle ?? "")));
    return { postId: optString(raw.post_id ?? raw.reply_id ?? raw.id), mentions, mentionsDropped };
  }

  async searchUsers(query: string): Promise<QuaseUser[]> {
    const raw = await this.call("search_users", { query });
    const list = Array.isArray(raw) ? raw : firstArray(asRecord(raw), "users", "results", "items");
    return list.map((u) => {
      const rec = asRecord(u);
      return {
        userId: String(rec.user_id ?? ""),
        handle: String(rec.handle ?? ""),
        displayName: optString(rec.display_name),
      };
    });
  }
}
