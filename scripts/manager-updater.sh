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

# CRITICO: el daemon docker resuelve mounts contra el HOST, no contra este
# container. Cuando hacemos 'docker compose up' desde aca, el cliente compose
# resuelve paths relativos ('./agent') contra el cwd del compose file, que para
# nosotros es /repo. Eso le pasa /repo/agent al daemon — que en el host
# probablemente esta vacio. Resultado: containers (sobre todo agent-assets)
# arrancan con mounts apuntando a directorios vacios, sin que se note.
#
# Solucion: descubrir el path REAL del host inspeccionando el mount /repo de
# este propio container, y pasar --project-directory <host_path> en cada
# llamada de docker compose. El cliente entonces resuelve paths relativos
# contra ese path absoluto del host, y los manda correctos al daemon.
HOST_REPO=""
if [ -f /.dockerenv ] || [ -n "${HOSTNAME:-}" ]; then
  HOST_REPO="$(docker inspect "$(hostname)" \
    --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || echo)"
fi
if [ -z "$HOST_REPO" ]; then
  echo "[updater] WARN: no pude detectar el path host del repo; uso /repo como fallback" >&2
  HOST_REPO="$REPO"
fi
echo "[updater] HOST_REPO=$HOST_REPO (paths relativos del compose se resuelven contra ese)"

# Symlink critico: el daemon docker espera bind mounts con paths del HOST
# (ej: /root/resource-monitor/agent). El cliente compose CLI, sin embargo,
# necesita leer archivos reales del contexto (build context, .env) y vive
# dentro del container manager-updater donde el repo esta en /repo. Sin un
# puente, el cliente busca /root/resource-monitor/backend para tar el build
# context, no lo encuentra (no existe en el FS del container), y falla con
# 'path not found'. Con este symlink, el path host resuelve transparente al
# repo montado en /repo y el cliente puede leer todos los archivos.
if [ "$HOST_REPO" != "$REPO" ] && [ ! -e "$HOST_REPO" ]; then
  mkdir -p "$(dirname "$HOST_REPO")" 2>/dev/null || true
  ln -sf "$REPO" "$HOST_REPO" 2>/dev/null && \
    echo "[updater] symlink creado: $HOST_REPO -> $REPO (para que el cliente compose lea contexto/.env)" || \
    echo "[updater] WARN: no pude crear symlink $HOST_REPO -> $REPO" >&2
fi

# Wrapper que invoca docker compose con --project-directory apuntando al path
# host. Reemplaza todas las llamadas anteriores 'cd $REPO && docker compose ...'.
dc() {
  docker compose --project-directory "$HOST_REPO" -p "$PROJECT_NAME" -f "$COMPOSE_FILE" "$@"
}

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
  if ! dc build backend 2>&1; then
    write_status "failed" "$FROM" "$TO" "build backend falló" "$STARTED"
    echo "[updater] FAIL build backend" >&2
    return 1
  fi

  write_status "building_frontend" "$FROM" "$TO" "" "$STARTED"
  if ! dc build frontend 2>&1; then
    write_status "failed" "$FROM" "$TO" "build frontend falló" "$STARTED"
    echo "[updater] FAIL build frontend" >&2
    return 1
  fi

  write_status "restarting" "$FROM" "$TO" "" "$STARTED"
  # 'up -d --force-recreate' garantiza que backend y frontend arranquen con
  # imagenes nuevas Y con configs/mounts frescos (importante si el compose
  # cambio entre versiones, o si los containers viejos quedaron con bind
  # mounts cruzados). MANAGER_BUILD_SHA expone al backend el sha real que
  # esta corriendo (vs. el HEAD del repo del updater, que pueden divergir
  # momentaneamente).
  if ! MANAGER_BUILD_SHA="$TO" dc up -d --force-recreate backend frontend 2>&1; then
    write_status "failed" "$FROM" "$TO" "compose up falló" "$STARTED"
    echo "[updater] FAIL compose up" >&2
    return 1
  fi

  # Siempre recrear agent-assets — recompila los 4 binarios (linux, windows,
  # darwin x2) con el SHA/tag mas reciente y los publica atomico en /downloads.
  # Se hace SIEMPRE (no solo si "agent/" cambio) porque:
  #  - Garantiza que la version "Latest" reportada quede sincronizada con el
  #    HEAD del repo aun en cambios menores que no tocan agent/ (ej: doc, infra).
  #  - Cura ambientes cuyo container venia con mounts obsoletos sin que el
  #    operador tenga que diagnosticarlo.
  # Es barato: el watcher interno se hubiera disparado igual al detectar el
  # SHA nuevo. El force-recreate solo asegura el arranque limpio.
  echo "[updater] recreando agent-assets para recompilar binarios del agente..."
  dc up -d --force-recreate agent-assets 2>&1 || \
    echo "[updater] WARN: no pude recrear agent-assets, su watcher interno intentara compilar" >&2

  write_status "done" "$FROM" "$TO" "" "$STARTED"
  echo "[updater] DONE $FROM -> $TO"

  CHANGED_FILES="$(cd "$REPO" && git diff --name-only "$FROM" "$TO" 2>/dev/null || echo)"

  # Si el propio script cambio en este pull, recrear el container manager-updater
  # para que cargue la version nueva. El docker compose mata este container y
  # arranca uno nuevo con el script actualizado. El status ya quedo en "done"
  # asi que la UI no ve el restart.
  if echo "$CHANGED_FILES" | grep -q "scripts/manager-updater.sh"; then
    echo "[updater] el script cambio, recreando manager-updater..."
    dc up -d --force-recreate manager-updater &
  fi
  return 0
}

# Hace 'git fetch' (no muta el working tree) y compara HEAD local vs remoto,
# escribe version-info.json para que la UI sepa si hay update disponible.
# Incluye "version" semántica del manager derivada de git tags (manager-v*).
update_version_info() {
  cd "$REPO" || return 0
  git fetch --quiet origin 2>/dev/null || true
  CURRENT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  LATEST="$(git rev-parse --short origin/main 2>/dev/null || git rev-parse --short origin/master 2>/dev/null || echo unknown)"
  BEHIND="$(git rev-list --count HEAD..origin/main 2>/dev/null || git rev-list --count HEAD..origin/master 2>/dev/null || echo 0)"
  VERSION="$(git describe --tags --abbrev=0 --match 'manager-v*' 2>/dev/null | sed 's/^manager-//' || echo v0.0.0)"
  AVAILABLE="false"
  [ "$CURRENT" != "$LATEST" ] && [ "$LATEST" != "unknown" ] && AVAILABLE="true"
  cat > "$VERSION_INFO.tmp" <<EOF
{"version":"$VERSION","current":"$CURRENT","latest":"$LATEST","behind":$BEHIND,"update_available":$AVAILABLE,"checked_at":"$(now)"}
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
