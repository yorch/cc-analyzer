# Design: Plausible analytics with opt-out

**Date:** 2026-07-10
**Status:** Approved (design)
**Scope:** Add privacy-respecting usage analytics to cc-analyzer across all three
surfaces (docs site, local web SPA, CLI/TUI), reporting to a self-hosted Plausible
instance, with a transparent opt-out.

## Goal

Understand how cc-analyzer is used — marketing reach, web-UI adoption, and CLI/TUI
command usage — without collecting session content, file paths, or any personal data,
and without compromising the tool's "read-only, privacy-first" identity.

## Non-goals

- No cookies, no cross-site tracking, no PII. (Plausible is cookieless by design.)
- No writes to `~/.claude`. Telemetry state lives in the existing cc-analyzer state
  dir (`~/.config/cc-analyzer/`), alongside the pricing cache and SQLite index.
- No blocking or slowing of any command. Telemetry is fire-and-forget.
- No cookie-consent UI/banner. Consent is opt-out via a one-time notice + documented
  env var / subcommand.

## Configuration constants

| Name | Value |
| --- | --- |
| Plausible instance base URL | `https://plausible.brnby.com` |
| Docs site domain (Plausible "site" id) | `cc-analyzer.brnby.com` |
| Web SPA domain | `web.cc-analyzer` |
| CLI/TUI domain | `cli.cc-analyzer` |

All three "sites" must be registered in the Plausible instance before data appears.
Domain ids are labels only — rename in Plausible + code if desired. The instance URL
and CLI domain are overridable via env vars for testing (see Testing).

## Consent model (decided)

