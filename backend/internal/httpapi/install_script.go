package httpapi

import (
	"fmt"
	"net/http"
	"strings"
)

// installDBAgentScript sirve el script de instalacion one-shot que el modal
// del frontend muestra. El script detecta arch, descarga el binario del
// agente desde /downloads/ y lo registra como servicio systemd con --mode=db.
//
// El cliente lo invoca como:
//   curl -fsSL <server>/install-db-agent.sh | sudo bash -s -- \
//     --token=<TOKEN> --server=<SERVER> [--engine=postgres] [--data-dir=...] [--log-path=...]
//
// Mantenemos el script inline (no en disco) para evitar otro archivo en el
// container y para inyectar dinamicamente el server URL si hiciera falta.
func (s *Server) installDBAgentScript(w http.ResponseWriter, r *http.Request) {
	// Detectar server URL (lo que ve el cliente, no localhost del container)
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	defaultServer := fmt.Sprintf("%s://%s", scheme, host)

	script := strings.ReplaceAll(installScriptTmpl, "__DEFAULT_SERVER__", defaultServer)
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(script))
}

const installScriptTmpl = `#!/usr/bin/env bash
# resource-monitor — instalador del agente de BD (modo --mode=db)
# Vinculado a un db_target en el manager. No aparece en "Equipos".
set -euo pipefail

TOKEN=""
SERVER="__DEFAULT_SERVER__"
ENGINE=""
DATA_DIR=""
LOG_PATH=""
DB_DSN=""
INTERVAL="60"

while [ $# -gt 0 ]; do
  case "$1" in
    --token=*)     TOKEN="${1#*=}";;
    --token)       TOKEN="$2"; shift;;
    --server=*)    SERVER="${1#*=}";;
    --server)      SERVER="$2"; shift;;
    --engine=*)    ENGINE="${1#*=}";;
    --engine)      ENGINE="$2"; shift;;
    --data-dir=*)  DATA_DIR="${1#*=}";;
    --data-dir)    DATA_DIR="$2"; shift;;
    --log-path=*)  LOG_PATH="${1#*=}";;
    --log-path)    LOG_PATH="$2"; shift;;
    --db-dsn=*)    DB_DSN="${1#*=}";;
    --db-dsn)      DB_DSN="$2"; shift;;
    --interval=*)  INTERVAL="${1#*=}";;
    --interval)    INTERVAL="$2"; shift;;
    *)             echo "argumento desconocido: $1" >&2; exit 2;;
  esac
  shift
done

if [ -z "$TOKEN" ]; then
  echo "ERROR: --token es requerido (lo obtienes desde el modal 'Vincular host')" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: ejecutar como root (sudo bash)" >&2
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64)  GOARCH="amd64";;
  aarch64|arm64) GOARCH="arm64";;
  *) echo "ERROR: arquitectura no soportada: $ARCH" >&2; exit 1;;
esac

BIN_URL="$SERVER/downloads/resource-monitor-agent-linux-$GOARCH"
BIN_PATH="/usr/local/bin/resource-monitor-agent"
CONFIG_DIR="/etc/resource-monitor-agent"
CONFIG_PATH="$CONFIG_DIR/config.json"

echo ">> Descargando agente: $BIN_URL"
curl -fsSL "$BIN_URL" -o "$BIN_PATH.new"
chmod 755 "$BIN_PATH.new"
mv "$BIN_PATH.new" "$BIN_PATH"

mkdir -p "$CONFIG_DIR"

EXTRA_FLAGS=""
[ -n "$ENGINE" ]   && EXTRA_FLAGS="$EXTRA_FLAGS --engine=$ENGINE"
[ -n "$DATA_DIR" ] && EXTRA_FLAGS="$EXTRA_FLAGS --data-dir=$DATA_DIR"
[ -n "$LOG_PATH" ] && EXTRA_FLAGS="$EXTRA_FLAGS --log-path=$LOG_PATH"
[ -n "$DB_DSN" ]   && EXTRA_FLAGS="$EXTRA_FLAGS --db-dsn=$DB_DSN"

echo ">> Registrando contra $SERVER"
"$BIN_PATH" install \
  --mode=db \
  --server-url="$SERVER" \
  --enrollment-token="$TOKEN" \
  --interval="$INTERVAL" \
  --config="$CONFIG_PATH" \
  $EXTRA_FLAGS

echo ">> Listo. Estado del servicio:"
systemctl status resource-monitor-agent --no-pager || true

echo
echo "El agente reporta cada ${INTERVAL}s. Logs:"
echo "  journalctl -u resource-monitor-agent -f"
`
