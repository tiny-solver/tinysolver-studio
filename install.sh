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

echo "Installing codeg-server ${VERSION} (${PLATFORM}/${ARCH_SUFFIX})..."

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

# ── Done ──

echo ""
echo "codeg-server installed to ${INSTALL_DIR}/codeg-server"
echo ""
echo "Quick start:"
echo "  CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "Or with custom settings:"
echo "  CODEG_PORT=3080 CODEG_TOKEN=your-secret CODEG_STATIC_DIR=${WEB_DIR} codeg-server"
echo ""
echo "The auth token is printed to stderr on startup if not set via CODEG_TOKEN."
