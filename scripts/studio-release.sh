#!/usr/bin/env bash
# Cut a Tinysolver Studio release from the work machine.
#
#   scripts/studio-release.sh            # tag HEAD of main, push the tag, print how to watch
#   scripts/studio-release.sh --check    # show what would be tagged, change nothing
#
# The tag is  studio-v<app version>-<YYYYMMDD>.<seq>  (app version = src-tauri/tauri.conf.json,
# which tracks upstream). Pushing it starts .github/workflows/studio-release.yml, which builds
# the macOS app and the server tarballs on GitHub-hosted runners and publishes a release.
#
# Only this one tag is pushed. Never `git push --tags` here: the upstream `v*` tags fetched
# from the `upstream` remote would start upstream's release.yml, which cannot succeed in this fork.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
MODE="${1:-}"

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "✗ not on main"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ working tree not clean"; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "✗ main differs from origin/main — push (or pull) first"; exit 1; }

ver="$(node -p 'require("./src-tauri/tauri.conf.json").version' 2>/dev/null || sed -n 's/^ *"version": *"\(.*\)",*/\1/p' src-tauri/tauri.conf.json | head -n1)"
day="$(date +%Y%m%d)"
seq=1
while git ls-remote --exit-code --tags origin "refs/tags/studio-v$ver-$day.$seq" >/dev/null 2>&1; do seq=$((seq+1)); done
tag="studio-v$ver-$day.$seq"

prev="$(git tag --list 'studio-v*' --sort=-creatordate | head -n1)"
echo "tag:    $tag"
echo "commit: $(git log -1 --format='%h %s')"
[ -z "$prev" ] || { echo "since $prev:"; git log --oneline "$prev..HEAD" | head -n 20; }
[ "$MODE" = "--check" ] && exit 0

git tag -a "$tag" -m "Tinysolver Studio $tag"
git push origin "refs/tags/$tag"
repo="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
echo
echo "building: https://github.com/$repo/actions/workflows/studio-release.yml"
echo "watch:    gh run watch -R $repo \$(gh run list -R $repo -w studio-release.yml -L1 --json databaseId -q '.[0].databaseId')"
echo "install (macOS, after it turns green): curl -fsSL https://github.com/$repo/releases/latest/download/studio-install-macos.sh | bash"
