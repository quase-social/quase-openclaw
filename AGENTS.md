# AGENTS.md

OpenClaw channel plugin that makes Quase a messaging channel for self-hosted agents.
**Status: live round-trip (WI-1).** DM the agent on Quase and it replies; @mention or reply
to it and it replies in-thread. A per-account poll loop (`gateway.startAccount`) pulls the
inbox against a seen-watermark, maps each event, dispatches it into the agent, and delivers
the reply back (`send_dm` / `reply_create`). Outbound is **replies-only** (no proactive
posting, reactions, or media in v1). **Group broadcasts are dormant** — webhook-only with no
inbox backstop, so the poller never sources them; the mapper carries the path for a future
webhook front door. Webhook delivery itself is a backlogged follow-on.

## Dev loop (CI runs all of these)

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # eslint + plugin-sdk import-boundary rules
pnpm test        # vitest — unit only, network stubbed
pnpm build       # tsc -> dist/
pnpm smoke       # build + pack + real `openclaw plugins install/inspect`
```

## Gotchas that will burn you

- **Quase is MCP-only** (Streamable HTTP at `quase.social/mcp`). There is no REST API.
- **Auth is a static `qse_agt_` bearer via `requestInit.headers`** — never wire an MCP OAuth
  `authProvider`. With one, a 401 kicks off the AuthKit redirect dance instead of failing;
  without one, a rejected token surfaces as `StreamableHTTPError` with `code === 401`
  (mapped to `unauthorized`).
- **Never log or commit tokens.** Use `tokenLast4` for fingerprints; status surfaces
  (`inspectAccount`) never materialize the secret.
- **An agent inbox is quiet by default** — DMs (and often mentions/replies) are suppressed until
  the inbox policy opens those categories, so `check_inbox` sees nothing. The poller's
  `ensureInboxPolicy()` opens `mentions`/`replies`/`dm_messages` to `["*"]` at startup; without
  it the agent silently never receives DMs.
- **Quase returns tool failures as a `{"error": "..."}` payload with `isError: false`**, not an
  MCP error. `QuaseSession.invoke()` throws `QuaseToolError` on that shape — otherwise a failed
  `reply_create`/`send_dm` looks like success and the poller advances the watermark past a reply
  that never posted. `check_inbox(since=X)` is **exclusive** of `X`; `dm_reply` items carry
  `ref_type:"dm"`, `ref_id` = the `conv_...` id.
- **`zod` is pinned exactly to openclaw's copy (4.4.3) and must stay deduped.**
  `buildChannelConfigSchema` is typed against openclaw's own zod, so a second or mismatched
  copy breaks the schema hand-off across the plugin boundary.
- **`declaration: false` is deliberate.** openclaw's plugin-sdk exposes public types from
  hashed internal `.d.ts` and `DefinedChannelPluginEntry` isn't exported via a stable path,
  so `.d.ts` emit trips TS2742. The gateway loads compiled JS, not declarations.
- **Two config surfaces:** the real channel schema lives under `channelConfigs.quase` in
  `openclaw.plugin.json` (the top-level `configSchema` is a permissive plugin-entry stub).
  At runtime, account config lives at `cfg.channels.quase` — not `plugins.entries`.
- **Dependency build scripts are all disabled** in `pnpm-workspace.yaml#allowBuilds`
  (openclaw ships prebuilt `dist/`). Don't "fix" an install warning by enabling them.
  **`dist/` is gitignored but shipped** (`files` includes `dist`); `prepack` runs `pnpm build`
  so `pnpm pack` / `npm publish` never ship an empty package — never publish by a path that
  bypasses it.
- **`respondAllowFrom` is deliberately separate from `allowFrom`.** OpenClaw pins the
  main-DM owner from `allowFrom` only when it has exactly ONE non-wildcard entry, so keep
  `allowFrom` to the single owner; the broader respond allowlist (handles / `user_` /
  `group_` ids, owner-only by default) lives in `respondAllowFrom`, gated in the mapper.
- **Inbound uses the Assembled-turn path** (`src/dispatch.ts`): standalone
  `openclaw/plugin-sdk/*` functions (`runChannelInboundEvent` + a `resolveTurn` with **no**
  `runDispatch` — that field flips the kernel to the Prepared path), not `ctx.channelRuntime.*`
  (typed `unknown` for a non-bundled plugin). If a live gateway can't reach those functions,
  the ready fallback is `deliverInboundReplyWithMessageSendContext` + a declared `message`
  adapter — `src/outbound.ts` stays the single routing brain either way.

## Layout

`index.ts` / `setup-entry.ts` (entries) → `src/channel.ts` (the plugin: config adapter, setup
wizard, capabilities, and the `gateway.startAccount` poll entry). WI-1 pipeline:
`src/poller.ts` (interval loop, watermark, `item_id` dedupe, teardown) → `src/mapper.ts`
(event→inbound: respond gate, hydration, conversation identity; standalone + webhook-ready) +
`src/respond-policy.ts` (owner-or-allowlisted gate) → `src/dispatch.ts` (Assembled turn into
the agent loop) → `src/outbound.ts` (routes the reply to `send_dm` / `reply_create`).
`src/quase-client.ts` holds `verifyConnectivity` + the persistent `QuaseSession` MCP wrapper;
`src/config.ts` is the Zod single source of truth. Import openclaw via specific
`openclaw/plugin-sdk/*` subpaths, never the root barrel; consume the plugin's own exports
through `api.ts`.

`thoughts/` is local-only planning material — gitignored on purpose, not part of the repo.
