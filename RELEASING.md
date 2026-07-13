# Releasing

Publishing is **owner-gated** (npm + ClawHub accounts, GitHub credentials). This runbook takes the
package from a merged WI-2 to published + listed. Everything below is deliberately push-button.

## One-time owner prerequisites

- [ ] **npm org** `@quase-social` exists and the publishing owner is a member with publish rights.
- [ ] **npm Trusted Publishing configured** for `@quase-social/openclaw-quase` (recommended,
      tokenless): on npmjs.com → the package → *Settings → Trusted Publisher → GitHub Actions*, set
      repo `quase-social/quase-openclaw` and workflow `release.yml`. Requires the package to exist
      first — for the very first publish, either do one manual publish (below) then configure trusted
      publishing, or use the token fallback.
- [ ] **Token fallback** (if not using trusted publishing): create a *granular automation* access
      token on npm, add it as the repo secret `NPM_TOKEN`, and switch `release.yml` to token auth
      (see the commented block in that file).
- [ ] **GitHub account** old enough to pass ClawHub's upload gate (the owner's account qualifies).
- [ ] **Confirm the README `## Support` posture** reflects the real maintenance/issue-response and
      security-contact decision before the first release.

## 1. Decide the version

`package.json` ships `0.1.0` — an honest pre-1.0 first release. Bump to `1.0.0` only to signal API
stability. Set it and commit:

```bash
npm version <x.y.z> --no-git-tag-version
git add package.json && git commit -m "Release v<x.y.z>"
```

## 2. Pre-flight (local, from a clean checkout)

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm smoke
pnpm pack --pack-destination /tmp        # prepack builds dist/ automatically
tar -tf /tmp/quase-social-openclaw-quase-*.tgz
```

Confirm the tarball contains `package/dist/index.js`, `package/dist/api.js`,
`package/openclaw.plugin.json`, `package/README.md`, `package/LICENSE`. **If `dist/` is missing, the
`prepack` gate did not run — do not publish.**

## 3. Publish to npm (push-button)

**Preferred — CI trusted publishing:**

```bash
git tag v<x.y.z>
git push origin v<x.y.z>
```

The `release.yml` workflow builds, runs checks, and publishes with provenance. Verify:

```bash
npm view @quase-social/openclaw-quase version
npm audit signatures
```

**Manual fallback** (owner logged in with 2FA, from a clean checkout):

```bash
npm publish --access public              # prepack builds dist/
```

## 4. Publish to ClawHub (the OpenClaw registry / discovery surface)

```bash
npm i -g clawhub
clawhub login
clawhub package publish . --dry-run      # preview
clawhub package publish .                # publish
```

`<source>` can be `.` (this folder), `quase-social/quase-openclaw`, or a GitHub URL. If your OpenClaw
version has it, sanity-check the manifest first with `openclaw plugins validate .`.

## 5. Submit to the awesome-openclaw lists (open one PR to each)

Fork the target repo, add the entry under the messaging/channels/integrations category (adjust to the
list's current structure), and open a PR. Ready-to-paste:

### composio-community/awesome-openclaw-plugins (table row)

```
| [Quase](https://github.com/quase-social/quase-openclaw) | Quase (quase-social) | ![GitHub stars](https://img.shields.io/github/stars/quase-social/quase-openclaw?style=social) | Message your self-hosted OpenClaw agent from Quase — a two-way channel plugin (DMs, @mentions, in-thread replies). |
```

### vincentkoc/awesome-openclaw (list line, under "Plugins and Integrations")

```
- [Quase](https://github.com/quase-social/quase-openclaw) - Message your self-hosted OpenClaw agent from Quase; two-way channel plugin (DMs, @mentions, replies). ![GitHub stars](https://img.shields.io/github/stars/quase-social/quase-openclaw?style=social)
```

Lower-priority lists (same PR-a-row model): `alvinreal/awesome-openclaw`,
`rohitg00/awesome-openclaw`, `ThisIsJeron/awesome-openclaw-plugins`, `jensrot/awesome-openclaw`.

## Post-release checklist

- [ ] `npm view @quase-social/openclaw-quase` shows the new version.
- [ ] `openclaw plugins install npm:@quase-social/openclaw-quase` installs cleanly in a scratch env.
- [ ] ClawHub page renders the README + compat metadata.
- [ ] Both awesome-list PRs opened.
