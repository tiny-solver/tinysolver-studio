#!/usr/bin/env bash
# tinysolver-studio 서버 런처 — systemd --user(studio-server.service)가 exec 한다.
# deploy.sh 가 ~/.local/share/tinysolver-studio/launch.sh 로 복사한다.
#
# 유닛이 codeg-server 를 바로 띄우지 않는 이유: 로그인 셸을 안 읽어 PATH 가 비고,
# 부품(model_once · 에이전트)이 부르는 claude · codex 는 nvm 아래에 있다
# (my-devops scripts/codeg-launch.sh 와 같은 함정).

HOME_DIR="$HOME/.local/share/tinysolver-studio"
CONF="$HOME/.config/tinysolver-studio/server.env"

export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/sbin:/snap/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

# 업스트림 codeg 플릿 서버(:3080 · ~/.local/share/codeg)와 자리를 나눈다
export CODEG_PORT="${CODEG_PORT:-3180}"
export CODEG_HOST="${CODEG_HOST:-0.0.0.0}"
export CODEG_DATA_DIR="$HOME_DIR/data"
export CODEG_STATIC_DIR="$HOME_DIR/web"
export CODEG_MCP_BIN="$HOME_DIR/bin/codeg-mcp"
export CODEG_BRIDGE_PORTS="${CODEG_BRIDGE_PORTS:-off}"
export STUDIO_PROJECTS_DIR="${STUDIO_PROJECTS_DIR:-$HOME/tinysolver.me/studio-projects}"

# CODEG_TOKEN(필수) · STUDIO_PROJECT(기본 프로젝트) — deploy.sh 가 Vault 에서 받아 600 으로 둔다
if [ ! -r "$CONF" ]; then
  echo "studio-server: $CONF 없음 — deploy.sh 를 먼저" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$CONF"
set +a
[ -n "${CODEG_TOKEN:-}" ] || { echo "studio-server: CODEG_TOKEN 비어 있음" >&2; exit 1; }

mkdir -p "$CODEG_DATA_DIR" "$STUDIO_PROJECTS_DIR"
cd "$HOME" || exit 1

if [ -n "${STUDIO_LAUNCH_DRYRUN:-}" ]; then
  echo "PATH=$PATH"
  echo "port=$CODEG_PORT data=$CODEG_DATA_DIR projects=$STUDIO_PROJECTS_DIR default=${STUDIO_PROJECT:-}"
  for b in claude codex node git blender; do
    printf '  %-8s %s\n' "$b" "$(command -v "$b" || echo '— 없음')"
  done
  exit 0
fi

# --supervise 를 쓰지 않는다 — 자체 업데이트(업스트림 릴리스)를 받지 않고 deploy.sh 만 바꾼다. 재시작은 systemd 몫.
exec "$HOME_DIR/bin/codeg-server"
