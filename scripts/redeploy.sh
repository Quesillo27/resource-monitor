#!/usr/bin/env bash
# Redeploy completo del manager con bump automático de versión.
# Uso:
#   ./scripts/redeploy.sh                # versión auto: v1.0.0-<git-sha>
#   ./scripts/redeploy.sh v1.3.0         # versión explícita
#
# Hace:
#   1. Actualiza AGENT_RELEASE_VERSION en .env (auto desde git SHA si no se pasa)
#   2. Rebuild de backend, frontend y agent-assets
#   3. Verifica que el manager devuelva la versión nueva en /api/agent/version

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"

# Auto-detección del compose file:
#   1. Si COMPOSE_FILE está seteado en el entorno, se respeta
#   2. Si docker-compose.prod.yml existe Y la red externa "resource-monitor" existe → usar prod
#   3. En cualquier otro caso → usar docker-compose.yml (standalone / dev)
if [[ -z "${COMPOSE_FILE:-}" ]]; then
  if [[ -f "docker-compose.prod.yml" ]] && docker network inspect resource-monitor >/dev/null 2>&1; then
    COMPOSE_FILE="docker-compose.prod.yml"
  elif [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
  elif [[ -f "docker-compose.prod.yml" ]]; then
    COMPOSE_FILE="docker-compose.prod.yml"
  else
    echo "ERROR: no encuentro docker-compose.yml ni docker-compose.prod.yml en $(pwd)" >&2
    exit 1
  fi
fi

echo "==> Usando $COMPOSE_FILE"

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  if git rev-parse --short HEAD >/dev/null 2>&1; then
    VERSION="v1.0.0-$(git rev-parse --short HEAD)"
  else
    VERSION="v1.0.0-$(date +%Y%m%d-%H%M%S)"
  fi
fi

echo "==> Bump de versión a $VERSION"
./scripts/set-version.sh "$VERSION" --no-build

echo "==> Rebuild de backend, frontend y agent-assets"
docker compose -f "$COMPOSE_FILE" stop agent-assets backend frontend >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" rm -f agent-assets >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate backend frontend
docker compose -f "$COMPOSE_FILE" up -d agent-assets

echo "==> Esperando que agent-assets termine de compilar binarios..."
for i in {1..60}; do
  state=$(docker compose -f "$COMPOSE_FILE" ps --format json agent-assets 2>/dev/null | grep -o '"State":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
  if [[ "$state" == "exited" ]]; then
    echo "    ✓ agent-assets compiló y salió"
    break
  fi
  sleep 2
done

echo "==> Verificando que el manager reporte la versión nueva..."
sleep 3
for port in 8080 80; do
  if curl -fs "http://localhost:$port/api/agent/version" >/dev/null 2>&1; then
    response=$(curl -fs "http://localhost:$port/api/agent/version")
    echo "    GET /api/agent/version → $response"
    break
  fi
done

echo
echo "✓ Redeploy completo. Versión activa: $VERSION"
echo "  Para actualizar agentes existentes: consola web → tabla equipos → '↑ actualizar'"
