#!/usr/bin/env bash
set -euo pipefail

REPO="Quesillo27/resource-monitor"
VERSION="latest"
SERVER_URL=""
ENROLLMENT_TOKEN=""
AGENT_NAME=""
INTERVAL="60"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --enrollment-token) ENROLLMENT_TOKEN="${2:-}"; shift 2 ;;
    --name) AGENT_NAME="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-60}"; shift 2 ;;
    --version) VERSION="${2:-latest}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo/root." >&2
  exit 1
fi
if [[ -z "$SERVER_URL" || -z "$ENROLLMENT_TOKEN" ]]; then
  echo "--server-url and --enrollment-token are required." >&2
  exit 1
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ASSET="resource-monitor-agent-linux-amd64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  BASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi

TMP_BIN="$(mktemp)"
INSTALL_PATH="/usr/local/bin/resource-monitor-agent"

systemctl stop resource-monitor-agent 2>/dev/null || true

echo "Downloading ${ASSET} from ${BASE_URL}..."
curl -fL "${BASE_URL}/${ASSET}" -o "$TMP_BIN"
install -m 0755 "$TMP_BIN" "$INSTALL_PATH"
rm -f "$TMP_BIN"

echo "Registering and installing resource-monitor-agent..."
"$INSTALL_PATH" install \
  --server-url "$SERVER_URL" \
  --enrollment-token "$ENROLLMENT_TOKEN" \
  --name "$AGENT_NAME" \
  --interval "$INTERVAL"

systemctl daemon-reload
systemctl enable resource-monitor-agent
systemctl restart resource-monitor-agent

echo "Running agent doctor..."
"$INSTALL_PATH" doctor --config /etc/resource-monitor-agent/config.json
systemctl --no-pager status resource-monitor-agent || true
echo "Resource Monitor agent installation complete."
