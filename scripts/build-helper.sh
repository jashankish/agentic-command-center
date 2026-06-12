#!/usr/bin/env bash
# Builds resources/bin/commit-summarizer from native/summarizer.swift.
#
# The helper links Apple's FoundationModels framework, which only ships with the
# macOS 26 SDK (Xcode 26+ or its Command Line Tools). When no installed
# toolchain has it, the build is skipped with a warning and the activity feed
# falls back to raw commit messages — dev and dist must never fail over this.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/summarizer.swift"
OUT_DIR="$ROOT/resources/bin"
OUT="$OUT_DIR/commit-summarizer"

# electron-builder's extraResources expects the directory even when we skip.
mkdir -p "$OUT_DIR"

[ "$(uname -s)" = "Darwin" ] || { echo "build-helper: not macOS, skipping"; exit 0; }
if [ -f "$OUT" ] && [ "$OUT" -nt "$SRC" ]; then
  echo "build-helper: up to date"
  exit 0
fi

dev="" # candidate DEVELOPER_DIR; empty = whatever xcode-select points at
run() { if [ -n "$dev" ]; then env DEVELOPER_DIR="$dev" "$@"; else "$@"; fi; }

try_build() {
  local sdkver sdkpath
  sdkver="$(run xcrun --sdk macosx --show-sdk-version 2>/dev/null)" || return 1
  case "$sdkver" in 2[6-9]*|[3-9][0-9]*) ;; *) return 1 ;; esac
  sdkpath="$(run xcrun --sdk macosx --show-sdk-path 2>/dev/null)" || return 1
  [ -d "$sdkpath/System/Library/Frameworks/FoundationModels.framework" ] || return 1
  # The compile is the real compatibility test: an old swiftc pointed at a new
  # SDK fails here and we move on to the next candidate toolchain.
  run xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 \
    -sdk "$sdkpath" -o "$OUT" "$SRC" || return 1
  codesign --force -s - "$OUT" || return 1
  echo "build-helper: built with SDK $sdkver (${dev:-active toolchain})"
}

# Candidates: explicit $DEVELOPER_DIR, the active toolchain, then any installed
# Xcode. Globbing (not ls) keeps paths with spaces ("Xcode 26.app") intact.
for dev in "${DEVELOPER_DIR:-}" "" /Applications/Xcode*.app; do
  [ "$dev" = "/Applications/Xcode*.app" ] && continue # glob didn't match
  if [ -n "$dev" ] && [ -d "$dev/Contents/Developer" ]; then dev="$dev/Contents/Developer"; fi
  if try_build; then exit 0; fi
done

echo "build-helper: WARNING — no toolchain with the macOS 26 SDK found."
echo "  Install Xcode 26+ (or its Command Line Tools) to enable on-device commit summaries."
echo "  Continuing without the helper; the activity feed will show raw commit messages."
exit 0
