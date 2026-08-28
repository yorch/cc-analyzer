---
name: cut-release
description: >
  Guide a cc-analyzer release through Changesets: a normal PR carries the
  release metadata, GitHub creates a reviewed version PR, and merging that PR
  publishes the GitHub binary release. Use when the user says "cut a release",
  "ship a release", or asks to release the latest changes.
---

# Cut a cc-analyzer release

cc-analyzer releases are **Changeset-driven and PR-gated**. Never bump
`package.json` manually and never create or push a `v*` tag: GitHub Actions owns
both after the version PR is approved.

## Lifecycle

```text
feature/fix PR + Changeset → CI → merge to main
  → Release workflow opens/updates "chore: version packages"
  → human reviews version + CHANGELOG → merge version PR
  → Release workflow re-verifies, builds, attests, tags, and publishes
```

The version PR is the one human approval gate for the irreversible release. The
release workflow only publishes when the version in the merged version PR has no
existing GitHub Release; ordinary merges are no-ops after they create/update the
version PR.

Repository administration must protect `main` with required pull requests and
reviewers. As a second guard, the workflow only publishes a commit associated with
a merged `changeset-release/*` version PR; direct version pushes are no-ops.

## 1. Prepare the normal PR

Work from a clean branch based on current `main`. Add a Changeset describing the
user-visible change:

```bash
bun run changeset
# Select cc-analyzer, choose patch/minor/major, and write updater-facing notes.
git add .changeset/*.md
```

Every changed root package needs a non-empty Changeset. CI checks this with:

```bash
bun run changeset status --since=origin/main
```

`--empty` is appropriate only when the package itself has not changed. The root
package owns this repository, so documentation/workflow-only PRs generally need
a patch Changeset too.

## 2. Validate and merge the normal PR

Run the project gates locally when practical:

```bash
bun run verify
```

Wait for both CI matrix legs. Pause for explicit user confirmation before merging
the PR. Once merged, do not manually bump or tag anything.

## 3. Review the generated version PR

The Release workflow opens or updates `chore: version packages`. It runs
`bun run version-packages`, which applies the accumulated Changesets, bumps
`package.json`, updates `CHANGELOG.md`, refreshes `bun.lock`, and deletes the
consumed Changeset files.

Review that PR as the final cheap checkpoint: the semantic version, changelog,
and lockfile must match the intended release. GitHub-token-created PRs may not
trigger normal PR workflows; that is expected because the release workflow
re-runs the complete quality gate before publishing.

Pause for explicit user confirmation before merging the version PR.

## 4. Watch the automated release

Merging the version PR triggers the same Release workflow. It re-runs lint, both
typechecks, tests, and the host build; cross-compiles five binaries; validates
`SHA256SUMS`; signs provenance; then creates `vX.Y.Z` and one GitHub Release.

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status --interval 20
gh release view vX.Y.Z --json assets --jq '[.assets[].name]'
```

Expect five platform binaries plus `SHA256SUMS`. A rerun validates the existing
release tag and assets instead of replacing public artifacts.

## Gotchas

- The Release workflow, not a local tag push, creates `vX.Y.Z` on the exact
  publishing commit.
- The action is pinned to a commit and configured with `publish-script` only as
  a no-op; cc-analyzer never publishes to npm.
- The first version PR after this automation lands includes the release-process
  patch Changeset. Merging it is expected to publish the next patch release.
