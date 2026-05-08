#!/usr/bin/env bash
set -euo pipefail

REPO="Quesillo27/resource-monitor"
VERSION="latest"
SERVER_URL=""
ENROLLMENT_TOKEN=""
AGENT_NAME=""
INTERVAL="60"
AGENT_URL=""
DOWNLOAD_URL_BASE=""
PROFILE="balanced"
SERVICES=""
CONFIG_PATH="/etc/resource-monitor-agent/config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="${2:-}"; shift 2 ;;
    --name) AGENT_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    --version) VERSION="${2:-latest}"; shift 2 ;;
    --agent-url) AGENT_URL="${2:-}"; shift 2 ;;
    --download-url) DOWNLOAD_URL_BASE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-balanced}"; shift 2 ;;
    --services) SERVICES="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo/root." >&2
  exit 1
fi
if [[ -z "$SERVER_URL" ]]; then
  echo "--server-url is required." >&2
  exit 1
fi
if [[ -z "$ENROLLMENT_TOKEN" && ! -f "$CONFIG_PATH" ]]; then
  echo "--enrollment-token is required for first install. Existing installs can update without a token." >&2
  exit 1
fi

ARCH="$(uname -m)"
OS="$(uname -s)"
case "$OS" in
  Darwin)
    case "$ARCH" in
      x86_64|amd64) ASSET="resource-monitor-agent-darwin-amd64" ;;
      arm64)        ASSET="resource-monitor-agent-darwin-arm64" ;;
      *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) ASSET="resource-monitor-agent-linux-amd64" ;;
      *) echo "Unsupported Linux architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

if [[ -n "$DOWNLOAD_URL_BASE" ]]; then
  BASE_URL="${DOWNLOAD_URL_BASE%/}"
elif [[ "$VERSION" == "latest" ]]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_BIN="$(mktemp)"
INSTALL_PATH="/usr/local/bin/resource-monitor-agent"
cleanup() { rm -f "$TMP_BIN"; }
trap cleanup EXIT

if [[ "$OS" == "Linux" ]]; then
  systemctl stop resource-monitor-agent 2>/dev/null || true
fi

DOWNLOAD_ASSET_URL="${BASE_URL}/${ASSET}"
if [[ -n "$AGENT_URL" ]]; then
  DOWNLOAD_ASSET_URL="$AGENT_URL"
fi
CHECKSUM_URL="${BASE_URL}/checksums.txt"

echo "Downloading ${DOWNLOAD_ASSET_URL}..."
if ! curl -fsSL "$DOWNLOAD_ASSET_URL" -o "$TMP_BIN"; then
  echo "Failed to download agent binary from ${DOWNLOAD_ASSET_URL}" >&2
  exit 1
fi

# Verify SHA256 checksum if available
if curl -fsSL "$CHECKSUM_URL" -o "${TMP_BIN}.checksums" 2>/dev/null; then
  EXPECTED=$(grep "${ASSET}$" "${TMP_BIN}.checksums" | awk '{print $1}')
  rm -f "${TMP_BIN}.checksums"
  if [[ -n "$EXPECTED" ]]; then
    ACTUAL=$(sha256sum "$TMP_BIN" | awk '{print $1}')
    if [[ "$EXPECTED" != "$ACTUAL" ]]; then
      echo "Checksum verification failed!" >&2
      echo "  Expected: $EXPECTED" >&2
      echo "  Got:      $ACTUAL" >&2
      exit 1
    fi
    echo "Checksum OK."
  fi
fi

install -m 0755 "$TMP_BIN" "$INSTALL_PATH"

ARGS=(install --server-url "$SERVER_URL" --interval "$INTERVAL" --profile "$PROFILE")
if [[ -n "$ENROLLMENT_TOKEN" ]]; then
  ARGS+=(--enrollment-token "$ENROLLMENT_TOKEN")
fi
if [[ -n "$AGENT_NAME" ]]; then
  ARGS+=(--name "$AGENT_NAME")
fi
if [[ -n "$SERVICES" ]]; then
  ARGS+=(--services "$SERVICES")
fi

echo "Installing or updating resource-monitor-agent..."
"$INSTALL_PATH" "${ARGS[@]}"

if [[ "$OS" == "Linux" ]]; then
  systemctl daemon-reload
  systemctl enable resource-monitor-agent
  systemctl restart resource-monitor-agent
fi

echo "Running agent doctor..."
"$INSTALL_PATH" doctor --config "$CONFIG_PATH"
if [[ "$OS" == "Linux" ]]; then
  systemctl --no-pager status resource-monitor-agent || true
fi
echo "Resource Monitor agent installation/update complete."
