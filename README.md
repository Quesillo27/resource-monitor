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

**Requisitos:** Docker + Docker Compose v2.

```bash
git clone https://github.com/Quesillo27/resource-monitor.git
cd resource-monitor

# 1. Crear .env (ver sección de variables abajo)
cp .env.example .env
$EDITOR .env

# 2. Redeploy completo (calcula versión, compila, levanta todo)
./scripts/redeploy.sh
```

Eso levanta:
- `postgres` en red interna
- `backend` en `:8080`
- `frontend` en `:3010` (o el puerto que mapees en compose)
- `agent-assets` (corre, compila los binarios en `/downloads/`, y termina)

Abrí la consola en `http://localhost:3010` y entrá con las credenciales iniciales del `.env`.

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

# Versionado de agentes (auto-gestionado por scripts/redeploy.sh)
AGENT_RELEASE_VERSION=v1.0.0-dev

# CORS / dominio público (opcional)
ALLOWED_ORIGINS=http://localhost:3010
```

---

## Scripts de operación

### `./scripts/redeploy.sh` — comando único de redeploy

Hace todo el flujo de reconstrucción de forma idempotente:

```bash
./scripts/redeploy.sh                # versión auto: v1.0.0-<git-short-sha>
./scripts/redeploy.sh v1.3.0         # versión explícita
```

Internamente:
1. Calcula `AGENT_RELEASE_VERSION` desde el SHA de git (o usa el arg si lo pasás)
2. Actualiza el `.env`
3. Rebuild de backend + frontend + agent-assets
4. Espera a que los binarios se compilen
5. Verifica que `/api/agent/version` devuelva la versión nueva

### `./scripts/set-version.sh` — bump de versión sin rebuild

```bash
./scripts/set-version.sh                    # versión auto desde git
./scripts/set-version.sh v1.3.0             # versión explícita
./scripts/set-version.sh v1.3.0 --no-build  # solo .env, sin tocar containers
```

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
