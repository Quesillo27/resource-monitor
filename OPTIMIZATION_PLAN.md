# Plan de optimización — resource-monitor

> Generado 2026-05-11. Sistema actual: `manager-v1.5.0`, agente `v1.4.0`. Dos planes integrados:
>
> 1. **Arquitectura del proyecto** (re-estructura de código, qué viene primero) — el foco principal.
> 2. **Mejoras operacionales** (perf puntual, robustez, seguridad, calidad) — como referencia complementaria.

Esfuerzo: **S**=horas, **M**=día, **L**=varios días.

---

# Parte 1 — Arquitectura del proyecto

## Diagnóstico del estado actual

### Backend Go — desorganizado por iteraciones acumuladas

**Lo que está bien:**
- Estructura `cmd/` + `internal/{config, httpapi, models, store}/` es la convención Go correcta.
- Routes y handlers separados en `server.go`.

**Lo que está mal:**
- `internal/store/store.go` = 700+ LOC, muchas funciones distintas en un solo archivo.
- Versiones acumuladas: `store.go`, `v3.go`, `v31_runtime.go`, `alert_notifications.go` — cada feature agregada quedó en un archivo nuevo sin refactor.
- `httpapi/server.go` = 800+ LOC con TODO mezclado: handlers, helpers (`writeJSON`, `writeJSONWithETag`), middleware (`cors`), routes, decode.
- **No hay capa `service` ni `domain`**: la lógica de negocio (qué hacer cuando llega un heartbeat) vive entre handler y store sin separación.
- `models/` solo tiene structs — sin validación ni constructores.

### Frontend React — monolito severo

- `main.jsx` = **2153 LOC** con TODO: routing manual con `view` state, ~25 componentes, hooks custom, helpers, API client.
- Cero separación: no hay `pages/`, `components/`, `hooks/`, `lib/`.
- `request()` mezcla cache HTTP + auth + error handling.
- Muchos componentes con `useEffect`+`fetch` directo en vez de hook reutilizable.

### Operacional

- Scripts shell con lógica compleja embedded en YAML (el bloque `command: >` de `agent-assets` son ~30 líneas escapadas).
- `scripts/` mezcla install (agentes), set-version (manager), redeploy (manager), updater (manager).
- Configuración duplicada entre `docker-compose.yml` y `docker-compose.prod.yml` (DRY roto).

---

## Re-estructura propuesta

### Backend: 3 capas claras + dominio explícito

```
backend/
  cmd/server/main.go
  internal/
    domain/                    ← NUEVO (entidades + reglas de negocio)
      agent/
        agent.go               (struct + validaciones + constructor)
        status.go              (lógica online/offline/warning)
      alert/
      command/
    service/                   ← NUEVO (orquestación, casos de uso)
      heartbeat_service.go     (recibe req → valida → guarda → evalúa alertas)
      manager_update_service.go
    store/                     ← refactor (1 archivo por entidad)
      agent_repo.go
      metric_repo.go
      alert_repo.go
      command_repo.go
    httpapi/
      router.go                ← solo routing
      middleware/              ← cors, etag, gzip, auth, rate-limit
      handlers/                ← 1 archivo por área
        agent_handler.go
        manager_handler.go
        auth_handler.go
      response/                (writeJSON, writeError, writeETag)
    config/
```

**Beneficios:**
- Tests unitarios fáciles (services con stores mockeados).
- Cambiar Postgres por TimescaleDB toca solo `store/`.
- Cambiar HTTP por gRPC toca solo `httpapi/` y `handlers/`.
- Onboarding de un dev nuevo: lee `domain/` y entiende el sistema en 30 min.

### Frontend: feature-based + hooks reutilizables

