---
"cc-analyzer": patch
---

Match archived sessions to live sessions one session at a time, not by hiding a whole computer's archive.

Before, a computer's archived copy of its own sessions was hidden from the index whenever its live Claude data directory was readable, and that decision depended on which archived machine was "this computer". Sessions disappeared from reports after emptying `~/.claude/projects`, after a parent transcript was deleted, or when two computers shared a hostname. Now every archived copy is matched to its live session by project and session id. A copy is left out only when another copy already holds everything in it, so a session's cost is never counted twice, and a session that is only in the archive is kept. Copies that differ, for example because a session was continued on another computer, are both kept, so no activity is lost. Their cost is still counted once.

- `archive run` no longer overwrites a complete archived transcript with a shorter live copy. It keeps the archived file and reports the session as not updated.
- When archive-during-index cannot copy because this computer's archive identity is unresolved, `index`, the TUI, and `serve` all print a warning saying so. A skipped backup is otherwise lost for good once Claude Code deletes the live transcript.
- `index --rebuild` no longer double-counts a session for good when one of its transcripts cannot be read during the rebuild. The total corrects itself on the next run that can read the file.
- `cc-analyzer sessions <project>` points you to another project only when that project really holds the sessions.
- The index schema is now 22, so an existing index is dropped and rebuilt on the next index refresh.
