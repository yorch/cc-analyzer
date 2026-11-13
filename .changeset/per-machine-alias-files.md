---
"cc-analyzer": minor
---

Store project aliases per computer so editing them can never cause a Git merge conflict. Each computer now writes its alias edits only under its own `machines/<id>/` (in `project-aliases.json`), and the effective alias for a path is the most recent edit across all computers (removals are recorded so they win too). Computers that edit aliases at different times merge with a plain `git pull`; there is no shared JSON file to hand-merge.

The old shared `project-aliases.json` is still read, as the lowest-priority source, and is never rewritten, so existing aliases keep working. An older cc-analyzer on another computer will not see aliases written by this version, so update every computer before editing aliases from more than one.

`archive alias set`, `current`, and `remove` now need this computer to have a recorded identity (`archive machine keep`, `archive machine adopt <id>`, or a first `archive run`). Each edit commits this computer's `machine.json` in the same commit as its alias file. Commands that read aliases now report an unreadable alias file as a clean error that names the computer that wrote it and how to recover, instead of a stack trace.
