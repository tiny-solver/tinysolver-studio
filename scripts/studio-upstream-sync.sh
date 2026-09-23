#!/usr/bin/env bash
# 업스트림 codeg 의 새 태그를 이 fork 로 가져온다 — 감지 → 머지 시도 → PR → 알림.
#
#   scripts/studio-upstream-sync.sh            # 실행 (cron 이 이걸 부른다)
#   scripts/studio-upstream-sync.sh --check    # 무엇을 할지만 보고 아무것도 바꾸지 않는다
#
# main 을 자동으로 옮기지 않는다. 브랜치 + PR 까지만 만들고 land 는 사람이 한다 —
# 브랜드를 갈아 놓은 fork 라 업스트림이 같은 문자열을 건드리면 판단이 필요하고,
# 깨끗한 머지여도 새 UI 문자열이 "Codeg" 로 들어올 수 있다(그걸 아래 브랜드 불변식이 잡는다).
#
# 머지는 **별도 worktree** 에서 한다 — 이 체크아웃은 오너가 쓰는 작업 트리다. 건드리지 않는다.
# worktree 는 ~/.cache 아래라 ~/.gitconfig 의 경로 규칙(includeIf)이 안 걸린다.
# 그래서 신원·ssh 키를 git -c 로 명시해 넘긴다 — 안 그러면 choigawoon 으로 커밋되고 push 도 막힌다.
#
# 검사는 로컬에서 안 돌린다. PR 을 열면 저장소의 Test 워크플로가 전부 돌린다(작업 머신 시간 0).
# 배경: docs/plans/tinysolver/studio-release.md
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
REPO_DIR="$PWD"
MODE="${1:-}"
WT_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/tinysolver-studio-upstream"
NOTIFY="$HOME/k-codepoet/my-devops/scripts/notify.sh"
TOPIC="tinysolver.studio.upstream"
# 우리가 전부 우리 이름으로 갈아 놓은 문자열(업스트림 제품명 + Studio).
# 붙여서 적지 않고 조각으로 둔다 — 붙여 적으면 아래 git grep 이 **이 스크립트 자신**을
# 잡아 "브랜드 되돌림"으로 오판한다 (CLAUDE.md 의 `pkill -f` 자기매치와 같은 함정,
# 첫 실행에서 실제로 밟았다).
BRAND_UP="Codeg"
NEEDLE="$BRAND_UP Studio"

say() { printf '%s\n' "$*"; }
notify() { # notify <level> <title> <body>
  if [ -x "$NOTIFY" ]; then printf '%s' "$3" | "$NOTIFY" --level "$1" "$TOPIC" "$2" || say "(알림 실패)"
  else say "(notify.sh 없음) [$1] $2 — $3"; fi
}

# ── 1. 이 체크아웃은 읽기만 한다 ─────────────────────────────
git fetch -q origin
git fetch -q upstream --tags
base="origin/main"

# ── 2. 최신 업스트림 태그, 이미 들어와 있으면 끝 ─────────────
tag="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
[ -n "$tag" ] || { say "업스트림 태그가 없다"; exit 1; }
if git merge-base --is-ancestor "$tag" "$base" 2>/dev/null; then
  say "최신 $tag 는 이미 main 에 들어와 있다 — 할 일 없음"; exit 0
fi

branch="upstream-sync/$tag"
say "업스트림 최신: $tag (main 에 없음)"
say "커밋 수: $(git rev-list --count "$base..$tag") · 바뀐 파일: $(git diff --name-only "$base...$tag" | wc -l | tr -d ' ')"

# ── 3. 이미 대기 중이면 또 만들지 않는다 (매일 도는 잡이라 중복·스팸 방지) ──
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  say "이미 대기 중: $branch — 그걸 처리하면 다음 회차에 다음 태그로 넘어간다"; exit 0
fi
[ "$MODE" = "--check" ] && { say "(--check) 여기서 멈춘다. 실제로는 $branch 를 만들어 머지하고 PR 을 연다"; exit 0; }

# ── 4. 신원·키를 명시해 별도 worktree 에서 머지 ───────────────
IDENT=(-c "user.name=$(git config user.name)" -c "user.email=$(git config user.email)")
ssh_cmd="$(git config --get core.sshCommand || true)"
[ -z "$ssh_cmd" ] || IDENT+=(-c "core.sshCommand=$ssh_cmd")
[ "$(git config user.email)" = "iam.tinysolver@gmail.com" ] || { say "✗ 신원이 tinysolver 가 아니다: $(git config user.email)"; exit 1; }

wt="$WT_ROOT/$tag"
rm -rf "$wt"; mkdir -p "$WT_ROOT"
git branch -D "$branch" 2>/dev/null || true
git worktree prune
git worktree add -q -B "$branch" "$wt" "$base"
cleanup() { cd "$REPO_DIR"; git worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; git worktree prune; }

merge_msg="Merge upstream $tag

업스트림 codeg $tag 를 가져온다. scripts/studio-upstream-sync.sh 가 자동으로 만든 머지다 —
검사는 이 PR 의 Test 워크플로가 돌린다. 브랜드 불변식(업스트림 제품명 잔존 0)은 통과한 상태."

