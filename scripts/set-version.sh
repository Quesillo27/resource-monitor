#!/usr/bin/env bash
# Actualiza AGENT_RELEASE_VERSION en .env y rebuild de agent-assets + backend.
# Uso:
#   ./scripts/set-version.sh                    # auto: v1.0.0-<git-short-sha>
#   ./scripts/set-version.sh v1.3.0             # versión explícita
#   ./scripts/set-version.sh v1.3.0 --no-build  # solo actualiza .env

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"

# Auto-detección del compose file (igual que redeploy.sh)
if [[ -z "${COMPOSE_FILE:-}" ]]; then
  if [[ -f "docker-compose.prod.yml" ]] && docker network inspect resource-monitor >/dev/null 2>&1; then
    COMPOSE_FILE="docker-compose.prod.yml"
  elif [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
  elif [[ -f "docker-compose.prod.yml" ]]; then
    COMPOSE_FILE="docker-compose.prod.yml"
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: no existe $ENV_FILE en $(pwd)" >&2
  exit 1
fi

VERSION="${1:-}"
SKIP_BUILD=0
[[ "${2:-}" == "--no-build" ]] && SKIP_BUILD=1

if [[ -z "$VERSION" ]]; then
  if git rev-parse --short HEAD >/dev/null 2>&1; then
    VERSION="v1.0.0-$(git rev-parse --short HEAD)"
  else
    VERSION="v1.0.0-$(date +%Y%m%d-%H%M%S)"
  fi
fi

if grep -q '^AGENT_RELEASE_VERSION=' "$ENV_FILE"; then
  sed -i.bak "s|^AGENT_RELEASE_VERSION=.*|AGENT_RELEASE_VERSION=$VERSION|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  echo "AGENT_RELEASE_VERSION=$VERSION" >> "$ENV_FILE"
fi

echo "✓ AGENT_RELEASE_VERSION=$VERSION en $ENV_FILE"

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo "→ --no-build: no se reconstruye agent-assets (recordá hacerlo manual)"
  exit 0
fi

if [[ -z "${COMPOSE_FILE:-}" ]] || [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: no encuentro un docker-compose válido — no puedo rebuildear" >&2
  exit 1
fi

echo "→ recompilando agent-assets y reiniciando backend..."
docker compose -f "$COMPOSE_FILE" stop agent-assets backend >/dev/null
docker compose -f "$COMPOSE_FILE" rm -f agent-assets >/dev/null
docker compose -f "$COMPOSE_FILE" up -d agent-assets backend

echo
echo "✓ listo. Versión nueva: $VERSION"
echo "  - el manager ya devuelve esta versión en /api/agent/version"
echo "  - los binarios nuevos en /downloads/ ya tienen esta versión inyectada"
echo "  - desde la consola web, click en '↑ actualizar' al lado de cada agente"
