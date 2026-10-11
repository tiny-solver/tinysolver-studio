#!/usr/bin/env bash
# tinysolver-studio 서버 모드 배포 — linux-1 에서, 이 repo 의 main 체크아웃으로.
#
#   deploy/studio-server/deploy.sh            # main 을 빌드 → 설치 → 다시 띄움 → 확인
#   deploy/studio-server/deploy.sh --check    # 지금 도는 것만 확인 (어긋나면 exit 1)
#
# 태그를 붙이지 않는다 — 이 repo 의 v*.*.* 태그는 앱 릴리스(업스트림 release.yml)의 것이라
# stage.sh 처럼 CalVer 태그를 붙이면 앱 빌드가 같이 돈다(decide bo-home 근거).
# 무엇이 도는지는 ~/.local/share/tinysolver-studio/deployed.json(커밋 · 시각)이 정본이다.
#
# 토큰: Vault secret/tinysolver/studio/server 의 TOKEN (없으면 만들어 넣는다)
#       → ~/.config/tinysolver-studio/server.env (600). 값은 화면 · 로그에 찍지 않는다.
# 길: studio.home.tinysolver.me → mac-mini-2 TLS → … → linux-1 Traefik(file 라우터) → :3180
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOME_DIR="$HOME/.local/share/tinysolver-studio"
CONF_DIR="$HOME/.config/tinysolver-studio"
CONF="$CONF_DIR/server.env"
UNIT="studio-server"
PORT="${CODEG_PORT:-3180}"
VAULT_PATH="secret/tinysolver/studio/server"
export VAULT_ADDR="${VAULT_ADDR:-http://192.168.0.42:28200}"

say() { printf '  %-14s %s\n' "$1" "$2"; }
die() { echo "deploy: $*" >&2; exit 1; }

health() {
  local token
  token="$(sed -n 's/^CODEG_TOKEN=//p' "$CONF")"
  curl -fsS -m 5 -X POST -H "Authorization: Bearer $token" "http://127.0.0.1:$PORT/api/health" 2>/dev/null
}

check() {
  local fail=0
  if systemctl --user is-active --quiet "$UNIT"; then say "유닛" "active"; else say "유닛" "멈춤"; fail=1; fi
  if [ -f "$HOME_DIR/deployed.json" ]; then say "배포" "$(tr -d '\n' < "$HOME_DIR/deployed.json")"; else say "배포" "없음"; fail=1; fi
  if out="$(health)"; then say "health" "$out"; else say "health" "응답 없음 (:$PORT)"; fail=1; fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 https://studio.home.tinysolver.me/api/health -X POST || true)"
  say "도메인" "https://studio.home.tinysolver.me → $code (401 이면 길은 열림 · 토큰 필요)"
  [ "$code" = "401" ] || [ "$code" = "200" ] || fail=1
  return $fail
}

if [ "${1:-}" = "--check" ]; then
  check
  exit $?
fi

# ── 1. 소스: main · 깨끗 · origin 과 같음 ──
cd "$REPO"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "main 에서만 배포한다 (지금 $(git rev-parse --abbrev-ref HEAD))"
git fetch -q origin main
[ -z "$(git status --porcelain)" ] || die "작업 트리가 깨끗하지 않다"
git merge --ff-only -q origin/main
COMMIT="$(git rev-parse --short HEAD)"
say "커밋" "$COMMIT $(git log -1 --format=%s | cut -c1-60)"

# ── 2. 토큰: Vault → server.env ──
mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
command -v vault >/dev/null || die "vault CLI 없음"
TOKEN="$(vault kv get -field=TOKEN "$VAULT_PATH" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 32)"
  vault kv put -mount=secret tinysolver/studio/server TOKEN="$TOKEN" >/dev/null
  say "토큰" "Vault $VAULT_PATH 에 새로 만듦"
else
  say "토큰" "Vault $VAULT_PATH"
fi
DEFAULT_PROJECT="$(sed -n 's/^STUDIO_PROJECT=//p' "$CONF" 2>/dev/null || true)"
umask 077
{
  echo "CODEG_TOKEN=$TOKEN"
  [ -n "$DEFAULT_PROJECT" ] && echo "STUDIO_PROJECT=$DEFAULT_PROJECT"
} > "$CONF.tmp"
mv "$CONF.tmp" "$CONF"
umask 022
unset TOKEN

# ── 3. 빌드 ──
say "웹" "pnpm build"
pnpm install --frozen-lockfile --silent >/dev/null
pnpm build >/dev/null
say "서버" "cargo build --release"
BINS=(codeg-server codeg-mcp)
grep -q '^name = "studio"' src-tauri/Cargo.toml && BINS+=(studio)
args=(); for b in "${BINS[@]}"; do args+=(--bin "$b"); done
(cd src-tauri && cargo build --release --no-default-features "${args[@]}" -q)

# ── 4. 설치 — 새 자리를 다 채운 뒤 한 번에 바꾼다 ──
NEXT="$HOME_DIR/.next"
rm -rf "$NEXT"; mkdir -p "$NEXT/bin"
for b in "${BINS[@]}"; do cp "src-tauri/target/release/$b" "$NEXT/bin/"; done
cp -r out "$NEXT/web"
mkdir -p "$HOME_DIR"
cp deploy/studio-server/launch.sh "$HOME_DIR/launch.sh"
for d in bin web; do rm -rf "$HOME_DIR/$d.old"; [ -e "$HOME_DIR/$d" ] && mv "$HOME_DIR/$d" "$HOME_DIR/$d.old"; mv "$NEXT/$d" "$HOME_DIR/$d"; done
rm -rf "$NEXT"
printf '{"commit":"%s","at":"%s"}\n' "$COMMIT" "$(date -Iseconds)" > "$HOME_DIR/deployed.json"
[ -e "$HOME/.local/bin/studio" ] || [ ! -x "$HOME_DIR/bin/studio" ] || ln -s "$HOME_DIR/bin/studio" "$HOME/.local/bin/studio"

# ── 5. 다시 띄움 ──
mkdir -p "$HOME/.config/systemd/user"
cp deploy/studio-server/studio-server.service "$HOME/.config/systemd/user/$UNIT.service"
systemctl --user daemon-reload
systemctl --user enable -q "$UNIT"
systemctl --user restart "$UNIT"
for _ in $(seq 1 30); do health >/dev/null && break; sleep 1; done

check
