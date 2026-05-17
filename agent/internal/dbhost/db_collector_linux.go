//go:build linux

package dbhost

import (
	"context"
	"time"

	"resource-monitor/agent/internal/client"

	"github.com/jackc/pgx/v5"
)

// collectPostgresLocal conecta a la BD local via Unix socket o 127.0.0.1 y
// extrae el subset de metricas que tambien recolecta el polling remoto del
// manager: cache hit, conexiones, slow queries activas, deadlocks, p95.
// Si dsn esta vacio intenta el default de pgx que resuelve por env vars +
// socket peer auth (PGHOST=/var/run/postgresql).
func collectPostgresLocal(ctx context.Context, dsn string) *client.DatabaseSample {
	sample := &client.DatabaseSample{
		CapturedAt: time.Now(),
		OK:         true,
	}
	connCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if dsn == "" {
		dsn = "host=/var/run/postgresql"
	}
	conn, err := pgx.Connect(connCtx, dsn)
	if err != nil {
		sample.OK = false
		sample.ErrorMessage = "conexion local fallo: " + err.Error()
		return sample
	}
	defer conn.Close(connCtx)

	// 1) Conexiones por estado
	var active, idle, waiting, total int
	_ = conn.QueryRow(connCtx, `
		SELECT
			COALESCE(SUM(CASE WHEN state='active' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN state='idle' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN wait_event IS NOT NULL THEN 1 ELSE 0 END), 0),
			COUNT(*)
		FROM pg_stat_activity
	`).Scan(&active, &idle, &waiting, &total)
	sample.ConnectionsActive = &active
	sample.ConnectionsIdle = &idle
	sample.ConnectionsWaiting = &waiting
	sample.ConnectionsTotal = &total

	// 2) max_connections
	var maxConn int
	if conn.QueryRow(connCtx, `SELECT setting::int FROM pg_settings WHERE name='max_connections'`).Scan(&maxConn) == nil {
		sample.MaxConnections = &maxConn
	}

	// 3) Cache hit ratio + commits/rollbacks/deadlocks de pg_stat_database
	var hits, reads int64
	var commits, rollbacks, deadlocks int64
	_ = conn.QueryRow(connCtx, `
		SELECT
			COALESCE(SUM(blks_hit), 0),
			COALESCE(SUM(blks_read), 0),
			COALESCE(SUM(xact_commit), 0),
			COALESCE(SUM(xact_rollback), 0),
			COALESCE(SUM(deadlocks), 0)
		FROM pg_stat_database
		WHERE datname NOT IN ('template0','template1') AND datname IS NOT NULL
	`).Scan(&hits, &reads, &commits, &rollbacks, &deadlocks)
	if hits+reads > 0 {
		r := float64(hits) / float64(hits+reads)
		sample.CacheHitRatio = &r
	}
	sample.TransactionsCommitted = &commits
	sample.TransactionsRolledBack = &rollbacks
	sample.Deadlocks = &deadlocks

	// 4) DB size de la base actual
	var dbSize int64
	if conn.QueryRow(connCtx, `SELECT pg_database_size(current_database())`).Scan(&dbSize) == nil {
		sample.DBSizeBytes = &dbSize
	}

	// 5) Slow queries activas (>5s)
	var slow int
	_ = conn.QueryRow(connCtx, `
		SELECT COUNT(*)::int FROM pg_stat_activity
		WHERE state='active' AND query_start IS NOT NULL
		  AND now() - query_start > interval '5 seconds'
		  AND pid != pg_backend_pid()
	`).Scan(&slow)
	sample.SlowQueries = &slow

	// 6) Active locks (waiting)
	var locks int
	_ = conn.QueryRow(connCtx, `SELECT COUNT(*)::int FROM pg_locks WHERE NOT granted`).Scan(&locks)
	sample.ActiveLocks = &locks

	// 7) p95 de pg_stat_statements (si la extension esta instalada)
	var p95 float64
	if conn.QueryRow(connCtx, `
		SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY mean_exec_time)::float8
		FROM pg_stat_statements
	`).Scan(&p95) == nil {
		sample.SlowQueryP95Ms = &p95
	}

	return sample
}
