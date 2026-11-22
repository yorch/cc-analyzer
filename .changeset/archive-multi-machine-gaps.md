---
"cc-analyzer": patch
---

Make multi-computer archives trustworthy, and stop alias edits re-reading the whole portfolio.

A computer's archive identity used to be a random id recorded only in local state. Losing it (a cleared state directory, a fresh install, a restored home) made the computer's own archived copy look like a *different* computer, so its sessions were counted twice, inflating session counts and activity metrics while the de-duplicated portfolio cost stayed correct. Identity is now recorded in the archive itself as `machines/<id>/machine.json`, and resolution never guesses:

- A computer with no recorded identity is not assigned one silently. `archive machine` lists the archived machines until the user acts, and `archive run` refuses to write into the archive's permanent history while identity is unresolved, naming both remedies.
- A matching hostname is only a **suggestion**. Recovery is always explicit: `cc-analyzer archive machine adopt <id>`, or `cc-analyzer archive machine keep` for a genuinely new computer. Auto-adopting on a hostname match could make two computers archive into one machine directory, mixing their raw transcripts in Git history.
- `adopt` refuses an identity whose recorded hostnames exclude this computer unless `--force` is given.
- `archive show` lists every machine directory it recognises with its full id, marks which one is this computer, and marks ones that predate `machine.json` as unidentified instead of hiding them.

Changing a project alias now re-analyzes only the sessions whose project label actually changed, instead of the entire portfolio. The selection compares each indexed row's own recorded alias against the current map, so it cannot be thrown off by a partially failed scan or an unreadable root, and `index --check` reports exactly the work `index` will do. Archiving also compares file contents by streaming instead of hashing every session twice per run.
