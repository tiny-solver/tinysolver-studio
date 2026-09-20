#!/usr/bin/env bash
# Install or update Tinysolver Studio on an Apple Silicon Mac from the latest GitHub release.
#
#   curl -fsSL https://github.com/tiny-solver/tinysolver-studio/releases/latest/download/studio-install-macos.sh | bash
#   ... | bash -s -- --check          # compare installed vs latest, change nothing
#   ... | bash -s -- --tag studio-v0.31.0-20260921.1
#
# Fetched with curl, so macOS puts no quarantine flag on it and Gatekeeper stays quiet.
# The app is ad-hoc signed: after each update macOS may ask again for folder and
# local-network permission, because it sees a differently signed app.
set -euo pipefail

REPO="tiny-solver/tinysolver-studio"
ASSET="tinysolver-studio-desktop-darwin-arm64.tar.gz"
APP="/Applications/Tinysolver Studio.app"
STAMP="$HOME/.tinysolver-studio/installed-release"
MODE="install"; TAG=""
while [ $# -gt 0 ]; do case "$1" in
  --check) MODE="check"; shift;;
  --tag) TAG="${2:?--tag needs a value}"; shift 2;;
  *) echo "unknown argument: $1"; exit 2;;
esac; done

[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "✗ Apple Silicon macOS only"; exit 1; }

if [ -z "$TAG" ]; then
  # /releases/latest redirects to /releases/tag/<tag>; no API token or jq needed.
  TAG="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')"
fi
case "$TAG" in studio-v*) ;; *) echo "✗ no published release found (got: $TAG)"; exit 1;; esac
have="$(cat "$STAMP" 2>/dev/null || echo none)"
echo "installed: $have"
echo "latest:    $TAG"
[ "$MODE" = check ] && exit 0
[ "$have" = "$TAG" ] && [ -d "$APP" ] && { echo "✓ already up to date"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$REPO/releases/download/$TAG"
curl -fSL --progress-bar -o "$tmp/$ASSET" "$base/$ASSET"
curl -fsSL -o "$tmp/$ASSET.sha256" "$base/$ASSET.sha256"
(cd "$tmp" && shasum -a 256 -c "$ASSET.sha256")
tar -C "$tmp" -xzf "$tmp/$ASSET"
# Glob, never `ls`: with CLICOLOR_FORCE=1 (set on some of our Macs) `ls` emits
# ANSI colour codes even into a pipe, and the captured path stops resolving.
apps=("$tmp"/*.app)
[ -d "${apps[0]}" ] || { echo "✗ no .app inside $ASSET"; exit 1; }
new="${apps[0]}"
codesign --verify --deep --strict "$new"

if pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
  echo "· quitting the running app"
  osascript -e 'tell application "Tinysolver Studio" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 1; done
  pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1 && { echo "✗ the app is still running — quit it and run again"; exit 1; }
fi
rm -rf "$APP"
ditto "$new" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
mkdir -p "$(dirname "$STAMP")"; echo "$TAG" > "$STAMP"
echo "✓ installed $TAG → $APP"
echo "  open -a 'Tinysolver Studio'"
