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

This repo is being built in work items. WI-0 is the inert foundation (config surface +
authenticated client). Inbound polling and outbound messaging are WI-1; keep changes scoped
to the work item at hand.
