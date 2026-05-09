# Resource Monitor

Plataforma de monitoreo de recursos para equipos **Linux, Windows y macOS** con manager web centralizado, agentes Go instalables como servicio, alertas (SMTP + Telegram), inventario de hardware/software y **self-update remoto** desde la consola.

> Demo en producción: https://monitor.toolscode.cloud

---

## Componentes

| Componente | Stack | Descripción |
|---|---|---|
| **backend** | Go 1.24 + chi + pgx | API REST con JWT, ingesta de métricas, alertas, comandos remotos a agentes |
| **frontend** | React + Vite | Consola web monolítica (~2000 LOC en `main.jsx`, sin router) — dashboard, equipos, alertas, configuración |
| **agent** | Go 1.24 + gopsutil v4 | Binario único multi-OS (Linux/Windows/macOS amd64+arm64) instalable como servicio |
| **agent-assets** | golang:1.24-alpine | Servicio one-shot que compila los 4 binarios del agente con la versión inyectada via `-ldflags` |
| **postgres** | postgres:16-alpine | Persistencia |

Traefik (o nginx) sirve el frontend y proxy-pasa `/api/*` al backend. El frontend además expone `/downloads/<binario>` desde el volumen `agent-downloads` para que los agentes se auto-actualicen.

---

## Quickstart

**Requisitos:** Docker + Docker Compose v2 + git (ya viene en cualquier instalación normal).

```bash
git clone https://github.com/Quesillo27/resource-monitor.git
cd resource-monitor

# 1. Crear .env (ver sección de variables abajo)
cp .env.example .env
$EDITOR .env

# 2. Levantar todo
docker compose up -d --build
```

Eso levanta:
- `postgres` en red interna
- `backend` en `:8080`
- `frontend` en `:3000` (dev) o `:3010` (prod)
- `agent-assets` — servicio **continuo** que detecta cambios en el commit git y recompila los binarios automáticamente

Abrí la consola y entrá con las credenciales iniciales del `.env`.

## Flujo de actualización (automático)

El sistema detecta automáticamente la versión desde el SHA git del commit actual. **No tenés que tocar el `.env`** ni correr scripts manuales:

```bash
# Hiciste cambios y querés desplegar
git pull   # o git commit
docker compose up -d --build
```

Lo que pasa internamente:
1. `agent-assets` corre un loop cada 15s comparando el SHA git actual contra el último compilado
2. Cuando detecta un cambio, recompila los 4 binarios (Linux/Win/macOS amd64+arm64) con la versión `v1.0.0-<sha>` inyectada via `-ldflags` y escribe `/downloads/version.txt`
3. El backend lee `version.txt` en cada llamada a `/api/agent/version` — sin reinicio
4. En el siguiente heartbeat de cada agente remoto, si el backend detecta versión desactualizada, **encola automáticamente un comando `update`** (sin que tengas que clickear nada)
5. El agente descarga el binario nuevo, valida SHA-256, y se auto-reinicia

Resultado: un `git push` al manager + `docker compose up -d --build` actualiza toda la flota de agentes sin intervención manual.

---

## Variables de entorno (`.env`)

```bash
# DB
POSTGRES_PASSWORD=cambiar-este-secret-largo
POSTGRES_USER=resource_monitor
POSTGRES_DB=resource_monitor

# Backend
JWT_SECRET=cambiar-otro-secret-largo-de-64-chars
ADMIN_USERNAME=admin
ADMIN_PASSWORD=cambiar-en-primer-login
OFFLINE_AFTER_SECONDS=180
RETENTION_DAYS=30

# CORS / dominio público (opcional)
ALLOWED_ORIGINS=http://localhost:3010

# AGENT_RELEASE_VERSION ya NO se usa en condiciones normales — la versión
# se deriva automáticamente del SHA git por agent-assets. Se deja como
# fallback para entornos sin .git (p.ej. instalaciones desde release tarball).
# AGENT_RELEASE_VERSION=v1.0.0
```

---

## Scripts de operación (override manual)

En condiciones normales **no necesitás los scripts** — el flujo automático cubre el 99% de los casos. Quedan disponibles para overrides puntuales:

### `./scripts/redeploy.sh` — forzar versión específica + rebuild

```bash
./scripts/redeploy.sh v1.3.0   # versión explícita (no usa el SHA git)
```

Útil cuando querés publicar una release con tag específico (ej. `v1.0.0-rc1`) en lugar del SHA derivado del último commit.

### `./scripts/set-version.sh` — solo escribir versión en .env

```bash
./scripts/set-version.sh v1.3.0 --no-build
```

> Nota: con el flujo automático nuevo, escribir en `.env` solo afecta el fallback. La versión real la determina `agent-assets` desde el SHA git.

---

## Instalación del agente

Los agentes se instalan **descargando el binario desde el manager** (no desde GitHub Releases). El manager genera el comando exacto en su consola web (sección "Alta agente"):

### Linux

```bash
curl -fsSL https://<MANAGER>/downloads/install-agent.sh | sudo bash -s -- \
  --server-url https://<MANAGER> \
  --enrollment-token <TOKEN> \
  --name servidor-01
```

Instala el binario en `/usr/local/bin/resource-monitor-agent`, lo registra como servicio systemd con `Restart=always`, y arranca.

### Windows (PowerShell como admin)

```powershell
iwr https://<MANAGER>/downloads/install-agent.ps1 -OutFile install-agent.ps1
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 `
  -ServerUrl https://<MANAGER> `
  -EnrollmentToken <TOKEN> `
  -Name servidor-01
```