if ! git -C "$wt" "${IDENT[@]}" merge --no-edit -m "$merge_msg" "$tag" >/dev/null 2>&1; then
  conflicts="$(git -C "$wt" diff --name-only --diff-filter=U)"

  # 매 릴리스마다 똑같이 나는 충돌 하나는 스스로 푼다 —
  # tauri.conf.json 은 우리가 고친 productName(3행)·identifier(5행) 사이에 업스트림이
  # 매번 올리는 version(4행)이 끼어 있어 항상 부딪힌다. 해소는 늘 같다: 우리 것 + 업스트림 버전.
  # `--theirs` 로 파일째 받으면 안 된다 — 이 파일에는 브랜드 말고도 지켜야 할 게 있다:
  # updater endpoints [] (업스트림 릴리스로 자동 업데이트되는 것을 막는다) · deep-link schemes []
  # (codeg:// 를 빼앗지 않는다) · devUrl 3100 · createUpdaterArtifacts false.
  if [ "$conflicts" = "src-tauri/tauri.conf.json" ]; then
    up_ver="$(git -C "$wt" show "$tag:src-tauri/tauri.conf.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
    git -C "$wt" checkout --ours -- src-tauri/tauri.conf.json
    python3 - "$wt/src-tauri/tauri.conf.json" "$up_ver" <<'PY'
import json, re, sys
path, ver = sys.argv[1], sys.argv[2]
s = open(path).read()
s2, n = re.subn(r'^(\s*"version":\s*")[^"]*(")', lambda m: m.group(1) + ver + m.group(2), s, count=1, flags=re.M)
assert n == 1, "version 줄을 못 찾았다"
json.loads(s2)                                  # 형식이 깨졌으면 여기서 멈춘다
open(path, "w").write(s2)
PY
    git -C "$wt" add src-tauri/tauri.conf.json
    git -C "$wt" "${IDENT[@]}" commit -q --no-edit -m "$merge_msg

tauri.conf.json 충돌은 스스로 풀었다 — version 만 업스트림($up_ver), 나머지는 우리 것
(productName · identifier · updater endpoints [] · deep-link schemes [] · devUrl 3100)."
    say "tauri.conf.json 충돌 자동 해소 (version → $up_ver)"
    conflicts=""
  fi
fi

if [ -n "${conflicts:-}" ]; then
  conflicts="$(printf '%s' "$conflicts" | head -n 40)"
  git -C "$wt" merge --abort 2>/dev/null || true
  cleanup; git branch -D "$branch" 2>/dev/null || true
  notify warning "studio: 업스트림 $tag 머지 충돌" "$(printf '충돌 파일:\n%s\n\n손으로:\n  cd ~/tinysolver.me/tinysolver-studio\n  git fetch upstream --tags\n  git switch -c %s origin/main && git merge %s' "$conflicts" "$branch" "$tag")"
  say "충돌 — 알림 보냄, 아무것도 남기지 않았다"; exit 0
fi

# ── 5. 브랜드 불변식: 우리 이름을 되돌리거나 새 Codeg 문자열을 들여왔는지 ──
# 문서·생성 HTML 은 지난 기록(이름을 바꾸기 전)이라 제외한다.
drift="$(git -C "$wt" grep -n "$NEEDLE" -- . ':!docs' ':!public' 2>/dev/null | head -n 20 || true)"
bad=""
[ -n "$drift" ] && bad="되돌아온 업스트림 제품명:\n$drift\n"
for pair in \
  'src-tauri/src/brand.rs:Tinysolver Studio' \
  'src-tauri/src/brand.rs:me.tinysolver.studio' \
  'src-tauri/tauri.conf.json:me.tinysolver.studio' \
  'package.json:"name": "tinysolver-studio"'; do
  f="${pair%%:*}"; want="${pair#*:}"
  grep -qF "$want" "$wt/$f" || bad="$bad사라진 불변식: $f 에 '$want' 없음\n"
done
if [ -n "$bad" ]; then
  cleanup; git branch -D "$branch" 2>/dev/null || true
  notify warning "studio: 업스트림 $tag — 브랜드 되돌림 감지" "$(printf "$bad\n머지는 깨끗했지만 이름이 어긋난다. 손으로 머지하고 이름을 다시 맞춘다:\n  git switch -c %s origin/main && git merge %s" "$branch" "$tag")"
  say "브랜드 어긋남 — 알림 보냄, 아무것도 남기지 않았다"; exit 0
fi

# ── 6. 브랜치 push → PR (검사는 PR 의 Test 워크플로가 돈다) ───
git -C "$wt" "${IDENT[@]}" push -q -u origin "$branch"
cleanup

pr=""
if GH_TOKEN="$(gh auth token -u tiny-solver 2>/dev/null)" && [ -n "${GH_TOKEN:-}" ]; then
  export GH_TOKEN
  pr="$(gh pr create -R tiny-solver/tinysolver-studio --base main --head "$branch" \
        --title "Merge upstream $tag" \
        --body "$(printf '업스트림 codeg **%s** 자동 머지 (scripts/studio-upstream-sync.sh).\n\n- 충돌 없음 · 브랜드 불변식 통과(업스트림 제품명 잔존 0 · brand.rs · tauri.conf · package.json)\n- 검사는 이 PR 의 Test 워크플로가 돌린다\n- 초록이면 land, 그 뒤 릴리스는 `scripts/studio-release.sh`\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)' "$tag")" 2>&1 | tail -n1)" || pr="PR 생성 실패: $pr"
fi

notify info "studio: 업스트림 $tag 머지 준비됨" "$(printf '충돌 없음 · 브랜드 불변식 통과\n%s\n\nland (squash 금지 — 업스트림 조상을 지켜야 다음 머지가 안 깨진다):\n  git switch main && git merge --ff-only %s && git push && git branch -d %s && git push origin --delete %s\n그 뒤 릴리스: scripts/studio-release.sh' "${pr:-브랜치 $branch}" "$branch" "$branch" "$branch")"
say "준비됨: $branch ${pr:+· $pr}"
