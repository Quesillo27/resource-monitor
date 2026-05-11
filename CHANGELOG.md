# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado sigue [SemVer](https://semver.org/lang/es/):

- **MAJOR** — cambios incompatibles del contrato agente↔backend (schema, endpoints removidos, formato de heartbeat).
- **MINOR** — features, mejoras de performance o cambios de comportamiento backward-compatible.
- **PATCH** — bugfixes sin cambios de comportamiento.

## [1.3.0] — 2026-05-11

### Cambios de comportamiento

- **Quitado el auto-update de agentes en heartbeat**. Antes, si el agente reportaba una versión distinta a la `latest` publicada, el backend encolaba automáticamente un comando `update`. Ahora la actualización es **siempre manual**: el operador debe hacer click en `↑ actualizar` desde la lista de agentes en el manager. La infraestructura de comandos remotos (`POST /api/agents/{id}/commands`) y el botón ya estaban implementados, solo se eliminó el encolado automático en `heartbeat()`.

### Performance

- **Gzip habilitado** (`middleware.Compress(5)` en chi). Aplicado a todas las respuestas. Reducción medida: `/api/agents/{id}` 17 KB → 4.2 KB; `/api/agents/{id}/history` 273 KB → 36 KB.
- **ETag + 304 Not Modified** en `agentDetail`, `agentHistory`, `agentStatus` y `getAgentInventory`. SHA-256 de los primeros 8 bytes hex sobre el payload. Frontend cachea por URL+method y reusa la última respuesta cuando llega 304 (bail-out por identidad para saltar re-render en React).
- **Intervalos de polling relajados**: `STATUS_REFRESH_MS` 5s → 10s; `CHART_REFRESH_MS` 15s → 30s. Alineado con el ritmo de reporte del agente (~30s).
- **Eliminado `history` embebido en `AgentDetail`**. El payload viajaba dos veces: una dentro del detail (cada 5s) y otra por el endpoint dedicado `/api/agents/{id}/history` (cada 15s). Ahora solo el segundo. Función `metricHistory` removida por quedar huérfana.
- **`Cache-Control: no-store` → `no-cache, private`** en CORS middleware. Permite revalidación con ETag manteniendo privacidad.

### Estimación de impacto combinado

Sesión idle del detalle de agente: **~700 KB/min → <30 KB/min** (96% menos tráfico cuando los datos no cambian).

## [1.2.0] — 2026-05-09

### Agregado

- Sistema de auto-update de agentes con versionado `v<base>-<git-sha>` inyectado vía `-ldflags` por `agent-assets`.
- Endpoint `/api/agent/version` para que el agente consulte la latest publicada.
- Compilación atómica en `agent-assets` (commits intermedios no exponen binarios a medias).
- Binarios servidos por backend (`/downloads/*`) además del frontend nginx.

### Corregido

- Race condition en self-update Linux + reintento al fallar.
- Detección de más distros Linux durante el update.
- `history` ahora incluye `memory_used_bytes` y `swap_used_bytes`.
- Badge `✗ falló` se oculta cuando el agente ya está en la versión latest.
- Escape de `$AGENT_VERSION` en docker-compose para que lo interprete el container, no compose.

[1.3.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/v1.3.0
[1.2.0]: https://github.com/Quesillo27/resource-monitor/releases/tag/v1.2.0
