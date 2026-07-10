#!/bin/sh
# cc-analyzer installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/yorch/cc-analyzer/main/install.sh | sh
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
# GitHub redirects /releases/latest/download/<asset> to the newest release, so
# no API token or tag lookup is needed for the common case.
if [ "$VERSION" = latest ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# --- download --------------------------------------------------------------
info "cc-analyzer (${VERSION}) · ${os}/${arch}"
info "downloading ${asset}..."
tmp=$(mktemp) || err "could not create a temporary file"
trap 'rm -f "$tmp"' EXIT INT TERM
curl -fSL --progress-bar "$url" -o "$tmp" ||
  err "download failed — is ${asset} published for ${VERSION}? (${url})"

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
