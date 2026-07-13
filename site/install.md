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

## Telemetry & privacy

`cc-analyzer` reports **anonymous, cookieless** usage stats to a self-hosted
[Plausible](https://plausible.io) instance, so its author can see which features
are actually used. It is built to respect the tool's read-only, privacy-first
nature:

- **Never sent:** session content, prompts, file paths, project names, tokens,
  costs, or anything identifying. Each CLI event carries only the command name
  (`stats`, `index`, …), the cc-analyzer version, your OS/arch, and a coarse
  session-count bucket (e.g. `11-100`).
- **Where:** the CLI and TUI send server-side events; the local web app
  (`serve`) and this docs site load Plausible's cookieless script. Telemetry
  state lives only under `~/.config/cc-analyzer/` — **never** in `~/.claude`.
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

In the web app and this docs site, Do-Not-Track and
`localStorage.plausible_ignore = "true"` are both honored.

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

Your Claude Code data in `~/.claude` is never touched.

---

Next: [build the index and read your stats ▸](/docs/3-cli), or
[browse the docs ▸](/docs/).
