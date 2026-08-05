---
title: Install
description: Install cc-analyzer — one-line installer, prebuilt binaries, checksum verification, self-update, and running from source.
---

# Install cc-analyzer

`cc-analyzer` ships as a **single self-contained binary** for macOS, Linux, and
Windows — no Bun, Node, or other runtime required. It is **read-only**: it never
writes to `~/.claude`, and its own state (pricing cache, session index) lives
under `~/.config/cc-analyzer/`.

## One-line install

The installer detects your OS and architecture, downloads the matching binary
from the [latest release](https://github.com/yorch/cc-analyzer/releases/latest),
verifies its checksum, and installs it.

::: code-group

```sh [macOS / Linux]
curl -fsSL https://cc-analyzer.brnby.com/install.sh | sh
```

```powershell [Windows]
irm https://cc-analyzer.brnby.com/install.ps1 | iex
```

:::

By default it installs to `~/.local/bin` (macOS/Linux) or
`%LOCALAPPDATA%\cc-analyzer\bin` (Windows). If that directory isn't on your
`PATH`, the installer prints the line to add to your shell profile.

Prefer to read before piping to a shell? Inspect the scripts first:
[`install.sh`](https://cc-analyzer.brnby.com/install.sh) ·
[`install.ps1`](https://cc-analyzer.brnby.com/install.ps1).

### Options

Both installers read two environment variables:

| Variable | What it does | Default |
| --- | --- | --- |
| `CC_ANALYZER_INSTALL_DIR` | Install directory | `~/.local/bin` · `%LOCALAPPDATA%\cc-analyzer\bin` |
| `CC_ANALYZER_VERSION` | Release tag to install, e.g. `v0.4.1` | `latest` |

::: code-group

```sh [macOS / Linux]
CC_ANALYZER_VERSION=v0.4.1 CC_ANALYZER_INSTALL_DIR="$HOME/bin" \
  sh -c "$(curl -fsSL https://cc-analyzer.brnby.com/install.sh)"
```

```powershell [Windows]
$env:CC_ANALYZER_VERSION = 'v0.4.1'
irm https://cc-analyzer.brnby.com/install.ps1 | iex
```

:::

## Download a prebuilt binary (manual)

Every [release](https://github.com/yorch/cc-analyzer/releases/latest) attaches a
binary for each platform:

| Platform | Asset |
| --- | --- |
| macOS (Apple silicon) | `cc-analyzer-darwin-arm64` |
| macOS (Intel) | `cc-analyzer-darwin-x64` |
| Linux (x64) | `cc-analyzer-linux-x64` |
| Linux (arm64) | `cc-analyzer-linux-arm64` |
| Windows (x64) | `cc-analyzer-windows-x64.exe` |

::: code-group

```sh [macOS / Linux]
curl -fL -o cc-analyzer \
  https://github.com/yorch/cc-analyzer/releases/latest/download/cc-analyzer-darwin-arm64
chmod +x cc-analyzer
sudo mv cc-analyzer /usr/local/bin/   # or anywhere on your PATH
cc-analyzer --help
```

```powershell [Windows]
curl.exe -fL -o cc-analyzer.exe `
  https://github.com/yorch/cc-analyzer/releases/latest/download/cc-analyzer-windows-x64.exe
.\cc-analyzer.exe --help
```

:::

On macOS the binary is unsigned, so Gatekeeper quarantines the download. Clear
the quarantine flag once:

```sh
xattr -d com.apple.quarantine /usr/local/bin/cc-analyzer
```

### Verify the checksum

The one-line installer verifies automatically. For a manual download, compare the
binary's hash against the release `SHA256SUMS`:

```sh
shasum -a 256 cc-analyzer   # or: sha256sum cc-analyzer
# then compare the printed hash to the matching line in:
curl -fsSL https://github.com/yorch/cc-analyzer/releases/latest/download/SHA256SUMS
```

## Update

Installed as a binary, update in place:

```sh
cc-analyzer update
```

It downloads the latest release (streaming with a progress bar), verifies the
checksum, and atomically replaces the running binary. Check without installing
via `cc-analyzer update --check`. On Windows, re-run the installer one-liner.

`cc-analyzer` also prints a passive, once-a-day notice when a newer version is
available; silence it with `CC_ANALYZER_NO_UPDATE_CHECK=1`.

## First run and index freshness

Launch the terminal UI directly:

```sh
cc-analyzer
```

Or start the local web app and open it in your default browser:

```sh
cc-analyzer serve --open
```

Both commands build the local session index automatically when it is empty.
After that, indexing remains explicit so a large changed session cannot make
startup unexpectedly slow. The TUI, `stats`, and web app show when the index was
last refreshed and warn when session files were added, changed, or deleted.

```sh
cc-analyzer index --check       # inspect freshness without changing the cache
cc-analyzer index               # incremental refresh
cc-analyzer serve --refresh     # refresh, then serve
```

`index --check` exits non-zero when the cache is stale, making it suitable for
scripts. `serve --open` is opt-in and only opens a browser for loopback hosts.

## Claude data directories

cc-analyzer reads `~/.claude` by default, and honours `CLAUDE_CONFIG_DIR` when
you have relocated Claude Code's data directory — a relocated install needs no
configuration.

You can also name directories yourself, and **several are analyzed together as
one portfolio** — useful for a work profile alongside a personal one, or for
several machines' data synced into a single folder:

```sh
cc-analyzer claude-dir                      # what is in effect, and why
cc-analyzer claude-dir add ~/work/.claude   # append a directory
cc-analyzer claude-dir remove ~/work/.claude
cc-analyzer claude-dir reset                # back to the default resolution
cc-analyzer index                           # pick up the change

cc-analyzer --claude-dir=/path/to/.claude stats   # just this once
```

If you see an empty portfolio, run `cc-analyzer claude-dir`: it prints every
directory being searched and which setting put it there.

Two directories can hold sessions for the same working directory; they stay
separate projects, and lists name the directory when the labels would collide.
The index mirrors your configured list, so removing a directory removes its
sessions on the next `cc-analyzer index` — a directory that is merely
unreachable at that moment (an unmounted volume) keeps its data instead.

## Telemetry & privacy

`cc-analyzer` reports **anonymous, cookieless** usage stats to a self-hosted
[Plausible](https://plausible.io) instance, so its author can see which features
are actually used. It is built to respect the tool's read-only, privacy-first
nature:

- **Never sent:** session content, prompts, file paths, project names, tokens,
  costs, or anything identifying. Each CLI event carries only the command name
  (`stats`, `index`, …), the cc-analyzer version, your OS/arch, and a coarse
  session-count bucket (e.g. `11-100`). The web app reports only which **view**
  you open (`/session`, `/project`, …) — the session id or project path in the
  URL is stripped before anything is sent.
- **Where:** the CLI and TUI send server-side events; the local web app
  (`serve`) bundles the Plausible tracker and this docs site loads its cookieless
  script. Telemetry state lives only under `~/.config/cc-analyzer/` — **never**
  in `~/.claude`.
- **Never in your way.** A CLI command never waits on the network to report
  itself: it hands the event to a short-lived background copy of `cc-analyzer`
  and exits immediately. That is the second `cc-analyzer` process you may see
  briefly in `ps` — it sends one small request and stops. When telemetry is off,
  nothing is spawned and nothing is sent.
- **On by default, easy to opt out.** The first run prints a one-time notice.

Opt out in any of these ways — any one is enough:

```sh
cc-analyzer telemetry off        # persisted setting
export CC_ANALYZER_TELEMETRY=0   # per-shell / per-run
export DO_NOT_TRACK=1            # honored globally
```

Telemetry is also **automatically disabled in CI** (when `CI` is set). Check the
current state any time:

```sh
cc-analyzer telemetry status
```

The `DO_NOT_TRACK` environment variable governs CLI telemetry and the locally
served web app. In the web app and this docs site,
`localStorage.plausible_ignore = "true"` disables browser analytics.

## Run from source

With [Bun](https://bun.sh) ≥ 1.3:

```sh
git clone https://github.com/yorch/cc-analyzer.git
cd cc-analyzer
bun install
bun start <command>   # e.g. bun start stats
```

## Uninstall

Remove the binary and, optionally, cc-analyzer's local state:

```sh
rm "$(command -v cc-analyzer)"
rm -rf ~/.config/cc-analyzer   # pricing cache + session index (safe to delete)
```

Your Claude Code data in `~/.claude` — or any other directory you pointed
cc-analyzer at — is never touched.

---

Next: [build the index and read your stats ▸](/docs/3-cli), or
[browse the docs ▸](/docs/).
