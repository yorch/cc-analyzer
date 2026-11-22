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

The index reads archived sessions by default and counts each session's cost once, whichever computer holds it. Sessions are matched by project and session id, not by computer. A copy in the archive is left out only when another copy already holds everything in it, so a computer's archived copy of a session it still has live is not counted. If two copies differ, for example because the session was continued on another computer, both are kept: the session can then appear more than once and inflate activity counts. Its cost is still counted once, except briefly while a copy is unreadable (see Known limits below). See [How archived copies are matched](#how-archived-copies-are-matched).

`cc-analyzer archive show` lists the computers recorded in the archive. Each computer should appear once. A second directory for the same computer does not double its sessions in the index, but it keeps a second copy of its transcripts in the archive; see [Machine identity](#_5-machine-identity-and-recovery).

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

The id keeps one computer from appearing as two. If the state directory is lost (cleared, a fresh install, or a home directory restored from backup), the computer has no id. Earlier versions minted a new one and archived every session again under it, so the old directory looked like a different computer. In one 167-session portfolio, session and turn counts doubled while cost and API-call counts stayed correct, because usage is de-duplicated across files. The result was inflated activity numbers and a cost-per-session average that was too low, with nothing on screen to explain it. Sessions are now matched by session id, so a duplicate directory holding the same sessions no longer inflates the portfolio's session counts.

cc-analyzer never guesses which archived computer is this one. Without a local id it mints a throwaway id in memory and does not save it, so the problem is reported again on every run until you resolve it. Two computers can share a hostname and a data-directory path; a wrong guess would make two computers archive into one machine directory, mixing their raw transcripts in Git history. A wrong identity does not change any number the index shows.

When the archive already holds other machines, `cc-analyzer archive machine` and every `archive run` attempt report it on every run, listing each machine with its full id. A machine whose recorded hostnames include this computer's is marked as a suggestion; it is a hint, not a decision. `archive run` refuses, because it writes raw transcripts into permanent Git history. Reading does not depend on which id this computer holds, so `index`, `projects`, and `sessions` give the same numbers either way. The one place it shows up is archive-during-index (`archive index on`): an `index` that cannot copy because of the unresolved identity prints a warning and skips the copy, and the TUI and `serve` print the same warning at startup. Resolve it one of two ways:

```sh
# This computer is one of the listed machines (copy the full id)
cc-analyzer archive machine adopt <id>

# This is a genuinely new computer, none of the listed machines
cc-analyzer archive machine keep
```

`adopt` refuses an id whose recorded hostnames do not include this computer's, since that is the signature of claiming another live computer's identity. If this computer was renamed, add `--force`. `archive run` never adds this computer's hostname to a `machine.json` that names only other hosts, so a forced adoption does not become a recorded fact. An unidentified machine (no `machine.json`, see below) records no hostnames and is not blocked. A first-ever `archive run` against a repository with no commits needs neither command: it creates and saves the id itself. Any archive with history requires `adopt` or `keep`.

`keep` leaves every listed directory in place. If one of them is this computer, its transcripts are archived a second time under the new id, with no further warning, so `keep` requires `--force` when a listed machine records this computer's hostname, and restates what it passed over.

Neither `adopt` nor `keep` needs an index rebuild: the index does not depend on which id a computer holds, so the rows already indexed stay valid. Upgrading to the version that introduced session-level matching rebuilds the index once on its own.

A stray `machines/<id>` directory can still appear, for example from a merge, a hand edit, or an earlier version. Only directories named with a UUID count as machines, for identity and for discovery alike, so a differently named directory is ignored rather than indexed as a second copy. To remove a duplicate UUID directory after adopting, then commit and push:

```sh
git -C ~/cc-archive rm -r machines/<duplicate-id>
git -C ~/cc-archive commit -m "Remove duplicate machine directory"
git -C ~/cc-archive push
```

Run `cc-analyzer archive run` after adopting, not before, so new sessions go to the adopted id.

Archives created before this version have no `machine.json` until each computer runs `cc-analyzer archive run` once with it. Until then they record no hostnames, so they cannot be suggested. They still appear in `archive show`, marked unidentified, and in the candidate list that `archive machine` prints. Pick the right one by its id and adopt it by hand.

### How archived copies are matched

Copies of a session are matched by project directory and session id. Before a copy is left out of the index, another copy must hold everything in it: the parent transcript and every subagent transcript. Transcripts only grow, so a copy that is a prefix of another is redundant and is dropped. A copy that differs, for example one this computer continued after another computer archived it, is kept alongside the other. The index counts each API call once across the copies, so a kept copy never adds cost twice. Turn and tool counts can repeat the shared part when the copies differ.

The comparison reads only the last 64 KiB of each file, at the same offsets. A fork is always detected, however early it happened, because it changes every byte after the fork point. What the check can miss is an equal-length in-place edit located entirely before the last 64 KiB; append-only transcripts do not do that. Any read error keeps the copy, so when in doubt it keeps the copy.

**Truncated live files.** If Claude Code shrinks a live transcript so that it is a prefix of the archived copy, `archive run` keeps the archived file and reports the session as not updated. A complete transcript is not replaced with a shorter one. Git history would still hold the old version, but the index reads the working tree. A live file that grew or changed is copied as usual. If `cc-analyzer sessions <project>` finds nothing in a project because every session in it was dropped as redundant to another copy, typically an archived copy that holds them, it says so and names only the project that holds that copy. `cc-analyzer projects` shows both. Any other project with no sessions prints `No sessions found for project '<id>'.` and exits `1`, as does the redirect.

**Known limits.**

- If a Claude data directory cannot be listed, for example an unmounted volume or a missing `projects` directory, its sessions stay in the index from the last scan that could read it, and their archived copies stay hidden. While the directory is away, an archived copy that holds calls the indexed copy lacks is not counted, so the total is briefly short. It is not doubled, and it corrects itself once the directory is readable again, with no manual step. `cc-analyzer analyze <id>` opens the archived copy. The web session page for that id answers 404 with "session file is missing", and re-running `cc-analyzer index` does not change that until the directory is readable again.
- A subagent transcript that cannot be read is skipped and recorded only as a parse error, so `index` and `index --check` report nothing and the session stays indexed without it. The gap stays until that file is readable and the session changes, or `cc-analyzer index --rebuild` runs.
- A `cc-analyzer index --rebuild` while a transcript cannot be read can briefly count its calls twice. The rebuild clears the usage claims of every file it re-analyzes. The unreadable file keeps its old row and its old call count, and the other copies of the session re-claim those calls. Until the file reads again, the total is above the true figure (for example, 3 + 3 where 4 is true). It corrects itself on the first run that can read the file, with no manual step. `index --check` reports the index as stale until then. Without `--rebuild`, an unreadable transcript does not double-count its calls.
- A session with diverged copies has one index row per copy, and its activity counts can double. Its cost is counted once, except briefly as described in the first and third bullets above.
- A fork is always detected, but an equal-length in-place edit before the last 64 KiB is not (see above).

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
