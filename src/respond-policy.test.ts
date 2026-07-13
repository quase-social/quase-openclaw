import { describe, it, expect } from "vitest";
import { shouldRespond } from "./respond-policy.js";

const OWNER = "user_owner";

describe("shouldRespond", () => {
  it("owner always responds, even with an empty allowlist", () => {
    expect(
      shouldRespond({ fromUserId: OWNER, fromHandle: "solo" }, { ownerUserId: OWNER, respondAllowFrom: [] }),
    ).toBe(true);
  });

  it("empty allowlist ⇒ owner-only (a non-owner is silenced)", () => {
    expect(
      shouldRespond({ fromUserId: "user_x", fromHandle: "stranger" }, { ownerUserId: OWNER, respondAllowFrom: [] }),
    ).toBe(false);
  });

  it("allowlists a bare handle (case-insensitive, optional @)", () => {
    const policy = { ownerUserId: OWNER, respondAllowFrom: ["@Bob"] };
    expect(shouldRespond({ fromUserId: "user_bob", fromHandle: "bob" }, policy)).toBe(true);
    expect(shouldRespond({ fromUserId: "user_bob", fromHandle: "BOB" }, policy)).toBe(true);
  });

  it("allowlists a user_ id", () => {
    const policy = { ownerUserId: OWNER, respondAllowFrom: ["user_bob"] };
    expect(shouldRespond({ fromUserId: "user_bob", fromHandle: "renamed" }, policy)).toBe(true);
    expect(shouldRespond({ fromUserId: "user_eve", fromHandle: "bob" }, policy)).toBe(false);
  });

  it("allowlists a group_ id against the event's groupId", () => {
    const policy = { ownerUserId: OWNER, respondAllowFrom: ["group_fleet"] };
    expect(shouldRespond({ fromUserId: "user_x", fromHandle: "x", groupId: "group_fleet" }, policy)).toBe(true);
    expect(shouldRespond({ fromUserId: "user_x", fromHandle: "x", groupId: "group_other" }, policy)).toBe(false);
    // a group_ entry does NOT match a user handle/id
    expect(shouldRespond({ fromUserId: "group_fleet", fromHandle: "x" }, policy)).toBe(false);
  });

  it("a handle entry does not match a different sender", () => {
    const policy = { ownerUserId: OWNER, respondAllowFrom: ["bob"] };
    expect(shouldRespond({ fromUserId: "user_eve", fromHandle: "eve" }, policy)).toBe(false);
  });

  it("owner-only when ownerUserId is undefined and allowlist is empty", () => {
    expect(shouldRespond({ fromUserId: "user_x", fromHandle: "x" }, { respondAllowFrom: [] })).toBe(false);
  });
});
