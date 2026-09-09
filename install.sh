#!/bin/bash
# One-step install for Golinks. Run from the cloned folder: ./install.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$(uname)" != "Darwin" ]; then echo "Golinks runs on macOS only."; exit 1; fi
echo "Installing Golinks from $ROOT"
"$ROOT/bin/golinks" install
echo
echo "Opening the setup checklist in your browser."
PORT="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$ROOT/data/settings.json" 2>/dev/null | head -1)"
sleep 1
open "http://localhost:${PORT:-7777}/#/settings/setup"
cat <<MSG

Done. Next steps are on the setup page, in short:
  1. Add the "go" site search in your browser (address bar go-links).
  2. Drag the bookmarklet to your bookmarks bar.
  3. Allow Screen Recording for node when asked (real screenshots of SSO pages).
  4. Import your bookmarks (optional).

Commands: bin/golinks status | doctor | update | stop | start | uninstall
MSG
