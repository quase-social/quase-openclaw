import { describe, it, expect } from "vitest";
import {
  quaseAccountConfigSchema,
  QUASE_DEFAULT_BASE_URL,
  DEFAULT_POLL_INTERVAL,
  tokenLast4,
} from "./config.js";

describe("quaseAccountConfigSchema", () => {
  it("fills defaults from a minimal (token-only) config", () => {
    const parsed = quaseAccountConfigSchema.parse({ token: "qse_agt_x" });
    expect(parsed.token).toBe("qse_agt_x");
    expect(parsed.pollInterval).toBe(DEFAULT_POLL_INTERVAL);
    expect(parsed.baseUrl).toBe(QUASE_DEFAULT_BASE_URL);
    expect(parsed.allowFrom).toEqual([]);
  });

  it("rejects a pollInterval below the minimum", () => {
    expect(() => quaseAccountConfigSchema.parse({ token: "x", pollInterval: 2 })).toThrow();
  });

  it("rejects a missing token", () => {
    expect(() => quaseAccountConfigSchema.parse({})).toThrow();
  });

  it("rejects an empty token", () => {
    expect(() => quaseAccountConfigSchema.parse({ token: "" })).toThrow();
  });
});

describe("tokenLast4", () => {
  it("returns only the last 4 characters", () => {
    expect(tokenLast4("qse_agt_abcdef")).toBe("cdef");
  });

  it("returns empty for empty / null / undefined", () => {
    expect(tokenLast4("")).toBe("");
    expect(tokenLast4(null)).toBe("");
    expect(tokenLast4(undefined)).toBe("");
  });
});
