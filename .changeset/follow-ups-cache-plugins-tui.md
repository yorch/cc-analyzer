---
"cc-analyzer": patch
---

Follow-ups to the review hardening release.

- Web: prefs, insights and analytics are fetched once and shared across views (60s cache, invalidated when prefs change); one shared mini-bar component; 44px touch targets for interactive controls; heatmap and calendar charts expose a visible "show data table" path for touch and keyboard users.
- TUI: opening session search or help no longer discards the session screen; session search expands `~`, strips pasted quotes, finds bare ids across roots (including archives) and says why a lookup failed; Insights shows a loading frame instead of freezing the first render.
- Setup audit: installed plugins are read from `installed_plugins.json` when present (so plugin names are never invented from record fields and merely-cloned marketplaces are not reported as installed), and `plugins/cache` is no longer skipped.
- Per-root project labels now work for the compaction, web-tools, estimated-share and sidechain rollups, and the compaction-pressure rule can see small projects with a high compaction share.
- Chart markers no longer land after untimed points that precede them.
