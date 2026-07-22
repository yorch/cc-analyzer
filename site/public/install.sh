#!/bin/sh
# cc-analyzer installer for macOS and Linux.
#
#   curl -fsSL https://yorch.github.io/cc-analyzer/install.sh | sh
#
# Environment overrides:
#   CC_ANALYZER_VERSION      release tag to install (e.g. v0.2.0); default: latest
#   CC_ANALYZER_INSTALL_DIR  install directory; default: $HOME/.local/bin
set -eu

REPO="yorch/cc-analyzer"
BIN="cc-analyzer"
INSTALL_DIR="${CC_ANALYZER_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CC_ANALYZER_VERSION:-latest}"

info() { printf '  %s\n' "$*"; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || err "curl is required to run this installer"

# HTTPS only, no protocol downgrade via redirects.
CURL="curl --proto =https --tlsv1.2"

# --- detect platform -------------------------------------------------------
os=$(uname -s)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) err "unsupported OS '$os' — this installer supports macOS and Linux; on Windows use install.ps1" ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) err "unsupported architecture '$arch'" ;;
esac

asset="${BIN}-${os}-${arch}"

# --- resolve download URL --------------------------------------------------
# Resolve "latest" to a concrete tag once (via the /releases/latest redirect),
# so the binary and its SHA256SUMS come from the same release even if a new one
# is published mid-install. If that HEAD request is blocked (some proxies), fall
# back to the latest/download alias — a tiny asset/manifest race, but it installs.
if [ "$VERSION" = latest ]; then
  resolved=$($CURL -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" 2>/dev/null | sed 's|.*/||') || resolved=""
  case "$resolved" in
    v[0-9]*) base="https://github.com/${REPO}/releases/download/${resolved}" ;;
    *) base="https://github.com/${REPO}/releases/latest/download" ;;
  esac
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi
url="${base}/${asset}"
sums_url="${base}/SHA256SUMS"

# --- download --------------------------------------------------------------
info "cc-analyzer (${VERSION}) · ${os}/${arch}"
info "downloading ${asset}..."
tmp=$(mktemp) || err "could not create a temporary file"
trap 'rm -f "$tmp"' EXIT INT TERM
$CURL -fSL --progress-bar "$url" -o "$tmp" ||
  err "download failed — is ${asset} published for ${VERSION}? (${url})"

# --- verify checksum -------------------------------------------------------
# Best-effort: enforced when SHA256SUMS is published; skipped (with a note) for
# older releases that predate it, or when no sha256 tool is available.
verify_checksum() {
  sums=$($CURL -fsSL "$sums_url" 2>/dev/null) ||
    { info "no SHA256SUMS for this release; skipping checksum verification"; return 0; }
  expected=$(printf '%s\n' "$sums" | awk -v a="$asset" '{f=$2; sub(/^\*/,"",f); if (f==a) print $1}' | head -1)
  [ -n "$expected" ] ||
    { info "no checksum listed for ${asset}; skipping verification"; return 0; }
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$tmp" | awk '{print $1}')
  else
    info "no sha256 tool found; skipping checksum verification"
    return 0
  fi
  [ "$actual" = "$expected" ] ||
    err "checksum mismatch for ${asset} (expected ${expected}, got ${actual})"
  info "checksum verified"
}
verify_checksum

# --- install ---------------------------------------------------------------
mkdir -p "$INSTALL_DIR" || err "could not create ${INSTALL_DIR}"
target="${INSTALL_DIR}/${BIN}"
chmod +x "$tmp"
mv "$tmp" "$target" || err "could not move binary into ${INSTALL_DIR}"
trap - EXIT INT TERM
info "installed to ${target}"

# --- PATH guidance ---------------------------------------------------------
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    info ""
    info "${INSTALL_DIR} is not on your PATH. Add it to your shell profile:"
    info "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

info ""
info "Done. Run '${BIN} help', or just '${BIN}' for the interactive TUI."
