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
cc-analyzer archive machine keep
cc-analyzer index
```

`archive machine keep` records a fresh identity for this computer. It is required
before this computer can archive, because the archive already holds another
computer's work and cc-analyzer never guesses which machine it is running on. If
this computer has archived into this repository *before* and only lost its local
state, adopt its existing id instead — see
[Machine identity](#_5-machine-identity-and-recovery).

If another computer in the archive reports the *same hostname* as this one,
`keep` refuses, because it cannot tell a new computer from one that lost its
identity. Confirm with `cc-analyzer archive machine keep --force` when it really
is a different computer.

The index reads archived sessions by default. While a computer's own live Claude data directory is readable, its archived copy is hidden from that computer's index to prevent duplicate sessions. Archives from other computers are included.

`cc-analyzer archive show` lists the computers recorded in the archive. Each computer should appear once; see [Machine identity](#_5-machine-identity-and-recovery) if one appears twice.

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

Only use the same alias for paths you deliberately want combined. Changing an alias re-analyzes only the sessions whose project label changed, not the whole portfolio.

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

### When a pull is not a fast-forward

Each computer writes only under its own `machines/<id>/` directory. Once two computers have each committed, the archive histories have diverged, and `git pull --ff-only` fails. Reconcile with an ordinary merge:

```sh
git -C ~/cc-archive pull --no-rebase
cc-analyzer archive run
git -C ~/cc-archive push
cc-analyzer index
```

`--no-rebase` makes the merge explicit, so Git does not stop with a "need to specify how to reconcile divergent branches" error on a machine without a `pull.rebase` setting. Session files should merge without conflicts. The exception is `project-aliases.json`, which both computers can edit.

### When `project-aliases.json` conflicts

If two computers changed aliases before syncing, the merge stops with a conflict in `project-aliases.json`. Keep the entries from both computers:

```sh
git -C ~/cc-archive status
# edit ~/cc-archive/project-aliases.json: remove the <<<<<<<, =======, and >>>>>>> lines
# and keep the entries from both sides
cc-analyzer archive alias list
git -C ~/cc-archive add project-aliases.json
git -C ~/cc-archive commit --no-edit
git -C ~/cc-archive push
cc-analyzer index
```

The merged file must stay in the format cc-analyzer reads: `version` must be `1`, `aliases` must be an object, every key must be an absolute path (starting with `/` or a drive letter such as `D:/`; backslashes in a Windows path are converted to forward slashes, but write them as forward slashes in the file), and every value must be a non-empty name. A file that breaks these rules is rejected, and `cc-analyzer archive alias list` reads the file, so running it before the commit confirms the result. For example:

```json
{
  "version": 1,
  "aliases": {
    "/Users/alice/work/app": "Acme App",
    "D:/work/app": "Acme App"
  }
}
```

A path that both computers mapped to different names cannot hold two values. Keep one name and remove the other. A conflict in any other file is unexpected, so check `git status` before resolving it. `archive alias set`, `current`, and `remove` refuse to run while the repository has unfinished merge work, so finish the commit first. `archive alias list` only reads the file: it works as soon as the conflict markers are gone, and until then it fails with a JSON parse error.

## 5. Machine identity and recovery

Each computer has a machine id, a UUID generated once and stored in cc-analyzer's state directory. `archive run` archives under that id, in `machines/<id>/roots/...`, and records the id, a label, and the hostnames it has archived from in `machines/<id>/machine.json`. The label defaults to the hostname. To name the computer:

```sh
cc-analyzer archive machine set "Work laptop"
cc-analyzer archive machine
```

`archive machine` with no argument prints this computer's id, label, hostname, and where the id comes from (`local` is saved; `unidentified` is not). A new label is written into the archive on the next `archive run`.

The id keeps one computer from appearing as two. If the state directory is lost (cleared, a fresh install, or a home directory restored from backup), the computer has no id. Earlier versions minted a new one and archived every session again under it, so the old directory looked like a different computer. In one 167-session portfolio, session and turn counts doubled while cost and API-call counts stayed correct, because usage is de-duplicated across files. The result was inflated activity numbers and a cost-per-session average that was too low, with nothing on screen to explain it.

cc-analyzer never guesses which archived computer is this one. Without a local id it mints a throwaway id in memory and does not save it, so the problem is reported again on every run until you resolve it. Two computers can share a hostname and a data-directory path; a wrong guess would hide the other computer's sessions from the index and write this computer's transcripts into its history.

When the archive already holds other machines, `cc-analyzer index` (including a plain `index` that is not archiving, since indexing reads the archive either way), `cc-analyzer archive machine`, and every `archive run` attempt report it on every run, listing each machine with its full id. A machine whose recorded hostnames include this computer's is marked as a suggestion; it is a hint, not a decision. `index`, `index --check`, the TUI, and `serve` warn on stderr and carry on, and the other read-only commands (`projects`, `sessions`) carry on silently, so until you resolve it this computer's own sessions can be counted twice. `archive run` refuses instead, because it writes raw transcripts into permanent Git history. Resolve it one of two ways:

```sh
# This computer is one of the listed machines (copy the full id)
cc-analyzer archive machine adopt <id>