Instala en `C:\Program Files\ResourceMonitorAgent\`, registra como servicio del SCM con `OnFailure=restart`, y arranca.

### macOS

Descargar el binario apropiado (`-darwin-amd64` o `-darwin-arm64`) desde `https://<MANAGER>/downloads/`, instalarlo manualmente con:

```bash
sudo ./resource-monitor-agent install \
  --server-url https://<MANAGER> \
  --enrollment-token <TOKEN> \
  --name macbook-01
```

---

## Self-update remoto

Desde la consola web, al lado de cada agente con versión desactualizada aparece el botón **↑ actualizar**. Al clickearlo:

1. El manager encola un comando `update` en `agent_commands`
2. El agente recibe el comando en la respuesta de su próximo heartbeat (no hay endpoint de pull separado)
3. Descarga el binario nuevo desde `/downloads/`, valida el SHA-256 contra `checksums.txt`
4. **Linux:** rename atómico + `systemctl restart resource-monitor-agent`
5. **Windows:** lanza un helper `.cmd` desconectado que detiene el servicio (libera el lock del .exe), mueve el binario nuevo y lo reinicia
6. Reporta el resultado a `POST /api/agent/commands/{id}/result`

Comandos soportados: `update`, `ping`, `restart`.

---

## Endpoints principales

**Públicos:**
- `GET /healthz`
- `GET /api/agent/version` — última versión disponible

**Web (requieren `Authorization: Bearer <jwt>`):**
- `POST /api/auth/login`
- `GET /api/dashboard/overview` — KPIs, sparklines, heatmap 7d, distribución OS, capacidad cluster
- `GET /api/agents` · `GET /api/agents/{id}` · `GET /api/agents/{id}/history`
- `GET /api/agents/{id}/inventory` — hardware/software
- `POST /api/agents/{id}/commands` (admin/operator) — encolar comando remoto
- `GET /api/alerts` · `GET /api/alerts/stats`
- `GET/PUT /api/settings/smtp` · `GET/PUT /api/settings/telegram`
- `GET/POST/PATCH/DELETE /api/users` (solo admin)

**Agente (requieren `Authorization: Bearer <agent_credential>`):**
- `POST /api/agent/register` (con enrollment token)
- `POST /api/agent/heartbeat` — devuelve comandos pendientes en la respuesta
- `POST /api/agent/metrics`
- `POST /api/agent/inventory`
- `POST /api/agent/offline` — notificación de shutdown limpio
- `POST /api/agent/commands/{id}/result`

---

## Estados y umbrales

| Recurso | warning | critical |
|---|---|---|
| Disco | ≥ 80% | ≥ 90% |
| RAM | ≥ 85% | ≥ 95% |
| CPU | ≥ 85% | ≥ 95% |
| Offline | sin heartbeat por más de `OFFLINE_AFTER_SECONDS` (180s default) |

Las muestras de `metric_samples` se purgan automáticamente más allá de `RETENTION_DAYS` (30d default).

---

## Estructura del proyecto

```
resource-monitor/
├── agent/                          # Agente Go multi-OS
│   ├── cmd/agent/main.go           # CLI: install, uninstall, run, once, doctor, status, version
│   └── internal/
│       ├── buffer/                 # Cola FIFO en disco para offline (max 2000 muestras)
│       ├── client/                 # HTTP client al manager
│       ├── collector/              # Métricas + hardware + software (build tags por OS)
│       ├── config/
│       ├── runtime/                # Loop principal consolidado
│       ├── service/                # Wrapper kardianos/service
│       ├── updater/                # Self-update con SHA-256 + helper Windows
│       └── version/                # Variable Version inyectada via ldflags
├── backend/                        # API Go
│   └── internal/
│       ├── config/                 # Carga de env vars
│       ├── httpapi/                # Routing chi + handlers
│       ├── models/                 # Structs JSON con DisallowUnknownFields
│       └── store/                  # pgx + queries
├── frontend/                       # React + Vite
│   └── src/main.jsx                # SPA monolítica (sin router, navegación por state)
├── scripts/
│   ├── redeploy.sh                 # Redeploy con auto-bump de versión
│   ├── set-version.sh              # Bump de versión idempotente
│   ├── install-agent.sh            # Instalador Linux (servido en /downloads/)
│   └── install-agent.ps1           # Instalador Windows
├── docker-compose.yml              # Dev local
└── docker-compose.prod.yml         # Producción
```

---

## Notas técnicas

- **Backend usa `DisallowUnknownFields()`** en todos los decoders JSON. Si agregás un campo nuevo a una request del agente (`HeartbeatRequest`, `MetricsRequest`, etc.), tenés que extender el modelo del backend en el mismo PR o el agente recibirá `400 invalid json`.
- **`$$VAR` en `command:` de docker-compose** es escape para que la sustitución la haga el shell del container y no docker compose.
- **`gopsutil` requiere cachear `*process.Process`** entre ciclos para que `CPUPercent()` calcule el delta correctamente.
- **Frontend monolítico:** la navegación es state en App (`view = 'dashboard' | 'agents' | ...`). No hay React Router. Para navegar desde un componente hijo se pasan callbacks.
- **Soporte multi-arch del agente:** `agent-assets` compila Linux amd64, Windows amd64 y macOS amd64+arm64 en cada redeploy.

---

## Licencia

MIT