```
frontend/src/
  main.jsx                     (~50 LOC: monta App, providers)
  app/
    App.jsx                    (router + auth gate)
    Shell.jsx                  (sidebar + main outlet)
  pages/
    Dashboard/
      index.jsx
      KpiHero.jsx
      AlertsTrend.jsx
      OnlineDonut.jsx
    Agents/
      List.jsx
      Detail/
        index.jsx
        SummaryTab.jsx
        ResourcesTab.jsx
        HardwareTab.jsx
        SoftwareTab.jsx
        AlertsTab.jsx
    Enrollment/
    Alerts/
    Settings/
      index.jsx
      Smtp.jsx
      Telegram.jsx
      Users.jsx
  components/
    StatusBadge.jsx
    Sparkline.jsx
    DataTable.jsx
    IconButton.jsx
    EmptyState.jsx
    ManagerUpdateButton.jsx
  hooks/
    useApi.js                  (wrapper con auth + ETag cache)
    useResource.js             (load + reload + polling)
    useDebounce.js
  lib/
    api.js                     (createApi, request)
    formatters.js              (percent, date, duration, relativeTime)
  styles/
    base.css
    sidebar.css
    dashboard.css
```

**Beneficios:**
- Editar un tab no carga 2153 líneas.
- React Router en vez del switch `view ===` manual.
- Componentes testeables con Vitest + Testing Library.
- Hot reload vuelve instantáneo.

### Operacional: scripts ordenados + compose DRY

```
scripts/
  agent/
    install.sh
    install.ps1
  manager/
    set-version.sh
    redeploy.sh
    self-updater.sh            (movido desde root)
    build-agents.sh            (extraído del bloque YAML inline)
docker-compose.base.yml        (servicios + redes)
docker-compose.dev.yml         (override: ports, mounts dev)
docker-compose.prod.yml        (override: traefik labels, restart policies)
```

**Beneficios:**
- `docker compose -f base.yml -f prod.yml up` (extends nativo).
- `agent-assets` deja de ser 30 líneas YAML escapado, pasa a script.
- Scripts del agente vs del manager separados visualmente.

---

## Performance del propio código (responder veloz)

| Cambio | Beneficio |
|---|---|
| **Carga lazy de tabs** (`React.lazy` + `Suspense`) | Entrar a un agente no carga código de Hardware/Software hasta clickear esos tabs |
| **Code splitting por ruta** | Bundle inicial chico; el resto se descarga on-demand |
| **Memoización (`useMemo` en sortBy/filter)** | Listas grandes no recalculan en cada render |
| **Debounce de búsquedas** | Input de software no llama API en cada keystroke |
| **Service workers para offline** | Sidebar y shell cacheados, primera carga ulterior instantánea |
| **Backend: caching de inventario en memoria** | Inventory cambia 1× al día; cachear con TTL evita query DB en cada open de detalle |
| **Backend: prepared statements en pgx** | Queries hot (heartbeat, listAgents) parseadas 1× |
| **Backend: `errgroup` para queries paralelas** | `AgentDetail` hace 5 queries seriales (disks, networks, processes, services, alerts). Paralelizar baja latencia ~5× |

---

## Sprints de re-arquitectura

| Sprint | Foco | Esfuerzo | Ganancia |
|---|---|---|---|
| **R1** | Reordenar scripts + extraer YAML inline + compose con extends | S | DX inmediato, base ordenada |
| **R2** | Backend: separar handlers, middleware, response helpers en archivos | M | Touch superficial pero abre el camino |
| **R3** | Backend: introducir capa `service/` y `domain/`, mover lógica de handlers/store | L | Habilita tests, refactors más seguros |
| **R4** | Backend: 1 archivo por entidad en `store/`, eliminar v3/v31 unificando | M | Elimina deuda técnica acumulada |
| **R5** | Frontend: split `main.jsx` por pages + components + hooks + React Router | L | Mantenibilidad masiva, hot reload veloz |
| **R6** | Frontend: lazy loading + memoización + debounce | M | Velocidad real perceptible al usuario |
| **R7** | Backend: paralelizar queries con `errgroup` + prepared statements | S | Latencia P50/P95 baja sensible |

**Arranque recomendado:**
1. **R1 + R2** primero: poco esfuerzo, gran limpieza visual del repo.
2. **R5** después: el monolito de 2153 LOC duele en cada cambio.
3. **R3-R4** diferidos hasta tener tests (refactor a ciegas es riesgoso).
4. **R6 y R7** en paralelo cuando ya esté la nueva estructura.

---

# Parte 2 — Mejoras operacionales (anexo)

> Marcadas con 🔥 las de mayor valor por menor código.

