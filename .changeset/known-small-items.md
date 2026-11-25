---
"cc-analyzer": patch
---

Small fixes found by a real-browser pass and a review of the multi-root labelling work.

- Web: the Tools tab (and any other hash-param control) now follows in-page hash changes and Back/Forward; the Dashboard digest card tags its top project with its root; the Projects filter matches path and alias like the other lists; the Session page and Tools > setup no longer overflow horizontally at phone width.
- `report --json` and `/api/report` no longer carry the render-only `knownLabels` list.
- The telemetry poster's stdin read is bounded (2s), so it can never hang on a pipe whose writer died.
