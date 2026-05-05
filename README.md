# Resource Monitor

App autocontenida para monitorear recursos de equipos Windows y Linux con backend Go, frontend React, PostgreSQL y agente Go instalable como servicio.

## Componentes

- `backend/`: API REST Go con JWT para consola web, registro de agentes, ingesta de metricas y alertas.
- `agent/`: agente Go con `gopsutil`, comandos `install`, `uninstall`, `run`, `once`, `doctor` y `status`.
- `frontend/`: consola React minimalista para dashboard, equipos, detalle, alta de agentes y alertas.
- `docker-compose.yml`: PostgreSQL, backend y frontend.
- `scripts/`: instaladores Linux/Windows para descargar binarios desde GitHub Releases.

## Puesta en marcha con Docker

1. Copia variables:

```powershell
Copy-Item .env.example .env
```

2. Edita `.env` y cambia `JWT_SECRET`, `POSTGRES_PASSWORD` y la contrasena admin. Docker Compose arma automaticamente `DATABASE_URL` con esos valores.

3. Levanta servicios:

```powershell
docker compose up --build
```

4. Abre la consola:

```text
http://localhost:3000
```

Credenciales iniciales por defecto:

```text
admin / admin123
```

El backend crea este usuario solo si la tabla `users` esta vacia.

## API web

- `POST /api/auth/login`
- `GET /api/dashboard/summary`
- `GET /api/agents`
- `GET /api/agents/:id`
- `GET /api/agents/:id/status`
- `POST /api/enrollment-tokens`
- `GET /api/alerts`

Las rutas web, excepto login, requieren:

```text
Authorization: Bearer <jwt>
```

## API agente

- `POST /api/agent/register`
- `POST /api/agent/heartbeat`
- `POST /api/agent/metrics`

`heartbeat` y `metrics` requieren:

```text
Authorization: Bearer <agent_credential>
```

## Agente con GitHub Releases

La consola web genera comandos listos para copiar desde **Alta agente**. El flujo recomendado descarga binarios precompilados desde GitHub Releases y no requiere instalar Go en cada equipo.

Linux:

```bash
curl -fsSL https://github.com/Quesillo27/resource-monitor/releases/latest/download/install-agent.sh | sudo bash -s -- --server-url http://MONITOR:8080 --enrollment-token TOKEN --name servidor-01
```

Windows PowerShell como administrador:

```powershell
iwr https://github.com/Quesillo27/resource-monitor/releases/latest/download/install-agent.ps1 -OutFile install-agent.ps1; powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -ServerUrl http://MONITOR:8080 -EnrollmentToken TOKEN -Name servidor-01
```

El instalador:

- Descarga el binario correcto.
- Instala Linux en `/usr/local/bin/resource-monitor-agent`.
- Instala Windows en `C:\Program Files\ResourceMonitorAgent\resource-monitor-agent.exe`.
- Registra el agente con el token.
- Crea la config local.
- Instala, habilita, arranca y valida el servicio.

Para que los comandos `latest/download` funcionen, primero crea un release desde GitHub Actions o publica un tag, por ejemplo `v0.2.0`. El workflow `.github/workflows/release.yml` adjunta los binarios y scripts al release.

## Agente manual

Compilar manualmente:

```bash
cd agent
go mod tidy
go build -o resource-monitor-agent ./cmd/agent
```

Instalar manualmente:

```bash
sudo ./resource-monitor-agent install --server-url http://MONITOR:8080 --enrollment-token TOKEN --name servidor-01
```

Ejecutar en primer plano:

```powershell
.\resource-monitor-agent.exe run --config C:\ProgramData\ResourceMonitorAgent\config.json
```

Enviar una muestra manual:

```powershell
.\resource-monitor-agent.exe once --server-url http://localhost:8080 --enrollment-token TOKEN
```

Diagnostico:

```bash
resource-monitor-agent doctor --config /etc/resource-monitor-agent/config.json
resource-monitor-agent status --config /etc/resource-monitor-agent/config.json
```

Rutas de config por defecto:

- Windows: `C:\ProgramData\ResourceMonitorAgent\config.json`
- Linux: `/etc/resource-monitor-agent/config.json`

## Estados y umbrales

- Disco: `warning` >= 80%, `critical` >= 90%.
- RAM: `warning` >= 85%, `critical` >= 95%.
- CPU: `warning` >= 85%, `critical` >= 95%.
- Offline: sin `last_seen_at` reciente por mas de `OFFLINE_AFTER_SECONDS` segundos, por defecto 180.

La retencion elimina muestras de `metric_samples` anteriores a `RETENTION_DAYS`, por defecto 30 dias. Las muestras de disco se borran por cascada.

## Payload de metricas

```json
{
  "cpu_percent": 42.5,
  "memory_total_bytes": 17179869184,
  "memory_used_bytes": 8589934592,
  "memory_used_percent": 50.0,
  "disks": [
    {
      "name": "/dev/sda1",
      "mountpoint": "/",
      "filesystem": "ext4",
      "total_bytes": 107374182400,
      "used_bytes": 64424509440,
      "free_bytes": 42949672960,
      "used_percent": 60.0
    }
  ]
}
```

## Pruebas sugeridas

Backend:

- Login valido e invalido.
- Registro con token valido, expirado y ya usado.
- Ingesta rechazada sin credencial de agente.
- Estados `warning`, `critical` y `offline`.
- Limpieza de metricas mayores a 30 dias.

Agente:

- Recoleccion en Windows y Linux.
- Reintento natural cuando el servidor no responde.
- Persistencia de credencial despues del registro.
- Instalacion y desinstalacion como servicio.

Frontend:

- Dashboard sin equipos, con equipos online y con equipos criticos.
- Tabla de discos con multiples unidades o mounts.
- Vista responsive desktop/movil.
- Generacion de token y copia del comando de instalacion.
