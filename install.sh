#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

C_BOLD="\033[1m"
C_GREEN="\033[32m"
C_YELLOW="\033[33m"
C_RED="\033[31m"
C_RESET="\033[0m"

info()  { printf "%b→%b %s\n" "$C_BOLD" "$C_RESET" "$1"; }
ok()    { printf "%b✓%b %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf "%b!%b %s\n" "$C_YELLOW" "$C_RESET" "$1"; }
fail()  { printf "%b✗%b %s\n" "$C_RED"    "$C_RESET" "$1" >&2; exit 1; }

printf "\n%bresource-monitor — instalación%b\n\n" "$C_BOLD" "$C_RESET"

command -v docker >/dev/null 2>&1 \
  || fail "Docker no está instalado. Instálalo desde https://docs.docker.com/engine/install/"

docker compose version >/dev/null 2>&1 \
  || fail "docker compose plugin no disponible (necesita Docker Compose v2)."

if [ ! -f .env ]; then
  info "Generando .env con credenciales por defecto..."

  gen_hex() {
    local bytes="$1"
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex "$bytes"
    else
      head -c "$bytes" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
  }

  POSTGRES_PASSWORD=$(gen_hex 16)
  JWT_SECRET=$(gen_hex 32)

  cat > .env <<EOF
# Generado por install.sh — rota credenciales editando este archivo
# y reiniciando con: docker compose down && docker compose up -d
POSTGRES_DB=resource_monitor
POSTGRES_USER=monitor
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
JWT_SECRET=${JWT_SECRET}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin
SERVER_ADDR=:8080
RETENTION_DAYS=30
OFFLINE_AFTER_SECONDS=180
VITE_API_BASE_URL=
ALLOWED_ORIGINS=
AGENT_RELEASE_VERSION=v1.4.0
MANAGER_VERSION=v1.5.0
EOF
  ok ".env creado."
else
  info ".env ya existe — reutilizando configuración."
fi

info "Construyendo y levantando contenedores (1-3 min la primera vez)..."
docker compose up -d --build

printf "%b→%b Esperando a que el backend responda" "$C_BOLD" "$C_RESET"
backend_ready=0
for _ in $(seq 1 90); do
  if curl -sf http://localhost:8080/healthz >/dev/null 2>&1; then
    backend_ready=1
    break
  fi
  printf "."
  sleep 2
done
printf "\n"

if [ "$backend_ready" -ne 1 ]; then
  warn "El backend no respondió en 3 minutos. Revisa los logs:"
  printf "    docker compose logs backend --tail 50\n"
  exit 1
fi

ADMIN_USER=$(grep -E '^ADMIN_USERNAME=' .env | cut -d= -f2-)
ADMIN_PASS=$(grep -E '^ADMIN_PASSWORD=' .env | cut -d= -f2-)

printf "\n"
printf "%b═══════════════════════════════════════════════%b\n" "$C_GREEN" "$C_RESET"
printf "%b  resource-monitor está corriendo%b\n"               "$C_GREEN" "$C_RESET"
printf "%b═══════════════════════════════════════════════%b\n" "$C_GREEN" "$C_RESET"
printf "\n"
printf "  %bURL:%b      http://localhost:3000\n"  "$C_BOLD" "$C_RESET"
printf "  %bUsuario:%b  %s\n"                     "$C_BOLD" "$C_RESET" "$ADMIN_USER"
printf "  %bPassword:%b %s\n"                     "$C_BOLD" "$C_RESET" "$ADMIN_PASS"
printf "\n"
printf "  Para detener:   docker compose down\n"
printf "  Para logs:      docker compose logs -f backend\n"
printf "\n"
