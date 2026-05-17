package dbhost

import (
	"context"

	"resource-monitor/agent/internal/client"
)

// CollectDBSample recolecta metricas directamente de la BD local. Si el motor
// no esta soportado o la conexion falla, retorna nil (el heartbeat de host
// sigue mandandose sin db_sample).
//
// Solo postgres por ahora — mysql/mongo en fases futuras.
func CollectDBSample(ctx context.Context, engine, dsn string) *client.DatabaseSample {
	switch engine {
	case "postgres":
		return collectPostgresLocal(ctx, dsn)
	default:
		return nil
	}
}
