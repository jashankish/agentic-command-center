#!/usr/bin/env bash
#
# fix-dev-electron.sh — make the development Electron binary launchable again.
#
# Apple has revoked the notarization of some older Electron builds, so macOS
# kills the downloaded node_modules Electron.app on launch ("exited with signal
# SIGKILL") and may delete the bundle outright, which breaks `npm run dev`.
# Packaged releases aren't affected: scripts/adhoc-sign.cjs re-signs them.
# This does the same for the dev binary: re-download it if it's missing, clear
# its extended attributes, and give it a valid ad-hoc signature.
#
# Usage:  npm run fix:electron
set -euo pipefail
cd "$(dirname "$0")/.."

APP="node_modules/electron/dist/Electron.app"
if [[ ! -d node_modules/electron ]]; then
  echo "!! node_modules/electron is missing — run npm install first." >&2
  exit 1
fi

if [[ ! -x "$APP/Contents/MacOS/Electron" ]]; then
  echo "==> Electron binary missing — downloading it again"
  rm -f node_modules/electron/path.txt
  node node_modules/electron/install.js
fi

echo "==> Clearing extended attributes"
xattr -cr "$APP"
echo "==> Ad-hoc signing $APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "==> OK: $("$APP/Contents/MacOS/Electron" --version)"
