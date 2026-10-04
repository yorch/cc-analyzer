---
title: "Archive Claude Code sessions across computers"
description: "Set up a private Git-backed archive for Claude Code transcripts, share it between computers, and merge projects with aliases."
---

# Archive sessions across computers

cc-analyzer can copy raw Claude Code session trees—including subagent transcripts—into a Git repository. Each computer contributes to the shared archive, and each computer builds its own local SQLite index from the live sessions and the archive. The index database itself is not shared.

> **Privacy:** Archives contain raw prompts and tool output. They are not encrypted, and Git history keeps previous versions after files change or are deleted. Use a private remote you trust. cc-analyzer commits locally but never pushes automatically.

## 1. Create the archive on the first computer

Create an empty private Git repository on the Git hosting service you use. Then choose a dedicated local path outside all Claude data directories:

```sh
cc-analyzer archive set ~/cc-archive
cc-analyzer archive run

git -C ~/cc-archive remote add origin <private-repository-url>
git -C ~/cc-archive push -u origin HEAD
```

`archive run` creates the directory and initializes a Git repository if needed, copies the session trees, and commits them. Starting with an empty remote avoids an unrelated initial commit to reconcile.

## 2. Connect another computer

Clone the repository and tell cc-analyzer to use that clone:

```sh
git clone <private-repository-url> ~/cc-archive
cc-analyzer archive set ~/cc-archive
cc-analyzer index
```

The index reads archived sessions by default. While a computer's own live Claude data directory is readable, its archived copy is hidden from that computer's index to prevent duplicate sessions. Archives from other computers are included.

## 3. Give the same project one name on each computer

If a project has different working-directory paths on different computers, assign the same alias to each path. The easiest way is to run the command from the project directory whose path Claude Code records in its sessions:

```sh
cd /Users/alice/work/app
cc-analyzer archive alias current "Acme App"
```

On another computer, first get the latest alias file, then run the same command from that computer's project directory:

```sh
git -C ~/cc-archive pull --ff-only
cd D:/work/app
cc-analyzer archive alias current "Acme App"
```

`archive alias current` stores the current directory as the path and commits the alias locally. Alternatively, set a path explicitly from any directory:

```sh
cc-analyzer archive alias set "/Users/alice/work/app" "Acme App"
```

Use `cc-analyzer archive alias list` to review mappings. Aliases are shared in `project-aliases.json`; after adding or changing one, push the archive and pull it on the other computers. Reindex after pulling so the project rollups use the updated mapping:

```sh
git -C ~/cc-archive push
# On each other computer:
git -C ~/cc-archive pull --ff-only
cc-analyzer index
```

Only use the same alias for paths you deliberately want combined. Alias changes force re-analysis of indexed sessions.

## 4. Keep sessions in sync

Before archiving, pull first. `archive run` refuses to proceed when the repository has uncommitted changes, so finish or resolve local Git work before continuing:

```sh
git -C ~/cc-archive pull --ff-only
cc-analyzer archive run
git -C ~/cc-archive push
cc-analyzer index
```

Repeat on each computer as needed. To have ordinary index refreshes copy and commit changed sessions automatically, opt in once on each computer:

```sh
cc-analyzer archive index on
cc-analyzer index
git -C ~/cc-archive push
```

The opt-in still only commits locally; pushes remain manual. Turn it off with `cc-analyzer archive index off`.

## Related

- [Privacy and security](/guide/privacy)
- [CLI reference: archive](/docs/3-cli)
