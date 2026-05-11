# Plan de optimización — resource-monitor

> Generado 2026-05-11. Sistema actual: `manager-v1.5.0`, agente `v1.4.0`. Sin tests, monolito frontend, sin CI, infraestructura básica funcional pero con varios puntos defensivos pendientes.

Items priorizados por **impacto vs esfuerzo**. Marcados con 🔥 los de mayor valor por menor código.

Esfuerzo: **S**=horas, **M**=día, **L**=varios días.

---

## A. Performance / costo de cómputo

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Indexes DB en `metric_samples`** | S | A | Verificar con `EXPLAIN` que `(agent_id, captured_at)` esté indexado compuesto. Las queries de history sobre 24h pueden estar haciendo seq scan |
| 🔥 **Cleanup retention configurable** | S | M | `RETENTION_DAYS=30` ya está en `.env` pero verificar que se ejecute. Si la tabla crece sin parar, eventualmente queries del detalle van a doler |
| **Server-Sent Events (SSE) para live status** | M | M | Reemplazar polling por push. Solo justifica si vas a tener >5 admins activos. Hoy con 1-2 no vale |
| **Connection pooling tuning pgx** | S | B | `pool.MaxConns` por defecto. Con 5 agentes está sobrado, ajustar si crecés a 50+ |

## B. UX / observabilidad

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Audit log de acciones admin** | M | A | Quién/cuándo: self-update del manager, update de agente, cambio config alertas, delete agente. Tabla `audit_log` simple, expone en pestaña "Auditoría" |
| 🔥 **Modularizar `main.jsx` 2153 LOC** | M-L | A | Sprint 3 pendiente. Romper en `pages/`, `components/`, `hooks/` + React Router. Sin esto, cada cambio futuro es navegar un monolito |
| **Dashboard: tendencias 7d/30d** | S | M | Hoy solo tendencia 24h. Útil para detectar agentes con degradación lenta |
| **Notificaciones browser push** | S | M | Cuando aparece alerta crítica, notification del browser sin tener la pestaña abierta |
| **Mobile-friendly** | M | B-M | El sidebar fijo no escala bien en mobile |
| **Skeleton loaders** | S | B | "Cargando…" → placeholders animados |

## C. Robustez / operaciones

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Healthcheck backend en docker-compose** | S | A | `/healthz` ya existe. Agregar `healthcheck:` en backend service así Docker reporta "unhealthy" si muere |
| 🔥 **Backup automático Postgres** | S | A | Cron diario que dumpea `resource_monitor` DB a un volumen + rotación. Hoy si se corrompe la DB perdés todo |
| 🔥 **Logs estructurados (JSON) backend** | S | M-A | Cambiar de `log.Printf` a `slog` con JSON. Permite grep/jq en logs y eventual integración con Loki/Datadog |
| **Rate limiting login** | S | M | Brute force a `/api/auth/login` no tiene throttling. Agregar `chi/v5/middleware/Throttle` |
| **Rate limiting heartbeat por agente** | S | B | Si un agente loco empieza a mandar 100/s, no hay protección |
| **Logs rotation agent-assets** | S | B | Logs crecen sin límite |
| **Rollback automático en self-update fallido** | M | M | Si UP falla a mitad del flujo, podés quedar con backend down |

## D. Seguridad

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Hash bcrypt del admin password** | S | A | Hoy en `.env` plaintext. Migrar a hash + reset flow |
| 🔥 **CSRF protection** | S | M | Endpoints POST sin CSRF tokens. Para VPS personal con 1 admin no es crítico pero por hábito sí |
| **JWT secret rotation** | M | M | Si el secret se filtra, hoy todos los tokens vivos siguen válidos hasta su exp |
| **`manager-updater` menos privilegiado** | L | M | Hoy tiene Docker socket completo. Restringir con `docker-socket-proxy` que solo permita los comandos específicos que necesita |

## E. Calidad de código / CI

| Item | Esfuerzo | Impacto | Notas |
|---|---|---|---|
| 🔥 **Tests backend handlers críticos** | M | A | Sprint 2 pendiente. Heartbeat, metrics, agent commands, manager update. Cubrir el 20% que tiene el 80% del tráfico |
| 🔥 **GitHub Actions: lint + build + test en cada PR** | S | A | golangci-lint + eslint + `go test` + `npm build`. Evita romper main |
| **Tests del agente Go** | M | M | Collectors cross-platform son frágiles. Mockear `gopsutil` y testear lógica |
| **Tests E2E del frontend** | L | M | Playwright contra una instancia dockerizada |

---

## Sprints sugeridos

### Sprint 2 — Robustez básica (1-2 sesiones)
- Healthcheck backend en compose
- Backup Postgres automático
- Logs estructurados + log rotation
- Rate limiting login
- DB indexes review (con `EXPLAIN`)

### Sprint 3 — Calidad / CI (1-2 sesiones)
- GitHub Actions con lint + build + test
- Tests handlers backend críticos
- Tests collectors agente con mocks

### Sprint 4 — UX / mantenibilidad (2-3 sesiones)
- Modularizar `main.jsx` + React Router
- Audit log de acciones admin
- Skeleton loaders

### Sprint 5 — Seguridad (1 sesión)
- Hash bcrypt admin password + flow de reset
- CSRF tokens
- `docker-socket-proxy` para manager-updater

### Sprint 6 — Features opcionales (a demanda)
- Notificaciones push browser
- Tendencias 7d/30d
- Mobile-friendly

---

## Recomendación de arranque

**Sprint 2 primero.** Defensivo y barato. Hoy un solo evento (DB corrupta, backend muerto sin healthcheck, brute force en login) puede dejar sin servicio. Después de Sprint 2, la base es sólida para los refactors grandes (Sprint 4).
