#!/usr/bin/env bash
#
# Codeg Server installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/xintaofei/codeg/main/install.sh | bash -s -- --version v0.5.0
#

set -euo pipefail

REPO="xintaofei/codeg"
INSTALL_DIR="${CODEG_INSTALL_DIR:-/usr/local/bin}"
VERSION=""

# ── Parse arguments ──

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir)     INSTALL_DIR="$2"; shift 2 ;;
    --help)
      echo "Usage: install.sh [--version VERSION] [--dir INSTALL_DIR]"
      echo ""
      echo "Options:"
      echo "  --version   Version to install (e.g. v0.5.0). Default: latest"
      echo "  --dir       Installation directory. Default: /usr/local/bin"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Detect platform ──

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *)      echo "Error: unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64)  ARCH_SUFFIX="x64" ;;
  aarch64|arm64)  ARCH_SUFFIX="arm64" ;;
  *)              echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
esac

ARTIFACT="codeg-server-${PLATFORM}-${ARCH_SUFFIX}"

# ── Resolve version ──

if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  if [ -z "$VERSION" ]; then
    echo "Error: could not determine latest version"
    exit 1
  fi
fi

# ── Version detection — skip if already up to date ──

CURRENT_VERSION=""
EXISTING_BIN="${INSTALL_DIR}/codeg-server"

if [ -x "$EXISTING_BIN" ]; then
  # Run with timeout to handle old binaries that lack --version support
  # (old binaries would start the full server and hang)
  VER_TMP=$(mktemp)
  "$EXISTING_BIN" --version > "$VER_TMP" 2>/dev/null &
  VER_PID=$!
  ( sleep 3 && kill "$VER_PID" 2>/dev/null ) &
  VER_GUARD=$!
  wait "$VER_PID" 2>/dev/null || true
  kill "$VER_GUARD" 2>/dev/null || true
  wait "$VER_GUARD" 2>/dev/null || true
  CURRENT_VERSION=$(head -1 "$VER_TMP" 2>/dev/null | tr -d '[:space:]')
  rm -f "$VER_TMP"
fi

# Normalize: strip leading "v" for comparison
TARGET_VER="${VERSION#v}"

if [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$TARGET_VER" ]; then
  echo "codeg-server is already at version ${TARGET_VER}, nothing to do."
  exit 0
fi

if [ -n "$CURRENT_VERSION" ]; then
  echo "Upgrading codeg-server: ${CURRENT_VERSION} -> ${TARGET_VER}..."
else
  echo "Installing codeg-server ${VERSION} (${PLATFORM}/${ARCH_SUFFIX})..."
fi

# ── Stop running service before upgrade ──

RESTARTED_PIDS=""
if pgrep -x codeg-server >/dev/null 2>&1; then
  echo "Stopping running codeg-server process(es)..."
  RESTARTED_PIDS=$(pgrep -x codeg-server || true)
  if kill $RESTARTED_PIDS 2>/dev/null; then
    # Wait up to 10 seconds for graceful shutdown
    for i in $(seq 1 10); do
      if ! pgrep -x codeg-server >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    # Force kill if still running
    if pgrep -x codeg-server >/dev/null 2>&1; then
      echo "Force stopping codeg-server..."
      kill -9 $RESTARTED_PIDS 2>/dev/null || true
      sleep 1
    fi
  fi
  echo "codeg-server stopped."
fi

# ── Download and extract ──

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}.tar.gz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${DOWNLOAD_URL}..."
if ! curl -fSL --progress-bar -o "${TMP_DIR}/${ARTIFACT}.tar.gz" "$DOWNLOAD_URL"; then
  echo "Error: download failed. Check that version ${VERSION} exists and has a ${ARTIFACT} asset."
  exit 1
fi

echo "Extracting..."
tar xzf "${TMP_DIR}/${ARTIFACT}.tar.gz" -C "$TMP_DIR"

# ── Install binary ──

BINARY_SRC="${TMP_DIR}/${ARTIFACT}/codeg-server"
if [ ! -f "$BINARY_SRC" ]; then
  echo "Error: binary not found in archive"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
if [ -w "$INSTALL_DIR" ]; then
  cp "$BINARY_SRC" "${INSTALL_DIR}/codeg-server"
  chmod +x "${INSTALL_DIR}/codeg-server"
else
  echo "Need sudo to install to ${INSTALL_DIR}"
  sudo cp "$BINARY_SRC" "${INSTALL_DIR}/codeg-server"
  sudo chmod +x "${INSTALL_DIR}/codeg-server"
fi

# ── Install web assets ──

WEB_SRC="${TMP_DIR}/${ARTIFACT}/web"
WEB_DIR="${CODEG_WEB_DIR:-/usr/local/share/codeg/web}"

if [ -d "$WEB_SRC" ]; then
  echo "Installing web assets to ${WEB_DIR}..."
  if [ -w "$(dirname "$WEB_DIR")" ] 2>/dev/null; then
    mkdir -p "$WEB_DIR"
    cp -r "$WEB_SRC"/* "$WEB_DIR"/
  else
    sudo mkdir -p "$WEB_DIR"
    sudo cp -r "$WEB_SRC"/* "$WEB_DIR"/
  fi
fi

# ── Restart service if it was running ──

if [ -n "$RESTARTED_PIDS" ]; then
  echo ""
  echo "Note: codeg-server was stopped for the upgrade."
  echo "Please restart it manually to ensure your environment variables (CODEG_PORT, CODEG_TOKEN, etc.) are preserved:"
  echo "  CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
fi

# ── Done ──

echo ""
echo "codeg-server installed to ${INSTALL_DIR}/codeg-server"
INSTALLED_VER=$("${INSTALL_DIR}/codeg-server" --version 2>/dev/null || echo "${TARGET_VER}")
echo "Version: ${INSTALLED_VER}"
echo ""
echo "Quick start:"
echo "  CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "Or with custom settings:"
echo "  CODEG_PORT=3080 CODEG_TOKEN=your-secret CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "The auth token is printed to stderr on startup if not set via CODEG_TOKEN."
