#!/bin/bash
# Remove Golinks from this Mac.
#   ./uninstall.sh            stop and remove the login agents, menu bar icon and ~/.golinks link; keep your data
#   ./uninstall.sh --purge    also delete your links, snapshots, settings, logs and backups (asks first)
#   ./uninstall.sh --purge --yes    no questions
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=0; YES=0
for a in "$@"; do case "$a" in --purge) PURGE=1 ;; --yes|-y) YES=1 ;; *) echo "unknown option: $a"; exit 1 ;; esac; done

LINKS_HOME="${LINKS_HOME:-$ROOT}"
DOMAIN="gui/$(id -u)"

echo "Uninstalling Golinks from $ROOT"

# 1. Ask the service to quit cleanly, then remove agents, plists and links (data untouched).
if [ -x "$ROOT/bin/golinks" ]; then
  "$ROOT/bin/golinks" uninstall || true
else
  for l in dev.golinks dev.golinks.menubar; do
    launchctl bootout "$DOMAIN/$l" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$l.plist"
  done
  [ -L "$HOME/.golinks" ] && rm -f "$HOME/.golinks"
fi
rm -f "$ROOT/bin/node"

# 2. Make sure nothing from this folder is still running.
pkill -f "$ROOT/server.js" 2>/dev/null || true
pkill -f "$ROOT/menubar/menubar.js" 2>/dev/null || true

# 3. Optionally remove personal data.
if [ "$PURGE" = 1 ]; then
  echo
  echo "This will permanently delete:"
  echo "  $LINKS_HOME/data       (links, settings, rules, templates, backups)"
  echo "  $LINKS_HOME/snapshots  (thumbnails)"
  echo "  $ROOT/logs"
  if [ "$YES" != 1 ]; then
    read -r -p "Type DELETE to confirm: " answer
    [ "$answer" = "DELETE" ] || { echo "kept your data"; PURGE=0; }
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$LINKS_HOME/data" "$LINKS_HOME/snapshots" "$ROOT/logs"
    echo "data deleted"
  fi
else
  echo "Your data is untouched in $LINKS_HOME/data and $LINKS_HOME/snapshots (use --purge to delete it)."
fi

cat <<MSG

Golinks is uninstalled. Things macOS and your browser keep, remove by hand if you want:
  - Browser site search "Go Links" (chrome://settings/searchEngines or brave://settings/searchEngines)
  - The "Add to Golinks" bookmarklet on your bookmarks bar
  - The two Shortcuts (Links: search, Links: add current tab) in the Shortcuts app
  - Permissions granted to "node" and "osascript" under System Settings > Privacy & Security
    (Automation, Screen Recording); harmless to leave in place
  - This folder: rm -rf "$ROOT"
MSG
