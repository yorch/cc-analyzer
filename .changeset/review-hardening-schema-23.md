---
"cc-analyzer": minor
---

Review-driven fixes and hardening. Schema v23 triggers a one-time automatic reindex.

**Security**

- `serve` on a non-loopback `--host` is now read-only for writes: `PUT`/`POST /api/prefs`, `POST /api/sessions/:id/analyze` and `GET /api/export` return `403`. Write routes require `Content-Type: application/json` and, when an `Origin` header is sent, a same-origin one. Responses carry `X-Content-Type-Options: nosniff`.
- `--redact` is now allowlist-based: one shared redactor (`src/core/redact.ts`) feeds the CLI, TUI, web, and export payloads, so string fields not known to be safe are redacted by default. Shareable export bundles carry aggregates only, and the HTML report has no script and a restrictive Content-Security-Policy.
- Analyze-with-Claude-Code also denies `Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,mcp__*`, fences the session title and project path as untrusted data, and kills the `claude` child on abort, client disconnect, or early stop.
- `archive` refuses a path inside another Git repository and never writes through symlinked destinations (reported as refused).
- The telemetry poster payload is passed over stdin instead of argv.

**Fixes**

- `index --rebuild` is atomic: an interrupted rebuild no longer leaves an empty usage ledger, and a failed analysis releases its claims and leaves a re-analysis debt.
- Bundled prices are layered under the remote/cached LiteLLM table, so ids LiteLLM dropped keep pricing.
- Analyzer hardening for drifted events, replayed tool blocks, late test results, and turn depth for cross-file refused calls.
- Diagnostics: idle-cache rewrites respect the previous call's cache TTL and require write > read; repeated-file-reads triggers per chain; cache-churn needs at least two writes; error-rate-rising zero-fills gap weeks and drops only the current week.
- Web: data stays visible while refetching and requests abort; error boundary, not-found route, per-route title and focus, and better light-theme text contrast.

**Behavior changes**

- Schema v23: the index rebuilds once on first run.
- Non-loopback `serve` can no longer change prefs, run Analyze-with-Claude, or export.
- CLI is stricter: `--help`/`-h` after a subcommand never runs it; unknown flags and valueless flag values exit 2; `serve --port N` / `--host x` space forms work; unknown commands print to stderr and exit 2; `doctor` exits 0 healthy, 1 warning/damaged, 2 usage; `FORCE_COLOR` is honored; valueless `--project`/`--session` are errors.
