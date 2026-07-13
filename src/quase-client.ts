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

/** Factory used by {@link verifyConnectivity}; overridable in tests. */
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

/** Pull the JSON identity out of a CallToolResult: prefer structuredContent, else the first JSON text block. */
function extractWhoamiJson(res: CallToolResultLike): unknown {
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
  const raw = extractWhoamiJson(res);
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
