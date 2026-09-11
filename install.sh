#!/bin/bash
# One-step install for Golinks.
#
#   From a downloaded zip or a git clone, inside the folder:   bash install.sh
#   Without downloading anything first (installs to ~/go-links):
#     curl -fsSL https://raw.githubusercontent.com/gvensan/go-links/master/install.sh | bash
#
# Set GOLINKS_DIR to install somewhere other than ~/go-links.
set -euo pipefail
if [ "$(uname)" != "Darwin" ]; then echo "Golinks runs on macOS only."; exit 1; fi

REPO="${GOLINKS_REPO:-gvensan/go-links}"
BRANCH="${GOLINKS_BRANCH:-master}"
TARBALL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"

# Where is the code? Next to this script when run from a folder; downloaded when piped from curl.
ROOT=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$ROOT/server.js" ] || ROOT=""
fi

if [ -z "$ROOT" ]; then
  ROOT="${GOLINKS_DIR:-$HOME/go-links}"
  echo "Downloading Golinks to $ROOT"
  tmp="$(mktemp -d)"
  curl -fsSL "$TARBALL" | tar -xz -C "$tmp" || { echo "download failed"; rm -rf "$tmp"; exit 1; }
  src="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  mkdir -p "$ROOT"
  if [ -f "$ROOT/server.js" ]; then
    # Already installed here: update the code, keep data, snapshots and logs.
    mkdir -p "$ROOT/bin"; cp "$src/bin/golinks" "$ROOT/bin/golinks"; chmod +x "$ROOT/bin/golinks"
    "$ROOT/bin/golinks" update-from "$src"
  else
    cp -R "$src/." "$ROOT/"
  fi
  rm -rf "$tmp"
fi

# Zip extraction can drop execute bits; git and tar keep them. Fix either way.
chmod +x "$ROOT/bin/golinks" "$ROOT/install.sh" "$ROOT/uninstall.sh" 2>/dev/null || true

echo "Installing Golinks from $ROOT"
"$ROOT/bin/golinks" install
echo
echo "Opening the setup checklist in your browser."
PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/data/settings.json" 2>/dev/null | head -1)"
sleep 1
open "http://localhost:${PORT:-7777}/#/settings/setup"
cat <<MSG

Done. Next steps are on the setup page, in short:
  1. Add the "Go Links" site search in your browser (address bar go-links).
  2. Drag the bookmarklet to your bookmarks bar.
  3. Allow Screen Recording for node when asked (real screenshots of SSO pages).
  4. Import your bookmarks (optional).

Commands (from $ROOT, or from anywhere as ~/.golinks/bin/golinks):
  bin/golinks status | doctor | update | stop | start
  ./uninstall.sh [--purge]
MSG
