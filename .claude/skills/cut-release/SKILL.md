---
name: cut-release
description: >
  Cut a new versioned release of cc-analyzer (bump → prep PR → tag → GitHub
  release → verify). Use when the user says "cut a release", "cut vX.Y.Z",
  "ship a release", "do a release", "tag a new version", or "release the
  latest changes". Guides the full flow with human confirmation at the two
  outward steps (merging the prep PR and pushing the tag). Encodes the
  repo-specific invariants: the version must land on main BEFORE the tag,
  CI is a macOS+Ubuntu matrix, and releases publish 5 binaries + SHA256SUMS
  with a build-provenance attestation.
---

# Cut a cc-analyzer release

A guided, gated procedure. **Drive the mechanical steps; PAUSE for the user's
confirmation before the two outward/irreversible actions — merging the prep PR
and pushing the tag.** Never auto-merge or auto-push a tag without a clear "yes".

Work from a clean tree on an up-to-date `main` (or a worktree off `origin/main`).

## The one invariant that matters

The compiled binary embeds `package.json`'s version at build time (`version.ts`,
bundled by `bun --compile`). **So the version bump MUST land on `main` before the
tag.** Tagging a commit whose `package.json` still says the old version ships
binaries that report the wrong version. This is why we bump via a PR and tag the
*merge commit* — never tag first.

## Steps

### 1. Assess & pick the version

```bash
git fetch origin --prune
git checkout main && git pull --ff-only origin main
grep '"version"' package.json                 # current
git tag -l | sort -V | tail -1                # latest tag
git log "$(git tag -l | sort -V | tail -1)"..HEAD --oneline   # commits since
```

Pick the bump from the commits (semver):
- any `feat` → **minor** (`0.6.0 → 0.7.0`)
- only `fix`/`perf`/`chore`/`docs` → **patch** (`0.6.0 → 0.6.1`)
- a `schema vN` bump is NOT breaking (the index is a disposable, rebuildable
  cache) → still minor/patch, not major.

Confirm the version with the user before proceeding.

### 2. Prep PR (bump `package.json`)

Do this in a worktree so `main` stays clean:

```bash
git worktree add -b chore/release-vX.Y.Z ../cc-analyzer-relX origin/main
cd ../cc-analyzer-relX
# bump the version line (sed keeps it to one line)
sed -i '' 's/"version": "OLD"/"version": "X.Y.Z"/' package.json
git add package.json
git commit -m "chore(release): prepare vX.Y.Z"
git push -u origin chore/release-vX.Y.Z
gh pr create --title "chore(release): prepare vX.Y.Z" --body "..."
```

The prep PR touches only `package.json` (that is the established convention — there
is no CHANGELOG file).

### 3. Wait for CI, then ⏸ CONFIRM MERGE

CI is a **matrix (macOS + Ubuntu)** — wait for BOTH legs, not one:

```bash
runid=$(gh run list --branch chore/release-vX.Y.Z --workflow=ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$runid" --exit-status --interval 15
```

**PAUSE.** Ask the user to confirm before merging (outward step). On "yes":

```bash
gh pr merge <n> --squash
git fetch origin --prune && git checkout main && git merge --ff-only origin/main
grep '"version"' package.json     # verify X.Y.Z is now on main
```

### 4. Tag the merge commit, then ⏸ CONFIRM PUSH

The tag on the merge commit is what triggers `release.yml`.

```bash
git tag -a vX.Y.Z -m "vX.Y.Z

<one line per notable change since the last tag>"
git rev-parse vX.Y.Z^{commit}     # should be the merge commit (reports X.Y.Z)
```

**PAUSE.** Ask the user to confirm before pushing the tag (this publishes a
release). On "yes":

```bash
git push origin vX.Y.Z
```

### 5. Watch the release workflow

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status --interval 20
```

`release.yml` cross-compiles 5 binaries, generates `SHA256SUMS`, and signs a
build-provenance attestation.

### 6. Verify the release (lightweight — no heavy download)

```bash
gh release view vX.Y.Z --json assets --jq '[.assets[].name]'
# expect: 5 binaries + SHA256SUMS
curl -fsSL https://github.com/yorch/cc-analyzer/releases/download/vX.Y.Z/SHA256SUMS
# entries must be BASENAMES (cc-analyzer-linux-x64), not dist/… paths
git show vX.Y.Z:package.json | grep '"version"'   # embedded version == tag
```

Do NOT try to download a 62 MB binary just to check `--version` — the sandbox
stalls on large transfers. The tagged `package.json` + the SHA256SUMS manifest
are sufficient proof. (The enforced checksum path was already verified live on a
prior release.)

### 7. Clean up

```bash
cd ../cc-analyzer          # back to the main checkout
git worktree remove ../cc-analyzer-relX
git branch -D chore/release-vX.Y.Z
```

## Gotchas (learned the hard way)

- **Version-before-tag.** Covered above — the whole reason for the prep PR.
- **Matrix CI.** `ci.yml` runs on macOS AND Ubuntu; `gh run watch` the whole run,
  and don't merge on a single green leg.
- **SHA256SUMS basenames.** The workflow generates the manifest with
  `cd dist && sha256sum cc-analyzer-*` so entries are bare asset names — which is
  what the installers and `cc-analyzer update` look up. If a change ever makes
  entries `dist/…`, verification silently skips (basename lookup misses).
- **`/latest/download/` redirect.** Assets resolve via
  `github.com/…/releases/latest/download/<asset>` (no API token, no rate limit) —
  used by both the installer and `update`.
- **Deploy on site/wiki touch.** If the release commit also changed `site/**` or
  `wiki/**`, merging fires `deploy-site.yml` too. If verifying the live docs
  after, "HTTP 200 ≠ works" — fetch a real asset from the page, not just the
  HTML shell.

## Cross-reference

CLAUDE.md's `## Release` section documents the same invariant and the workflow
internals. This skill is the executable, gated procedure.