## A. Performance / costo de cómputo

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Indexes DB en `metric_samples`** | S | A | Verificar con `EXPLAIN` que `(agent_id, captured_at)` esté indexado compuesto |
| 🔥 **Cleanup retention configurable** | S | M | `RETENTION_DAYS=30` ya está en `.env` pero verificar que se ejecute |
| **SSE para live status** | M | M | Solo justifica con >5 admins activos. Hoy no |
| **Connection pooling tuning pgx** | S | B | Default está bien hasta 50+ agentes |

## B. UX / observabilidad

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Audit log de acciones admin** | M | A | Tabla `audit_log`, expone en pestaña "Auditoría" |
| **Dashboard: tendencias 7d/30d** | S | M | Hoy solo 24h |
| **Notificaciones browser push** | S | M | Para alertas críticas sin pestaña abierta |
| **Mobile-friendly** | M | B-M | Sidebar fijo no escala bien |
| **Skeleton loaders** | S | B | "Cargando…" → placeholders animados |

## C. Robustez / operaciones

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Healthcheck backend en docker-compose** | S | A | `/healthz` ya existe, falta wirearlo |
| 🔥 **Backup automático Postgres** | S | A | Cron diario, sin esto si se corrompe la DB perdés todo |
| 🔥 **Logs estructurados (JSON) backend** | S | M-A | `slog` JSON para grep/jq |
| **Rate limiting login** | S | M | Brute force protegido con `chi/middleware/Throttle` |
| **Rate limiting heartbeat por agente** | S | B | Defensivo contra agente loco |
| **Logs rotation agent-assets** | S | B | Logs crecen sin límite |
| **Rollback automático en self-update fallido** | M | M | Si UP falla a mitad, podés quedar con backend down |

## D. Seguridad

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Hash bcrypt del admin password** | S | A | Hoy en `.env` plaintext |
| 🔥 **CSRF protection** | S | M | Endpoints POST sin tokens |
| **JWT secret rotation** | M | M | Hoy si se filtra, todos los tokens vivos siguen válidos |
| **`manager-updater` menos privilegiado** | L | M | Hoy tiene Docker socket completo. `docker-socket-proxy` con whitelist |

## E. Calidad de código / CI

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Tests backend handlers críticos** | M | A | Heartbeat, metrics, agent commands, manager update |
| 🔥 **GitHub Actions: lint + build + test en cada PR** | S | A | golangci-lint + eslint + `go test` + `npm build` |
| **Tests del agente Go** | M | M | Mockear `gopsutil` y testear lógica |
| **Tests E2E del frontend** | L | M | Playwright contra una instancia dockerizada |

---

## Sprints operacionales (orden recomendado)

### Sprint Op-2 — Robustez básica (1-2 sesiones)
- Healthcheck backend en compose
- Backup Postgres automático
- Logs estructurados + log rotation
- Rate limiting login
- DB indexes review (con `EXPLAIN`)

### Sprint Op-3 — Calidad / CI (1-2 sesiones)
- GitHub Actions con lint + build + test
- Tests handlers backend críticos
- Tests collectors agente con mocks

### Sprint Op-4 — UX / mantenibilidad (2-3 sesiones)
- Audit log de acciones admin
- Skeleton loaders
- (la modularización del frontend va en R5 de la Parte 1)

### Sprint Op-5 — Seguridad (1 sesión)
- Hash bcrypt admin password + flow de reset
- CSRF tokens
- `docker-socket-proxy` para `manager-updater`

### Sprint Op-6 — Features opcionales (a demanda)
- Notificaciones push browser
- Tendencias 7d/30d
- Mobile-friendly

---

# Recomendación final de orden

1. **R1 + R2** (re-arquitectura ligera) — base limpia para todo lo demás.
2. **Sprint Op-2** (robustez básica) — defensivo crítico, evita pérdida de servicio.
3. **R5** (modularizar frontend) — desbloquea mantenibilidad UI.
4. **Sprint Op-3** (CI + tests) — habilita refactors mayores con seguridad.
5. **R3 + R4** (capa service/domain backend + dedup store) — refactor mayor con red de tests.
6. **R6 + R7** (perf real) + **Sprint Op-5** (seguridad) en paralelo.
7. **Sprint Op-4 y Op-6** (features) según demanda del producto.