- **Default: ON** (opt-out) for CLI/TUI, with a **one-time first-run notice**.
- Disable precedence (any one disables telemetry, checked in this order):
  1. `CC_ANALYZER_TELEMETRY=0` (or `false`/`off`) → off
  2. `DO_NOT_TRACK=1` (the cross-tool [consoledonottrack.com](https://consoledonottrack.com) standard) → off
  3. `CI` env var present → off (avoids inflating counts from automation)
  4. Persisted config `enabled: false` (via `cc-analyzer telemetry off`) → off
  5. Otherwise → **on**
- First-run notice (printed once, when enabled and not previously shown):

  ```
  cc-analyzer collects anonymous usage stats to improve the tool.
  No session content, paths, or personal data is ever sent.
  Disable: CC_ANALYZER_TELEMETRY=0  (or run: cc-analyzer telemetry off)
  ```

## Architecture

Unified core module + per-surface adapters. One source of truth for enablement and
config; each surface consumes it as appropriate.

```
                      ┌─────────────────────────────┐
                      │  core/telemetry.ts          │
                      │  - isEnabled()              │
                      │  - trackCommand(name,props) │
                      │  - firstRunNotice()         │
                      │  - config read/write        │
                      └──────────────┬──────────────┘
          ┌──────────────────────────┼──────────────────────────┐
   CLI/TUI (index.ts, tui)     serve (server.ts)          docs site (VitePress)
   trackCommand(<cmd>)         inject script.local.js      standard script.js
   → Events API POST           iff isEnabled()             (independent lifecycle)
```

The docs site is a separate static-build lifecycle and cannot read the runtime
setting; its opt-out is Plausible's built-in `plausible_ignore` localStorage flag +
Do-Not-Track, documented rather than surfaced as UI.

## Component 1 — `src/core/telemetry.ts` (new)

Single authority. Public surface:

- `isTelemetryEnabled(): boolean` — applies the disable-precedence chain above.
  Reads env + persisted config. Pure/synchronous.
- `maybeShowFirstRunNotice(): void` — if enabled and `noticeShown` is false, print the
  notice to **stderr** (so it never contaminates piped stdout output), then persist
  `noticeShown: true`.
- `trackCommand(name: string, extraProps?: Record<string, string>): void` —
  fire-and-forget. If disabled, no-op. Otherwise builds the payload and POSTs to the
  Events API with `AbortSignal.timeout(1000)`; **all** errors (network, timeout, non-2xx)
  are swallowed. Never returns a rejected promise to the caller; never throws.
- `setTelemetryEnabled(enabled: boolean): void` — persist config (for the subcommand).
- `telemetryStatus(): { enabled: boolean; reason: string }` — for `telemetry status`.

Config file: `${STATE_DIR}/telemetry.json`
```json
{ "enabled": true, "noticeShown": true }
```
`enabled` is only written by the `telemetry on|off` subcommand; absence = default on.
`STATE_DIR` resolves via the existing `CC_ANALYZER_STATE_DIR` mechanism.

Event payload (Plausible Events API):
```
POST https://plausible.brnby.com/api/event
Headers: Content-Type: application/json
         User-Agent: cc-analyzer/<version> (<os>; <arch>)
Body:
{
  "name":   "command",
  "url":    "app://cli/<name>",
  "domain": "cli.cc-analyzer",
  "props": {
    "name":            "<command>",     // index | stats | serve | tui | ...
    "version":         "<pkg version>",
    "os":              "darwin|linux|win32",
    "arch":            "arm64|x64|...",
    "sessions_bucket": "1-10|11-100|101-1000|1000+"   // omitted if no index
  }
}
```

- `version` from `package.json` (already importable).
- `os`/`arch` from `process.platform` / `process.arch`.
- `sessions_bucket`: bucket of `SELECT count(*) FROM sessions` **only if the index DB
  already exists** — no new scan, no DB creation. Omitted otherwise.
- Plausible needs a User-Agent (else it drops the event); IP is used only for its
  daily-rotating, salted, discarded unique-visitor hash. We set a descriptive UA and
  do not send `X-Forwarded-For` (Plausible uses the request IP). No IP is stored.

### Timing / non-blocking

The CLI is short-lived. `trackCommand` is called **after** the command's real work
completes and after user-visible output is flushed. It starts the POST but the process
should not wait more than the 1s abort cap; failures are silent. Rationale: correctness
and zero user-facing latency beat guaranteed delivery for opt-out telemetry.

## Component 2 — CLI/TUI wiring (`src/cli/index.ts`, TUI entry)

- After routing/executing a command, call `maybeShowFirstRunNotice()` then
  `trackCommand(<commandName>)`. TUI launch reports `trackCommand("tui")`.
- New subcommand `cc-analyzer telemetry <on|off|status>`:
  - `on` → `setTelemetryEnabled(true)`, print confirmation.
  - `off` → `setTelemetryEnabled(false)`, print confirmation.
  - `status` → print `telemetryStatus()` (enabled + reason, e.g. "disabled via
    DO_NOT_TRACK").
- The `telemetry` subcommand itself is **not** tracked.

## Component 3 — Local web SPA (`src/web/server.ts`)

- `runServe` calls `isTelemetryEnabled()`. When enabled, inject the Plausible tag into
  the served HTML before `</head>`:
  ```html
  <script defer data-domain="web.cc-analyzer"
          src="https://plausible.brnby.com/js/script.local.js"></script>
  ```
  **`script.local.js`** (not `script.js`) because the standard script deliberately
  ignores `localhost`/`file://` and would record nothing from `localhost:4317`.
- When disabled, inject nothing. Injection is a string operation on `spaHtml` at serve
  time; the generated `src/web/spa.ts` artifact is unchanged (still self-contained;
  analytics is the one intentional external request, made by the browser at runtime).
- If `hasSpa` is false (UI not built into binary), no injection.

## Component 4 — Docs site (`site/.vitepress/config.ts`)

- Add to the `head` array:
  ```ts
  ["script", {
    defer: "",
    "data-domain": "cc-analyzer.brnby.com",
    src: "https://plausible.brnby.com/js/script.js",
  }]
  ```
- Standard `script.js` auto-ignores localhost, so `vitepress dev` / local previews do
  not pollute production stats.
- Opt-out: Plausible honors Do-Not-Track and the `localStorage.plausible_ignore=true`
  flag; documented in the site/README rather than shown as a banner (cookieless, no
  consent UI legally required for this data).

## Security note: Subresource Integrity (SRI)

The two browser `<script>` tags intentionally omit `integrity="sha384-..."`. SRI pins a
script to a fixed hash; Plausible ships a self-updating script and does not publish
stable SRI hashes, so pinning would break analytics on every instance upgrade (this is
why Plausible's official snippet omits it). The scripts load from the **self-hosted,
first-party-controlled** origin `plausible.brnby.com`, not a third-party CDN, so the
CDN-compromise threat SRI defends against is low. If defense-in-depth is later desired,
a Content-Security-Policy `script-src https://plausible.brnby.com` is the better lever
than SRI here.

## Data flow summary

| Surface | Transport | Trigger | Domain |
| --- | --- | --- | --- |
| Docs site | `script.js` (browser) | pageview | `cc-analyzer.brnby.com` |
| Web SPA | `script.local.js` (browser) | pageview | `web.cc-analyzer` |
| CLI/TUI | Events API POST (server-side) | per command run | `cli.cc-analyzer` |

## Error handling

- `trackCommand`: catch-all; network/timeout/non-2xx → silently ignored. A telemetry
  failure must never surface to the user or change an exit code.
- Config read: malformed/missing `telemetry.json` → treat as defaults (enabled, notice
  not shown). Never throw.
- Config write failures (read-only FS, etc.): swallow; telemetry simply behaves as if
  the setting weren't persisted.

## Testing

All tests isolate config via `CC_ANALYZER_STATE_DIR` (tmp dir) and mock the network —
no real requests. The instance URL / CLI domain are read from env overrides
(`CC_ANALYZER_TELEMETRY_URL`, `CC_ANALYZER_TELEMETRY_DOMAIN`) defaulting to the
constants above, so tests point `fetch` at a sink.

- `isTelemetryEnabled`: each disable path — `CC_ANALYZER_TELEMETRY=0`, `DO_NOT_TRACK=1`,
  `CI` set, config `enabled:false` — returns false; clean env returns true; precedence
  order honored.
- `maybeShowFirstRunNotice`: prints once, sets `noticeShown`; second call prints
  nothing; does nothing when disabled.
- `trackCommand`: builds the expected payload (mocked `fetch`, assert body/headers);
  omits `sessions_bucket` when no index; includes correct bucket for boundary counts
  (10/11, 100/101, 1000/1001).
- Fire-and-forget: when `fetch` rejects or times out, `trackCommand` resolves/returns
  without throwing.
- `setTelemetryEnabled` / `telemetryStatus`: round-trip through the config file.

## Documentation updates

- `README.md`: a "Telemetry & privacy" section — what's collected, the three surfaces,
  and every way to opt out (`CC_ANALYZER_TELEMETRY=0`, `DO_NOT_TRACK`, `telemetry off`).
- `CLAUDE.md`: note the new `core/telemetry.ts` authority and the "one opt-out governs
  CLI + SPA; docs site is independent" split, so future edits stay consistent.
- Site: brief privacy note mentioning Plausible + `plausible_ignore`.

## Open items for the implementation plan

- Exact insertion point for `trackCommand` in the arg router relative to each command's
  return, ensuring output flushes first.
- Whether TUI reports a single `tui` launch event only (yes, per design) vs. in-TUI
  navigation (out of scope).
