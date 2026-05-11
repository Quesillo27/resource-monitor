#!/usr/bin/env bash
# Actualiza AGENT_RELEASE_VERSION (prefix SemVer) en .env y rebuild de
# agent-assets + backend. agent-assets concatena "<prefix>-<git-sha>" al
# compilar y publica el binario en /downloads/<prefix>-<sha>.
#
# Uso:
#   ./scripts/set-version.sh v1.3.0             # bump explícito (recomendado)
#   ./scripts/set-version.sh v1.3.0 --no-build  # solo actualiza .env, no recompila
#   ./scripts/set-version.sh                    # error: requiere argumento explícito

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
  echo "ERROR: pasá la versión explícita como argumento (ej: v1.3.0)." >&2
  echo "       El sha de git lo concatena agent-assets automáticamente." >&2
  exit 1
fi

# Validar formato vX.Y.Z (sin sha, agent-assets se encarga).
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "ERROR: formato inválido '$VERSION'. Esperado: vX.Y.Z (ej: v1.3.0)." >&2
  exit 1
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
