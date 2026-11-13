---
"cc-analyzer": patch
---

Build the docs site in CI on every pull request, so a broken docs link or anchor fails the PR instead of the post-merge site deploy. The CLI telemetry test now asserts that the event is delivered by a process that outlives the command, instead of comparing arrival times, which a busy machine could reorder and fail about a third of the time.
