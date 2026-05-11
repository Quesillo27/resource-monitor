#!/bin/sh
# manager-updater: vigila /triggers/update.requested y ejecuta git pull +
# rebuild + up de backend y frontend. Escribe estado en /triggers/status.json
# para que el manager UI haga polling.
#
# Diseño:
# - Corre como container dedicado (docker:cli + git) con socket Docker montado
#   y bind mount del repo. Sobrevive a la muerte del container backend cuando
#   se recrea durante el rebuild.
# - Lockfile para evitar updates concurrentes (rara pero defensivo).
# - status.json incluye sha "from"/"to" y mensaje de error si falla.

set -u

TRIGGER="/triggers/update.requested"
STATUS="/triggers/status.json"
VERSION_INFO="/triggers/version-info.json"
LOCK="/triggers/.lock"
REPO="/repo"
# Cada cuanto el updater hace 'git fetch' + actualiza version-info.json (segs).
VERSION_CHECK_PERIOD="${VERSION_CHECK_PERIOD:-60}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
# Forzar el project name para evitar que docker compose use el dirname de
# /repo (que generaria containers "repo-*" paralelos al stack original).
PROJECT_NAME="${PROJECT_NAME:-resource-monitor}"

# Asegurar git instalado (docker:cli base no lo trae).
if ! command -v git >/dev/null 2>&1; then
  apk add --no-cache git >/dev/null 2>&1 || {
    echo "[updater] ERROR: no pude instalar git" >&2
    exit 1
  }
fi

# /triggers debe ser escribible por el backend (uid 1000) para que pueda
# crear el archivo trigger. Sticky bit estilo /tmp para que cada proceso
# borre solo lo suyo.
chmod 1777 /triggers 2>/dev/null || true

# Estado inicial si no existe.
if [ ! -f "$STATUS" ]; then
  printf '%s\n' '{"state":"idle","from":null,"to":null,"error":null,"started_at":null,"updated_at":null}' > "$STATUS"
  chmod 666 "$STATUS" 2>/dev/null || true
fi

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Escribe status atómicamente. Args: state from to error.
write_status() {
  state="$1"; from="$2"; to="$3"; err="$4"
  started="$5"
  # null literal o string entre comillas
  fmt() { [ -z "$1" ] && echo null || printf '"%s"' "$1"; }
  cat > "$STATUS.tmp" <<EOF
{"state":"$state","from":$(fmt "$from"),"to":$(fmt "$to"),"error":$(fmt "$err"),"started_at":$(fmt "$started"),"updated_at":"$(now)"}
EOF
  mv -f "$STATUS.tmp" "$STATUS"
  chmod 666 "$STATUS" 2>/dev/null || true
}

run_update() {
  STARTED="$(now)"
  FROM="$(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"

  echo "[updater] $(now) START from=$FROM"
  write_status "pulling" "$FROM" "" "" "$STARTED"

  if ! (cd "$REPO" && git pull --ff-only 2>&1); then
    write_status "failed" "$FROM" "" "git pull falló" "$STARTED"
    echo "[updater] FAIL git pull" >&2
    return 1
  fi

  TO="$(cd "$REPO" && git rev-parse --short HEAD)"
  echo "[updater] pulled: $FROM -> $TO"

  write_status "building_backend" "$FROM" "$TO" "" "$STARTED"
  if ! (cd "$REPO" && docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" build backend 2>&1); then
    write_status "failed" "$FROM" "$TO" "build backend falló" "$STARTED"
    echo "[updater] FAIL build backend" >&2
    return 1
  fi

  write_status "building_frontend" "$FROM" "$TO" "" "$STARTED"
  if ! (cd "$REPO" && docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" build frontend 2>&1); then
    write_status "failed" "$FROM" "$TO" "build frontend falló" "$STARTED"
    echo "[updater] FAIL build frontend" >&2
    return 1
  fi

  write_status "restarting" "$FROM" "$TO" "" "$STARTED"
  # 'up -d' aplica las imágenes nuevas. El backend va a morir mientras este
  # script (que corre en otro container) sigue vivo.
  if ! (cd "$REPO" && docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" up -d backend frontend 2>&1); then
    write_status "failed" "$FROM" "$TO" "compose up falló" "$STARTED"
    echo "[updater] FAIL compose up" >&2
    return 1
  fi

  write_status "done" "$FROM" "$TO" "" "$STARTED"
  echo "[updater] DONE $FROM -> $TO"
  return 0
}

# Hace 'git fetch' (no muta el working tree) y compara HEAD local vs remoto,
# escribe version-info.json para que la UI sepa si hay update disponible.
update_version_info() {
  cd "$REPO" || return 0
  git fetch --quiet origin 2>/dev/null || true
  CURRENT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  LATEST="$(git rev-parse --short origin/main 2>/dev/null || git rev-parse --short origin/master 2>/dev/null || echo unknown)"
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || git rev-list --count HEAD..origin/master 2>/dev/null || echo 0)"
  AVAILABLE="false"
  [ "$CURRENT" != "$LATEST" ] && [ "$LATEST" != "unknown" ] && AVAILABLE="true"
  cat > "$VERSION_INFO.tmp" <<EOF
{"current":"$CURRENT","latest":"$LATEST","behind":$BEHIND,"update_available":$AVAILABLE,"checked_at":"$(now)"}
EOF
  mv -f "$VERSION_INFO.tmp" "$VERSION_INFO"
  chmod 666 "$VERSION_INFO" 2>/dev/null || true
}

# Inicial: dar info enseguida al arrancar.
update_version_info

echo "[updater] vigilando $TRIGGER (compose=$COMPOSE_FILE, version-check=${VERSION_CHECK_PERIOD}s)"

LAST_VERSION_CHECK=0
while true; do
  if [ -f "$TRIGGER" ]; then
    if mkdir "$LOCK" 2>/dev/null; then
      rm -f "$TRIGGER"
      run_update || true
      # Refrescar version-info inmediatamente después del update.
      update_version_info
      rmdir "$LOCK" 2>/dev/null || true
    else
      # Otro update en curso (no debería pasar). Borrar trigger igual para evitar
      # que se procese al terminar el actual con datos viejos.
      rm -f "$TRIGGER"
      echo "[updater] update ya en curso, ignorando trigger"
    fi
  fi
  # Periodicamente refrescar info de version (sin git pull, solo fetch).
  NOW_TS="$(date +%s)"
  if [ $((NOW_TS - LAST_VERSION_CHECK)) -ge "$VERSION_CHECK_PERIOD" ]; then
    update_version_info
    LAST_VERSION_CHECK="$NOW_TS"
  fi
  sleep 2
done
