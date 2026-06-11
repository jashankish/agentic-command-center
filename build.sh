#!/usr/bin/env bash
#
# build.sh — rebuild the local Agentic Command Center .dmg, commit source changes, and
# optionally publish a GitHub release with the .dmg attached.
#
# Usage:
#   ./build.sh                       # build dmg + commit/push with an auto message
#   ./build.sh "my message"          # build dmg + commit/push with a custom message
#   ./build.sh --no-git              # build dmg only, skip the commit/push
#   ./build.sh --release             # build + commit/push + publish/update GitHub release
#   ./build.sh "msg" --release       # flags and a message can be combined, any order
#
set -euo pipefail
cd "$(dirname "$0")"

COMMIT=true
RELEASE=false
MESSAGE="Rebuild: $(date '+%Y-%m-%d %H:%M:%S')"
for arg in "$@"; do
  case "$arg" in
    --no-git) COMMIT=false ;;
    --release) RELEASE=true ;;
    *) MESSAGE="$arg" ;;
  esac
done

echo "==> Installing dependencies (if needed)"
if [[ ! -d node_modules ]]; then
  npm install
fi

echo "==> Building app + macOS .dmg"
npm run dist

DMG=$(ls -t dist/*.dmg 2>/dev/null | head -1 || true)
if [[ -z "$DMG" ]]; then
  echo "!! No .dmg was produced in dist/ — aborting." >&2
  exit 1
fi
echo "==> Built: $DMG"

if [[ "$COMMIT" == true ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "==> Committing source changes"
    git add -A
    git commit -m "$MESSAGE"
    git push
    echo "==> Pushed to $(git rev-parse --abbrev-ref HEAD)"
  else
    echo "==> No source changes to commit"
  fi
fi

if [[ "$RELEASE" == true ]]; then
  VERSION=$(node -p "require('./package.json').version")
  TAG="v$VERSION"
  echo "==> Publishing GitHub release $TAG"
  if gh release view "$TAG" >/dev/null 2>&1; then
    # Release exists — replace its .dmg asset in place.
    gh release upload "$TAG" "$DMG" --clobber
    echo "==> Updated existing release $TAG with $DMG"
  else
    gh release create "$TAG" "$DMG" \
      --title "Agentic Command Center $VERSION" \
      --notes "Automated release of Agentic Command Center $VERSION. Download the .dmg below and drag the app to Applications. First launch: the build is ad-hoc signed (not notarized), so double-click the app once, click Done, then System Settings → Privacy & Security → Open Anyway. Or clear the quarantine flag instead: xattr -dr com.apple.quarantine '/Applications/Agentic Command Center.app'"
    echo "==> Created release $TAG with $DMG"
  fi
fi

echo "==> Done. Open the app with:  open \"$DMG\""
