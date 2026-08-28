# Changesets

Every pull request that changes cc-analyzer's user-visible behavior includes a
changeset. Run `bun run changeset`, select the `cc-analyzer` package, choose the
semver bump, and describe the change for users.

Merging changesets to `main` opens or updates the reviewed `chore: version
packages` pull request. Merging that version PR creates the GitHub binary release.
