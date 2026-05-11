#!/usr/bin/env bash
# Bump de versión por componente vía git tags. Manager y agente tienen ciclos
# de release independientes y se versionan con prefixes distintos:
#
#   Manager:  tags 'manager-vX.Y.Z'
#   Agente:   tags 'vX.Y.Z' (sin prefix)
#
# El versionado real se deriva en runtime:
#   - manager-updater.sh hace 'git describe --tags --match manager-v*' al
#     refrescar version-info.json (cada VERSION_CHECK_PERIOD segundos).
#   - agent-assets hace 'git describe --tags --match v* --exclude manager-v*'
#     al compilar los binarios.
#
# Uso:
#   ./scripts/set-version.sh manager v1.5.1
#   ./scripts/set-version.sh agent   v1.4.1
#   ./scripts/set-version.sh manager v1.5.1 --no-push   # crea tag local sin pushear
#
# Manager: además recrea el container manager-updater para que tome el tag
#          nuevo y dispare un rebuild en el siguiente trigger.
# Agente:  además recrea agent-assets para que recompile los binarios con el
#          prefix nuevo y los publique en /downloads.

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${COMPOSE_FILE:-}" ]]; then
  if [[ -f "docker-compose.prod.yml" ]] && docker network inspect resource-monitor >/dev/null 2>&1; then
    COMPOSE_FILE="docker-compose.prod.yml"
  elif [[ -f "docker-compose.yml" ]]; then
    COMPOSE_FILE="docker-compose.yml"
  elif [[ -f "docker-compose.prod.yml" ]]; then
    COMPOSE_FILE="docker-compose.prod.yml"
  fi
fi

usage() {
  echo "Uso: $0 <manager|agent> <vX.Y.Z> [--no-push]" >&2
  echo "  manager  -> crea tag 'manager-vX.Y.Z' (recrea manager-updater)" >&2
  echo "  agent    -> crea tag 'vX.Y.Z' (recrea agent-assets)" >&2
  exit 1
}

COMPONENT="${1:-}"
VERSION="${2:-}"
NO_PUSH=0
[[ "${3:-}" == "--no-push" ]] && NO_PUSH=1

[[ -z "$COMPONENT" || -z "$VERSION" ]] && usage

case "$COMPONENT" in
  manager) TAG_NAME="manager-$VERSION" ;;
  agent)   TAG_NAME="$VERSION" ;;
  *)       echo "ERROR: componente '$COMPONENT' no válido" >&2; usage ;;
esac

# Validar formato vX.Y.Z
if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  echo "ERROR: formato inválido '$VERSION'. Esperado: vX.Y.Z (ej: v1.5.1)." >&2
  exit 1
fi

# Crear tag (idempotente: si ya existe, abortar para no sobreescribir).
if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  echo "ERROR: el tag '$TAG_NAME' ya existe. Borralo con 'git tag -d $TAG_NAME' si querés rehacerlo." >&2
  exit 1
fi

git tag -a "$TAG_NAME" -m "Release $COMPONENT $VERSION"
echo "✓ tag git creado: $TAG_NAME"

if [[ "$NO_PUSH" -eq 0 ]]; then
  echo "→ pusheando tag al remoto..."
  git push origin "$TAG_NAME"
  echo "✓ tag pusheado"
else
  echo "→ --no-push: tag creado solo localmente"
fi

if [[ -z "${COMPOSE_FILE:-}" ]] || [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "ADVERTENCIA: no encuentro docker-compose válido — no reinicio servicios" >&2
  exit 0
fi

case "$COMPONENT" in
  manager)
    echo "→ refrescando version-info en manager-updater..."
    docker compose -p resource-monitor -f "$COMPOSE_FILE" restart manager-updater
    echo
    echo "✓ Manager $VERSION publicado. La UI mostrará el tag nuevo en ≤60s."
    echo "  Para aplicar el rebuild, clickeá 'Actualizar manager' en la UI."
    ;;
  agent)
    echo "→ recreando agent-assets para que recompile con el tag nuevo..."
    docker compose -p resource-monitor -f "$COMPOSE_FILE" up -d --force-recreate agent-assets
    echo
    echo "✓ Agente $VERSION en cola. agent-assets compilará en su próximo ciclo."
    echo "  Los agentes verán la versión nueva en su próximo heartbeat."
    ;;
esac