# This is a genuinely new computer, none of the listed machines
cc-analyzer archive machine keep
```

`adopt` refuses an id whose recorded hostnames do not include this computer's, since that is the signature of claiming another live computer's identity. If this computer was renamed, add `--force`. It also refuses when adopting would hide archived sessions that have no counterpart on this computer (two computers that share a hostname and a data-directory path look identical by hostname, but the other one's sessions are not on this disk); it prints the count on every adopt, and genuine recovery, where the archive mirrors your live files, counts zero. `archive run` never adds this computer's hostname to a `machine.json` that names only other hosts, so a forced adoption does not become a recorded fact. An unidentified machine (no `machine.json`, see below) records no hostnames and is not blocked. A first-ever `archive run` against a repository with no commits needs neither command: it creates and saves the id itself. Any archive with history requires `adopt` or `keep`.

`keep` leaves every listed directory in place. If one of them is this computer, its sessions are counted twice from now on with no further warning, so `keep` requires `--force` when a listed machine records this computer's hostname, and restates what it passed over.

After `adopt` (or `keep` with machines present), run `cc-analyzer index --rebuild`; both set a flag that `index` and `index --check` report until a rebuild clears it. While the identity was unresolved, the archived copy and the live files were both indexed, and the row that was later pruned held the claims on the shared API calls. Those claims do not transfer to the surviving row, so its per-session and per-project cost can read too low until a rebuild re-derives it. Portfolio totals stay correct either way.

A stray `machines/<id>` directory can still appear, for example from a merge, a hand edit, or an earlier version. Only directories named with a UUID count as machines, for identity and for discovery alike, so a differently named directory is ignored rather than indexed as a second copy. To remove a duplicate UUID directory after adopting, then commit and push:

```sh
git -C ~/cc-archive rm -r machines/<duplicate-id>
git -C ~/cc-archive commit -m "Remove duplicate machine directory"
git -C ~/cc-archive push
```

Run `cc-analyzer archive run` after adopting, not before, so new sessions go to the adopted id.

Archives created before this version have no `machine.json` until each computer runs `cc-analyzer archive run` once with it. Until then they record no hostnames, so they cannot be suggested. They still appear in the warning and in `archive show`, marked unidentified. Pick the right one by its id and adopt it by hand.

## 6. Archive size and Git history

Expect the archive to grow quickly. In one 167-session portfolio, the raw session trees were 222 MB in September and 1.6 GB two months later. Every computer keeps a full working-tree copy, so the working tree is the main disk cost.

Git history itself is cheap. In a test, ten successive snapshots of one growing 12 MB session took 28 MB as loose objects, but only 4.6 MB after `git gc`, which is less than the file itself. Transcripts are append-only text and pack well. Raw JSONL compresses about 4.4:1, so a clone transfers much less than the on-disk size suggests.

The cost to watch is loose objects that build up between `git gc` runs; in that test they were about six times the packed size. Run `git gc` on the archive periodically, and more often when `archive index on` commits on every index refresh:

```sh
git -C ~/cc-archive gc
```

## Related

- [Privacy and security](/guide/privacy)
- [CLI reference: archive](/docs/3-cli)
