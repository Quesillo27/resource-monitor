package store

import (
	"context"
	"fmt"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

// GetBlockingLocks lista cadenas de locks bloqueantes en el target PG. Cada fila
// es un par (sesion bloqueada, sesion bloqueante). Se ignoran self-locks y
// requests sin holder (auto-vacuum locks transitorios, etc.).
func (s *Store) GetBlockingLocks(ctx context.Context, id string) ([]models.BlockingLock, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("blocking locks: solo soportado en postgres")
	}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(pollCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(pollCtx)

	rows, err := conn.Query(pollCtx, `
		SELECT
			blocked.pid,
			COALESCE(blocked.query, ''),
			COALESCE(blocked.usename, ''),
			COALESCE(blocked.application_name, ''),
			COALESCE(EXTRACT(EPOCH FROM (now() - blocked.query_start)) * 1000, 0)::bigint,
			blocking.pid,
			COALESCE(blocking.query, ''),
			COALESCE(blocking.usename, ''),
			COALESCE(blocking.application_name, ''),
			COALESCE(blocking.state, ''),
			COALESCE(blocked.wait_event, ''),
			COALESCE(bl.locktype, ''),
			COALESCE(
				CASE WHEN bl.relation IS NOT NULL THEN bl.relation::regclass::text END,
				''
			)
		FROM pg_locks bl
		JOIN pg_stat_activity blocked ON blocked.pid = bl.pid
		JOIN LATERAL (
			SELECT unnest(pg_blocking_pids(bl.pid)) AS blocking_pid
		) bp ON true
		JOIN pg_stat_activity blocking ON blocking.pid = bp.blocking_pid
		WHERE NOT bl.granted
		  AND blocked.datname = current_database()
		  AND blocked.pid <> blocking.pid
		ORDER BY blocked.query_start ASC
		LIMIT 50
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.BlockingLock
	for rows.Next() {
		var b models.BlockingLock
		if err := rows.Scan(
			&b.BlockedPID, &b.BlockedQuery, &b.BlockedUser, &b.BlockedApp, &b.BlockedTimeMs,
			&b.BlockingPID, &b.BlockingQuery, &b.BlockingUser, &b.BlockingApp, &b.BlockingState,
			&b.WaitEvent, &b.LockType, &b.Relation,
		); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// GetTableIO devuelve I/O acumulado por tabla — top 50 por heap_read.
// Útil para detectar cuellos de botella de disco.
func (s *Store) GetTableIO(ctx context.Context, id string) ([]models.TableIO, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("table I/O: solo soportado en postgres")
	}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(pollCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(pollCtx)

	rows, err := conn.Query(pollCtx, `
		SELECT schemaname, relname,
		       COALESCE(heap_blks_read, 0), COALESCE(heap_blks_hit, 0),
		       COALESCE(idx_blks_read, 0),  COALESCE(idx_blks_hit, 0)
		FROM pg_statio_user_tables
		WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
		ORDER BY heap_blks_read + COALESCE(idx_blks_read, 0) DESC
		LIMIT 50
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.TableIO
	for rows.Next() {
		var t models.TableIO
		if err := rows.Scan(&t.Schema, &t.Table, &t.HeapRead, &t.HeapHit, &t.IdxRead, &t.IdxHit); err != nil {
			return nil, err
		}
		totalHits := t.HeapHit + t.IdxHit
		totalReads := t.HeapRead + t.IdxRead
		if totalHits+totalReads > 0 {
			t.HitRatioPct = float64(totalHits) / float64(totalHits+totalReads) * 100
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetPGSettings devuelve los settings clave del servidor PG, ordenados por categoria.
// Lista hardcoded de los settings mas relevantes para tuning + diagnostico.
func (s *Store) GetPGSettings(ctx context.Context, id string) ([]models.PGSetting, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("settings: solo soportado en postgres")
	}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(pollCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(pollCtx)

	rows, err := conn.Query(pollCtx, `
		SELECT name, setting,
		       COALESCE(unit, ''),
		       COALESCE(category, ''),
		       COALESCE(short_desc, ''),
		       COALESCE(source, '')
		FROM pg_settings
		WHERE name IN (
			'shared_buffers', 'work_mem', 'maintenance_work_mem', 'effective_cache_size',
			'max_connections', 'max_worker_processes', 'max_parallel_workers',
			'wal_level', 'max_wal_size', 'min_wal_size', 'wal_buffers', 'checkpoint_timeout',
			'autovacuum', 'autovacuum_max_workers', 'autovacuum_vacuum_scale_factor',
			'autovacuum_analyze_scale_factor', 'autovacuum_naptime', 'autovacuum_freeze_max_age',
			'log_min_duration_statement', 'log_lock_waits', 'log_temp_files',
			'random_page_cost', 'seq_page_cost', 'effective_io_concurrency',
			'shared_preload_libraries', 'track_io_timing', 'track_activity_query_size',
			'idle_in_transaction_session_timeout', 'statement_timeout', 'lock_timeout',
			'hot_standby', 'wal_keep_size', 'max_replication_slots', 'max_wal_senders',
			'synchronous_commit', 'synchronous_standby_names'
		)
		ORDER BY category, name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.PGSetting
	for rows.Next() {
		var p models.PGSetting
		if err := rows.Scan(&p.Name, &p.Value, &p.Unit, &p.Category, &p.ShortDesc, &p.Source); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetAutovacuumStatus devuelve workers corriendo + tablas en cola para vacuum.
func (s *Store) GetAutovacuumStatus(ctx context.Context, id string) (map[string]any, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("autovacuum: solo soportado en postgres")
	}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(pollCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(pollCtx)

	out := map[string]any{}

	// Workers activos (PG 9.6+)
	type worker struct {
		PID      int    `json:"pid"`
		Phase    string `json:"phase"`
		Relation string `json:"relation,omitempty"`
		StartedAt string `json:"started_at,omitempty"`
	}
	var workers []worker
	rows, err := conn.Query(pollCtx, `
		SELECT pid, COALESCE(phase, ''),
		       COALESCE(relid::regclass::text, ''),
		       COALESCE(query_start::text, '')
		FROM pg_stat_progress_vacuum
		LEFT JOIN pg_stat_activity USING (pid)
	`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var w worker
			if err := rows.Scan(&w.PID, &w.Phase, &w.Relation, &w.StartedAt); err == nil {
				workers = append(workers, w)
			}
		}
	}
	out["workers"] = workers
	out["workers_count"] = len(workers)

	return out, nil
}
