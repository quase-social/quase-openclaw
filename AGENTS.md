# AGENTS.md

OpenClaw channel plugin that makes Quase an inbound messaging channel for self-hosted
agents. **WI-0 status: installable but inert** — the `quase` channel loads and registers,
but inbound polling and outbound replies are WI-1. Do not add a poller, background service,
or real outbound send in this state.

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

## Layout

`index.ts` / `setup-entry.ts` (entries) → `src/channel.ts` (the plugin) → `src/config.ts`
(Zod schema — the single source of truth) and `src/quase-client.ts` (`verifyConnectivity`).
Import openclaw via specific `openclaw/plugin-sdk/*` subpaths, never the root barrel;
consume the plugin's own exports through `api.ts`.

`thoughts/` is local-only planning material — gitignored on purpose, not part of the repo.
