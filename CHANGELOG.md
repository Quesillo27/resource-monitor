# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado sigue [SemVer](https://semver.org/lang/es/).

**Versionado independiente por componente:**

- **Manager** (backend + frontend + scripts + docker-compose) — variable `MANAGER_VERSION` en `.env`. Tags `manager-vX.Y.Z`.
- **Agente** (binario en `agent/`) — variable `AGENT_RELEASE_VERSION` en `.env`. Tags `agent-vX.Y.Z`. Solo bumpea cuando cambia código del agente.

**Reglas SemVer:**

- **MAJOR** — cambios incompatibles del contrato agente↔backend (schema, endpoints removidos, formato de heartbeat).
- **MINOR** — features, mejoras de performance o cambios de comportamiento backward-compatible.
- **PATCH** — bugfixes sin cambios de comportamiento.

> **Nota histórica (2026-05-11):** los releases tempranos `v1.3.0` y `v1.4.0` bumpearon `AGENT_RELEASE_VERSION` por error cuando solo cambiaba el manager. Desde `manager-v1.5.0` los componentes se versionan por separado: el agente quedó en `v1.4.0` (sin cambio real de código del agente desde `v1.2.0`) y el manager retomó su propio ciclo.

---

## Manager

### [manager-v1.5.0] — 2026-05-11

**Agregado:**
- **`MANAGER_VERSION` en `.env`** — versionado independiente del manager, separado del agente. Backend lo expone en `GET /api/manager/version` junto al SHA del HEAD y al SHA latest del remoto.
- **`GET /api/manager/version`** — devuelve `{version, current, latest, behind, update_available, checked_at}` para que la UI sepa si hay update disponible sin clickear nada.
- **Updater hace `git fetch` periódico** (cada 60s, no toca working tree) y escribe `version-info.json` en el volumen compartido.
- **UI condicional del botón self-update**: si no hay update disponible, muestra solo la versión actual del manager. Si hay update, aparece el botón "↓ Actualizar manager" arriba del botón Salir.
- **`scripts/set-version.sh` ahora toma componente**: `set-version.sh manager v1.5.1` o `set-version.sh agent v1.4.1`.

**Detalles técnicos:**
- `agent-assets` ahora detecta cambios del agente con `git log -1 --format=%h -- agent/ scripts/install-agent.*`. Si solo cambia el manager, el binario y el `version.txt` no se tocan.

### [manager-v1.4.0] — 2026-05-11

**Agregado:**
- **Self-update del manager desde la UI**. Botón "Actualizar manager" en el sidebar (arriba de Salir). Click → confirmación → git pull + rebuild de backend+frontend + restart, todo desde la UI sin necesidad de SSH.
- **Servicio nuevo `manager-updater`** en docker-compose: container dedicado (`docker:28-cli` + git) que vigila `/triggers/update.requested` y ejecuta el flujo. Sobrevive a la muerte del backend porque corre aislado.
- **Endpoints admin**:
  - `POST /api/manager/update` — escribe el archivo trigger (idempotente: 409 si ya hay update activo).
  - `GET /api/manager/update/status` — lee `status.json` con estado, sha origen/destino, error si falló.
- **Estados visibles** en el botón: `idle` → `pulling` → `building_backend` → `building_frontend` → `restarting` → `done`/`failed: <razón>`. Polling 2s mientras hay update activo, 15s en idle.
- **Volumen `manager-triggers`** compartido entre backend y manager-updater.

**Detalles técnicos:**
- El flujo no hace rollback automático si falla. Si `docker compose build` falla, no se hace `up`: el backend sigue corriendo la versión previa con error reportado en `status.json`.
- El container `manager-updater` monta `/var/run/docker.sock` (riesgo de privilegio). Aceptable en VPS personal con un solo admin.

### [manager-v1.3.0] — 2026-05-11

**Cambios de comportamiento:**
- **Quitado el auto-update de agentes en heartbeat**. Ahora la actualización es **siempre manual** desde el botón "↑ actualizar" por agente.

**Performance:**
- **Gzip habilitado** (`middleware.Compress(5)` en chi). Reducción medida: `/api/agents/{id}` 17 KB → 4.2 KB; `/api/agents/{id}/history` 273 KB → 36 KB.
- **ETag + 304 Not Modified** en `agentDetail`, `agentHistory`, `agentStatus` y `getAgentInventory`.
- **Intervalos de polling relajados**: `STATUS_REFRESH_MS` 5s → 10s; `CHART_REFRESH_MS` 15s → 30s.
- **Eliminado `history` embebido en `AgentDetail`** (viaja por endpoint dedicado).
- **`Cache-Control: no-store` → `no-cache, private`**.

**Estimación combinada:** sesión idle del detalle de agente baja de ~700 KB/min a <30 KB/min.

### [manager-v1.2.0 y anteriores] — pre 2026-05-11

Releases del manager antes de la separación. Ver tags `v1.2.0` y previos.

---

## Agente

### [agent-v1.4.0]

> Tag publicado por error junto al manager (release `v1.4.0`). El código del agente NO cambió desde `agent-v1.2.0`. Versión retenida solo por compatibilidad con binarios ya distribuidos. Próximos cambios reales del agente arrancarán en `agent-v1.4.1` o `agent-v1.5.0`.

### [agent-v1.2.0] — 2026-05-09

**Agregado:**
- Sistema de auto-update de agentes con versionado `v<base>-<git-sha>` inyectado vía `-ldflags` por `agent-assets`.
- Endpoint `/api/agent/version` para que el agente consulte la latest publicada.
- Compilación atómica en `agent-assets` (commits intermedios no exponen binarios a medias).
- Binarios servidos por backend (`/downloads/*`) además del frontend nginx.

**Corregido:**
- Race condition en self-update Linux + reintento al fallar.
- Detección de más distros Linux durante el update.
- `history` ahora incluye `memory_used_bytes` y `swap_used_bytes`.
- Badge `✗ falló` se oculta cuando el agente ya está en la versión latest.
- Escape de `$AGENT_VERSION` en docker-compose.

[manager-v1.5.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/manager-v1.5.0
[manager-v1.4.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/manager-v1.4.0
[manager-v1.3.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/manager-v1.3.0
[agent-v1.2.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/agent-v1.2.0
