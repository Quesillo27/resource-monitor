#!/usr/bin/env bash
# Bump de versión por componente. Manager y agente tienen ciclos de release
# independientes y se versionan por separado.
#
# Uso:
#   ./scripts/set-version.sh manager v1.5.1
#   ./scripts/set-version.sh agent   v1.4.1
#   ./scripts/set-version.sh agent   v1.4.1 --no-build
#
# Manager: solo actualiza MANAGER_VERSION en .env y reinicia backend.
# Agente:  actualiza AGENT_RELEASE_VERSION en .env y recrea agent-assets para
#          que recompile los binarios con el prefix nuevo.

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env"

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

usage() {
  echo "Uso: $0 <manager|agent> <vX.Y.Z> [--no-build]" >&2
  echo "  manager  -> bumpea MANAGER_VERSION (rebuild backend)" >&2
  echo "  agent    -> bumpea AGENT_RELEASE_VERSION (recrea agent-assets)" >&2
  exit 1
}

COMPONENT="${1:-}"
VERSION="${2:-}"
SKIP_BUILD=0
[[ "${3:-}" == "--no-build" ]] && SKIP_BUILD=1

[[ -z "$COMPONENT" || -z "$VERSION" ]] && usage

case "$COMPONENT" in
  manager) ENV_VAR="MANAGER_VERSION" ;;
  agent)   ENV_VAR="AGENT_RELEASE_VERSION" ;;
  *)       echo "ERROR: componente '$COMPONENT' no válido" >&2; usage ;;
esac

# Validar formato vX.Y.Z (sin sha; el sha lo agrega agent-assets/git al runtime).
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "ERROR: formato inválido '$VERSION'. Esperado: vX.Y.Z (ej: v1.5.0)." >&2
  exit 1
fi

if grep -q "^${ENV_VAR}=" "$ENV_FILE"; then
  sed -i.bak "s|^${ENV_VAR}=.*|${ENV_VAR}=$VERSION|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
else
  echo "${ENV_VAR}=$VERSION" >> "$ENV_FILE"
fi
echo "✓ ${ENV_VAR}=$VERSION en $ENV_FILE"

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  echo "→ --no-build: no se reinicia ningún servicio (recordá hacerlo manual)"
  exit 0
fi

if [[ -z "${COMPOSE_FILE:-}" ]] || [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ERROR: no encuentro un docker-compose válido — no puedo reiniciar" >&2
  exit 1
fi

case "$COMPONENT" in
  manager)
    echo "→ reiniciando backend para que tome la nueva MANAGER_VERSION..."
    docker compose -p resource-monitor -f "$COMPOSE_FILE" up -d backend
    echo
    echo "✓ Manager $VERSION activo. Verificar: curl /api/manager/version"
    ;;
  agent)
    echo "→ recreando agent-assets para que recompile los binarios..."
    docker compose -p resource-monitor -f "$COMPOSE_FILE" up -d --force-recreate agent-assets
    echo
    echo "✓ Agente $VERSION en cola. agent-assets compilará en su próximo ciclo."
    echo "  Verificar: curl https://monitor.toolscode.cloud/downloads/version.txt"
    ;;
esac
