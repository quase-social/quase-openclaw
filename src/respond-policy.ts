/**
 * The respond gate: who the agent answers. Silence-by-default — out of the box the agent
 * engages only with its owner; other handles and groups must be explicitly allowlisted in
 * plugin config (`respondAllowFrom`). An open-by-default agent on a multi-human platform is a
 * token-spend DoS surface (phase doc §1.2).
 *
 * This is kept SEPARATE from OpenClaw's `allowFrom` on purpose: OpenClaw pins the main-DM
 * owner from `allowFrom` only when it has exactly one non-wildcard entry, so the broader
 * respond allowlist lives here and is gated plugin-side (plan decision #4).
 */

/** The identity facts a respond decision is made on. */
export interface RespondSubject {
  fromUserId: string;
  fromHandle: string;
  groupId?: string;
}

/** Owner identity (from `whoami().owner_user_id`) + the plugin-side allowlist. */
export interface RespondPolicy {
  ownerUserId?: string;
  respondAllowFrom: string[];
}

/** Normalize a handle for comparison: drop a leading `@`, lowercase. */
function normHandle(handle: string): string {
  return handle.replace(/^@+/, "").toLowerCase();
}

/**
 * True iff the agent should respond to this sender. Owner always passes. Otherwise the
 * sender must match a `respondAllowFrom` entry, prefix-discriminated:
 * - `group_...` → matches the event's `groupId`
 * - `user_...`  → matches `fromUserId`
 * - anything else → a bare handle, matched case-insensitively (optional leading `@`)
 *
 * An empty allowlist ⇒ owner-only.
 */
export function shouldRespond(subject: RespondSubject, policy: RespondPolicy): boolean {
  if (policy.ownerUserId && subject.fromUserId === policy.ownerUserId) return true;

  for (const raw of policy.respondAllowFrom) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("group_")) {
      if (subject.groupId && subject.groupId === entry) return true;
    } else if (entry.startsWith("user_")) {
      if (subject.fromUserId === entry) return true;
    } else if (subject.fromHandle && normHandle(subject.fromHandle) === normHandle(entry)) {
      return true;
    }
  }
  return false;
}
