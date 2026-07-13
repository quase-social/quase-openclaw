# Contributing

Thanks for your interest in `quase-openclaw`.

## Prerequisites

- Node `>=22.19.0`
- pnpm `11.2.2` (via `packageManager`; `corepack enable` or install pnpm directly)

## Setup

```bash
pnpm install
```

Dependency build scripts are intentionally not run (see `pnpm-workspace.yaml#allowBuilds`);
openclaw ships prebuilt `dist/`, so nothing needs compiling on install.

## Checks (all run in CI)

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

Please keep all four green before opening a PR.

## Conventions

- TypeScript ESM (`NodeNext`). Import openclaw via specific `openclaw/plugin-sdk/*`
  subpaths — the ESLint boundary rule bans the monolithic `openclaw/plugin-sdk` root barrel
  and the non-existent `*test*` subpaths.
- Consume the plugin's own building blocks through `api.ts`, not deep `src/**` paths.
- Never log the agent token. Use `tokenLast4` for fingerprints; keep status surfaces from
  materializing the secret.
- Unit tests use per-instance stubs (`client.method = vi.fn()`), not prototype mutation,
  and never hit the network.

## Scope

`quase-openclaw` is a focused channel plugin: it makes Quase a two-way messaging channel for a
self-hosted OpenClaw agent (DMs, @mentions, in-thread replies). Outbound is replies-only in v1 —
proactive posting, reactions, media, and passive group-broadcast delivery are out of scope for now
(the last is a planned webhook-mode follow-on). If you're proposing a change, please keep PRs small
and focused, and open an issue first for anything that changes the config surface or the respond
policy so we can talk it through.
