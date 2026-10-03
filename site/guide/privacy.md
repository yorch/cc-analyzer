---
title: "Privacy & security of Claude Code analysis"
description: "Understand what cc-analyzer reads, writes, sends, and exposes: local-only analysis, telemetry opt-out, the transcript archive, and Claude handoff."
---

# Privacy and security

## Normal analysis stays local

Indexing, portfolio analytics, the TUI, and the local web app read Claude Code
files from your configured directories. cc-analyzer does not modify the source
transcripts or Claude configuration during ordinary analysis. Its own cache,
preferences, exports, update checks, and telemetry state live in the
cc-analyzer state directory.

## Optional raw transcript archive

`cc-analyzer archive` is an explicit opt-in that copies raw session and
subagent JSONL into a dedicated local Git repository. You can also enable
copy-and-commit during index refreshes with `cc-analyzer archive index on`.
This archive is outside Claude's data directory and is intended to survive its
cleanup; the configured path must not overlap a Claude data directory. The
archive is **not encrypted**. If you push it to a remote such as GitHub, that
remote receives prompts, tool output, and other transcript content. A private
repository is still a remote copy, and Git history retains old versions after
files are updated or deleted. cc-analyzer never pushes automatically. Choose a
remote and retention policy you trust.

## Optional Analyze-with-Claude handoff

`analyze --with-claude` and the web Analyze action intentionally start a normal
local Claude Code process to produce a retrospective. That process may send
session content to the model provider and may run your normal Claude hooks and
configuration. It does not resume the reviewed session and is not required for
ordinary analysis. Use it only when that processing is acceptable.

## Telemetry

Telemetry is anonymous and cookieless at the event-payload level: it reports
command, version, operating system, architecture, and coarse usage buckets,
not prompts or transcript content. Network requests necessarily expose normal
transport metadata such as IP address and User-Agent to the telemetry service.
Disable it with:

```sh
cc-analyzer telemetry off
export CC_ANALYZER_TELEMETRY=0
export DO_NOT_TRACK=1
```

## Web exposure

The web server binds to `127.0.0.1` by default and applies a loopback Host
guard. A non-loopback `--host` disables that protection and exposes the
unauthenticated dashboard, transcript and export routes, preference writes,
and optional Claude handoff to the network. Use a trusted network and add your
own access control if you intentionally expose it.

See the [Web/API implementation reference](/docs/5-web-server-and-api) for
the detailed route and host-guard behavior.
