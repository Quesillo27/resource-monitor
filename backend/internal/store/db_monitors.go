package store

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

// MaskDSN replaces the password in a DSN with **** (literal, not URL-encoded).
// Returns the input unchanged if it cannot be parsed as a URL. For non-URL DSNs
// (e.g. Redis host:port) returns as-is since they don't carry the password inline.
func MaskDSN(dsn string) string {
	if dsn == "" || !strings.Contains(dsn, "://") {
		return dsn
	}
	// Find scheme:// prefix
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd < 0 {
		return dsn
	}
	prefix := dsn[:schemeEnd+3]
	rest := dsn[schemeEnd+3:]

	// Find '@' separating userinfo from host
	at := strings.Index(rest, "@")
	if at < 0 {
		return dsn // no userinfo, nothing to mask
	}
	userinfo := rest[:at]
	hostAndPath := rest[at:]

	// Split user:password
	colon := strings.Index(userinfo, ":")
	if colon < 0 {
		return dsn // no password to mask
	}
	user := userinfo[:colon]
	return prefix + user + ":****" + hostAndPath
}

// DSNIsMasked returns true if the DSN looks like it came from MaskDSN (contains :****@).
// Used by Update handlers to detect when the client returned the masked value and
// the original DSN should be preserved.
func DSNIsMasked(dsn string) bool {
	return strings.Contains(dsn, ":****@")
}

func (s *Store) ensureDBMonitorSchema(ctx context.Context) error {
	s.onceDBMonitor.Do(func() { s.onceDBMonitorErr = s.runDBMonitorSchema(ctx) })
	return s.onceDBMonitorErr
}

func (s *Store) runDBMonitorSchema(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS db_targets (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			name TEXT NOT NULL,
			type TEXT NOT NULL DEFAULT 'postgres',
			dsn TEXT NOT NULL DEFAULT '',
			params JSONB NOT NULL DEFAULT '{}',
			enabled BOOLEAN NOT NULL DEFAULT true,
			poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS db_samples (
			id BIGSERIAL PRIMARY KEY,
			target_id UUID NOT NULL REFERENCES db_targets(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			ok BOOLEAN NOT NULL DEFAULT true,
			error_message TEXT NOT NULL DEFAULT '',
			connections_active INTEGER,
			connections_idle INTEGER,
			connections_waiting INTEGER,
			connections_total INTEGER,
			db_size_bytes BIGINT,
			slow_queries INTEGER,
			active_locks INTEGER,
			cache_hit_ratio DOUBLE PRECISION,
			transactions_committed BIGINT,
			transactions_rolled_back BIGINT,
			memory_used_bytes BIGINT,
			memory_max_bytes BIGINT,
			connected_clients INTEGER,
			ops_per_sec DOUBLE PRECISION,
			keyspace_hits BIGINT,
			keyspace_misses BIGINT
		)`,
		`CREATE INDEX IF NOT EXISTS db_samples_target_time_idx ON db_samples(target_id, captured_at DESC)`,
		// Métricas extendidas (Fase A — manager-v1.10.0)
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS deadlocks BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS temp_files BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS temp_bytes BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS tuples_returned BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS tuples_fetched BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS tuples_inserted BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS tuples_updated BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS tuples_deleted BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS wal_bytes BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS xid_age BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS blks_read BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS blks_hit BIGINT`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS max_connections INTEGER`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS slow_query_p50_ms DOUBLE PRECISION`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS slow_query_p95_ms DOUBLE PRECISION`,
		`ALTER TABLE db_samples ADD COLUMN IF NOT EXISTS slow_query_p99_ms DOUBLE PRECISION`,
	}
	for _, stmt := range stmts {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	// Seed reglas default DB (idempotente). Si falla, no rompe el bootstrap.
	if err := s.SeedDefaultDBAlertRules(ctx); err != nil {
		log.Printf("seed db alert rules: %v", err)
	}
	return nil
}

func (s *Store) ListDatabaseTargets(ctx context.Context) ([]models.DatabaseTarget, error) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT t.id::text, t.name, t.type, t.dsn, t.params, t.enabled, t.poll_interval_seconds,
		       t.created_at, t.updated_at,
		       s.ok, s.error_message, s.captured_at,
		       sp.vals
		FROM db_targets t
		LEFT JOIN LATERAL (
			SELECT ok, error_message, captured_at
			FROM db_samples WHERE target_id = t.id
			ORDER BY captured_at DESC LIMIT 1
		) s ON true
		LEFT JOIN LATERAL (
			SELECT COALESCE(array_agg(
				CASE WHEN t.type = 'redis' THEN connected_clients ELSE connections_total END
				ORDER BY sq.captured_at ASC
			), ARRAY[]::integer[]) AS vals
			FROM (
				SELECT connections_total, connected_clients, captured_at
				FROM db_samples
				WHERE target_id = t.id
				  AND CASE WHEN t.type = 'redis' THEN connected_clients ELSE connections_total END IS NOT NULL
				ORDER BY captured_at DESC LIMIT 20
			) sq
		) sp ON true
		ORDER BY t.created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := []models.DatabaseTarget{}
	for rows.Next() {
		var t models.DatabaseTarget
		var params []byte
		var lastOK *bool
		var lastErr *string
		var lastAt *time.Time
		var spark []int32
		if err := rows.Scan(&t.ID, &t.Name, &t.Type, &t.DSN, &params, &t.Enabled, &t.PollIntervalSeconds,
			&t.CreatedAt, &t.UpdatedAt, &lastOK, &lastErr, &lastAt, &spark); err != nil {
			return nil, err
		}
		if params != nil {
			_ = json.Unmarshal(params, &t.Params)
		}
		t.LastOK = lastOK
		if lastErr != nil {
			t.LastError = *lastErr
		}
		t.LastSampleAt = lastAt
		if len(spark) > 0 {
			t.Sparkline = make([]int, len(spark))
			for i, v := range spark {
				t.Sparkline[i] = int(v)
			}
		}
		targets = append(targets, t)
	}
	return targets, rows.Err()
}

func (s *Store) GetDatabaseTarget(ctx context.Context, id string) (models.DatabaseTarget, error) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return models.DatabaseTarget{}, err
	}
	var t models.DatabaseTarget
	var params []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, type, dsn, params, enabled, poll_interval_seconds, created_at, updated_at
		FROM db_targets WHERE id = $1
	`, id).Scan(&t.ID, &t.Name, &t.Type, &t.DSN, &params, &t.Enabled, &t.PollIntervalSeconds, &t.CreatedAt, &t.UpdatedAt)
	if err == pgx.ErrNoRows {
		return models.DatabaseTarget{}, ErrNotFound
	}
	if err != nil {
		return models.DatabaseTarget{}, err
	}
	if params != nil {
		_ = json.Unmarshal(params, &t.Params)
	}
	return t, nil
}

func (s *Store) CreateDatabaseTarget(ctx context.Context, t models.DatabaseTarget) (models.DatabaseTarget, error) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return models.DatabaseTarget{}, err
	}
	if t.PollIntervalSeconds <= 0 {
		t.PollIntervalSeconds = 60
	}
	params, _ := json.Marshal(t.Params)
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO db_targets (name, type, dsn, params, enabled, poll_interval_seconds)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text
	`, t.Name, t.Type, t.DSN, params, t.Enabled, t.PollIntervalSeconds).Scan(&id)
	if err != nil {
		return models.DatabaseTarget{}, err
	}
	return s.GetDatabaseTarget(ctx, id)
}

func (s *Store) UpdateDatabaseTarget(ctx context.Context, id string, t models.DatabaseTarget) (models.DatabaseTarget, error) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return models.DatabaseTarget{}, err
	}
	if t.PollIntervalSeconds <= 0 {
		t.PollIntervalSeconds = 60
	}
	params, _ := json.Marshal(t.Params)
	tag, err := s.pool.Exec(ctx, `
		UPDATE db_targets
		SET name=$2, type=$3, dsn=$4, params=$5, enabled=$6, poll_interval_seconds=$7, updated_at=now()
		WHERE id=$1
	`, id, t.Name, t.Type, t.DSN, params, t.Enabled, t.PollIntervalSeconds)
	if err != nil {
		return models.DatabaseTarget{}, err
	}
	if tag.RowsAffected() == 0 {
		return models.DatabaseTarget{}, ErrNotFound
	}
	return s.GetDatabaseTarget(ctx, id)
}

func (s *Store) DeleteDatabaseTarget(ctx context.Context, id string) error {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, "DELETE FROM db_targets WHERE id = $1", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) GetDatabaseMetrics(ctx context.Context, targetID string, limit int) ([]models.DatabaseSample, error) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 60
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, target_id::text, captured_at, ok, error_message,
		       connections_active, connections_idle, connections_waiting, connections_total,
		       db_size_bytes, slow_queries, active_locks, cache_hit_ratio,
		       transactions_committed, transactions_rolled_back,
		       memory_used_bytes, memory_max_bytes, connected_clients, ops_per_sec,
		       keyspace_hits, keyspace_misses,
		       deadlocks, temp_files, temp_bytes,
		       tuples_returned, tuples_fetched, tuples_inserted, tuples_updated, tuples_deleted,
		       wal_bytes, xid_age, blks_read, blks_hit, max_connections,
		       slow_query_p50_ms, slow_query_p95_ms, slow_query_p99_ms
		FROM db_samples WHERE target_id = $1
		ORDER BY captured_at DESC LIMIT $2
	`, targetID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	samples := []models.DatabaseSample{}
	for rows.Next() {
		var s models.DatabaseSample
		if err := rows.Scan(
			&s.ID, &s.TargetID, &s.CapturedAt, &s.OK, &s.ErrorMessage,
			&s.ConnectionsActive, &s.ConnectionsIdle, &s.ConnectionsWaiting, &s.ConnectionsTotal,
			&s.DBSizeBytes, &s.SlowQueries, &s.ActiveLocks, &s.CacheHitRatio,
			&s.TransactionsCommitted, &s.TransactionsRolledBack,
			&s.MemoryUsedBytes, &s.MemoryMaxBytes, &s.ConnectedClients, &s.OpsPerSec,
			&s.KeyspaceHits, &s.KeyspaceMisses,
			&s.Deadlocks, &s.TempFiles, &s.TempBytes,
			&s.TuplesReturned, &s.TuplesFetched, &s.TuplesInserted, &s.TuplesUpdated, &s.TuplesDeleted,
			&s.WalBytes, &s.XidAge, &s.BlksRead, &s.BlksHit, &s.MaxConnections,
			&s.SlowQueryP50Ms, &s.SlowQueryP95Ms, &s.SlowQueryP99Ms,
		); err != nil {
			return nil, err
		}
		samples = append(samples, s)
	}
	return samples, rows.Err()
}

func (s *Store) insertDBSample(ctx context.Context, sample models.DatabaseSample) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO db_samples (
			target_id, captured_at, ok, error_message,
			connections_active, connections_idle, connections_waiting, connections_total,
			db_size_bytes, slow_queries, active_locks, cache_hit_ratio,
			transactions_committed, transactions_rolled_back,
			memory_used_bytes, memory_max_bytes, connected_clients, ops_per_sec,
			keyspace_hits, keyspace_misses,
			deadlocks, temp_files, temp_bytes,
			tuples_returned, tuples_fetched, tuples_inserted, tuples_updated, tuples_deleted,
			wal_bytes, xid_age, blks_read, blks_hit, max_connections,
			slow_query_p50_ms, slow_query_p95_ms, slow_query_p99_ms
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
			$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36
		)`,
		sample.TargetID, sample.CapturedAt, sample.OK, sample.ErrorMessage,
		sample.ConnectionsActive, sample.ConnectionsIdle, sample.ConnectionsWaiting, sample.ConnectionsTotal,
		sample.DBSizeBytes, sample.SlowQueries, sample.ActiveLocks, sample.CacheHitRatio,
		sample.TransactionsCommitted, sample.TransactionsRolledBack,
		sample.MemoryUsedBytes, sample.MemoryMaxBytes, sample.ConnectedClients, sample.OpsPerSec,
		sample.KeyspaceHits, sample.KeyspaceMisses,
		sample.Deadlocks, sample.TempFiles, sample.TempBytes,
		sample.TuplesReturned, sample.TuplesFetched, sample.TuplesInserted, sample.TuplesUpdated, sample.TuplesDeleted,
		sample.WalBytes, sample.XidAge, sample.BlksRead, sample.BlksHit, sample.MaxConnections,
		sample.SlowQueryP50Ms, sample.SlowQueryP95Ms, sample.SlowQueryP99Ms,
	)
	return err
}

// PollAllDatabaseTargets polls each enabled target whose last sample is due.
// Designed to be called from a goroutine on a regular ticker.
func (s *Store) PollAllDatabaseTargets(ctx context.Context) {
	if err := s.ensureDBMonitorSchema(ctx); err != nil {
		log.Printf("db monitor schema: %v", err)
		return
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, type, dsn, params, poll_interval_seconds
		FROM db_targets
		WHERE enabled = true
		  AND (
		    NOT EXISTS (SELECT 1 FROM db_samples WHERE target_id = db_targets.id)
		    OR (
		      SELECT captured_at FROM db_samples
		      WHERE target_id = db_targets.id
		      ORDER BY captured_at DESC LIMIT 1
		    ) < now() - (poll_interval_seconds * interval '1 second')
		  )
	`)
	if err != nil {
		log.Printf("db monitor list: %v", err)
		return
	}
	type pollTarget struct {
		id, name, dbType, dsn string
		params                 map[string]string
	}
	var targets []pollTarget
	for rows.Next() {
		var pt pollTarget
		var params []byte
		var interval int
		if err := rows.Scan(&pt.id, &pt.name, &pt.dbType, &pt.dsn, &params, &interval); err != nil {
			rows.Close()
			log.Printf("db monitor scan: %v", err)
			return
		}
		if params != nil {
			_ = json.Unmarshal(params, &pt.params)
		}
		targets = append(targets, pt)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("db monitor rows: %v", err)
		return
	}

	var wg sync.WaitGroup
	for _, t := range targets {
		wg.Add(1)
		go func(pt pollTarget) {
			defer wg.Done()
			var sample models.DatabaseSample
			profile := pt.params["profile"]
			if profile == "" {
				profile = "standard"
			}
			switch pt.dbType {
			case "postgres":
				sample = collectPostgresDB(ctx, pt.dsn, profile)
			case "redis":
				sample = collectRedisDB(ctx, pt.dsn, pt.params["password"])
			case "mysql", "mariadb":
				sample = collectMySQLDB(ctx, pt.dsn, profile)
			case "sqlite":
				sample = collectSQLiteDB(ctx, pt.dsn)
			case "mongodb":
				sample = collectMongoDB(ctx, pt.dsn, profile)
			default:
				sample = models.DatabaseSample{OK: false, ErrorMessage: fmt.Sprintf("unsupported type: %s", pt.dbType)}
			}
			sample.TargetID = pt.id
			sample.CapturedAt = time.Now()

			// Cargar el sample anterior antes de insertar (para deltas en alertas)
			prevSamples, _ := s.GetDatabaseMetrics(ctx, pt.id, 1)
			var prev *models.DatabaseSample
			if len(prevSamples) > 0 {
				prev = &prevSamples[0]
			}

			if err := s.insertDBSample(ctx, sample); err != nil {
				log.Printf("db monitor insert (%s): %v", pt.name, err)
				return
			}

			// Evaluacion de alertas DB (no bloquea polling de otros targets)
			target := models.DatabaseTarget{
				ID:   pt.id,
				Name: pt.name,
				Type: pt.dbType,
			}
			s.EvaluateDBTargetAlerts(ctx, target, sample, prev)
		}(t)
	}
	wg.Wait()
}

// Perfiles: "basic" recolecta solo conexiones + db_size + ping; "standard"
// agrega cache hit, TPS, slow queries activas, locks, tuple stats; "full"
// agrega percentiles p50/p95/p99 y tuple counts adicionales.
func collectPostgresDB(ctx context.Context, dsn, profile string) models.DatabaseSample {
	sample := models.DatabaseSample{OK: true}
	pollCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	conn, err := pgx.Connect(pollCtx, dsn)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	defer conn.Close(pollCtx)

	// Connection states
	connRows, err := conn.Query(pollCtx, `
		SELECT COALESCE(state, 'unknown'), count(*)
		FROM pg_stat_activity WHERE datname = current_database() GROUP BY state
	`)
	if err == nil {
		active, idle, total := 0, 0, 0
		for connRows.Next() {
			var state string
			var cnt int
			if connRows.Scan(&state, &cnt) == nil {
				total += cnt
				switch state {
				case "active":
					active += cnt
				case "idle", "idle in transaction", "idle in transaction (aborted)":
					idle += cnt
				}
			}
		}
		connRows.Close()
		sample.ConnectionsActive = &active
		sample.ConnectionsIdle = &idle
		sample.ConnectionsTotal = &total
	}

	// Waiting connections
	var waiting int
	if conn.QueryRow(pollCtx, `
		SELECT count(*) FROM pg_stat_activity
		WHERE datname = current_database() AND wait_event_type IS NOT NULL AND state = 'active'
	`).Scan(&waiting) == nil {
		sample.ConnectionsWaiting = &waiting
	}

	// DB size
	var dbSize int64
	if conn.QueryRow(pollCtx, `SELECT pg_database_size(current_database())`).Scan(&dbSize) == nil {
		sample.DBSizeBytes = &dbSize
	}

	// max_connections siempre (lo usa el perfil basic para alertas de pool)
	var maxConn int
	if conn.QueryRow(pollCtx, `SELECT setting::int FROM pg_settings WHERE name = 'max_connections'`).Scan(&maxConn) == nil {
		sample.MaxConnections = &maxConn
	}

	// Perfil "basic": termina aca — solo ping + conexiones + db size + max_connections
	if profile == "basic" {
		return sample
	}

	// Métricas agregadas de pg_stat_database (cache, tx, tuples, temp, blks, deadlocks) en una sola query
	var (
		blksHit, blksRead                                                  int64
		xactCommit, xactRollback                                           int64
		tupReturned, tupFetched, tupInserted, tupUpdated, tupDeleted       int64
		tempFiles, tempBytes, deadlocks                                    int64
	)
	if conn.QueryRow(pollCtx, `
		SELECT
		  COALESCE(blks_hit, 0), COALESCE(blks_read, 0),
		  COALESCE(xact_commit, 0), COALESCE(xact_rollback, 0),
		  COALESCE(tup_returned, 0), COALESCE(tup_fetched, 0),
		  COALESCE(tup_inserted, 0), COALESCE(tup_updated, 0), COALESCE(tup_deleted, 0),
		  COALESCE(temp_files, 0), COALESCE(temp_bytes, 0), COALESCE(deadlocks, 0)
		FROM pg_stat_database WHERE datname = current_database()
	`).Scan(
		&blksHit, &blksRead,
		&xactCommit, &xactRollback,
		&tupReturned, &tupFetched, &tupInserted, &tupUpdated, &tupDeleted,
		&tempFiles, &tempBytes, &deadlocks,
	) == nil {
		if denom := blksHit + blksRead; denom > 0 {
			ratio := float64(blksHit) / float64(denom)
			sample.CacheHitRatio = &ratio
		}
		sample.BlksHit = &blksHit
		sample.BlksRead = &blksRead
		sample.TransactionsCommitted = &xactCommit
		sample.TransactionsRolledBack = &xactRollback
		sample.TuplesReturned = &tupReturned
		sample.TuplesFetched = &tupFetched
		sample.TuplesInserted = &tupInserted
		sample.TuplesUpdated = &tupUpdated
		sample.TuplesDeleted = &tupDeleted
		sample.TempFiles = &tempFiles
		sample.TempBytes = &tempBytes
		sample.Deadlocks = &deadlocks
	}

	// Ungranted locks
	var locks int
	if conn.QueryRow(pollCtx, `SELECT count(*) FROM pg_locks WHERE NOT granted`).Scan(&locks) == nil {
		sample.ActiveLocks = &locks
	}

	// Slow queries (> 5 s)
	var slow int
	if conn.QueryRow(pollCtx, `
		SELECT count(*) FROM pg_stat_activity
		WHERE state = 'active'
		  AND query_start < now() - interval '5 seconds'
		  AND datname = current_database()
		  AND query NOT LIKE '%pg_stat_activity%'
	`).Scan(&slow) == nil {
		sample.SlowQueries = &slow
	}

	// Perfil "standard": termina aca. Las metricas mas pesadas (xid, WAL, percentiles)
	// solo aplican al perfil "full".
	if profile != "full" {
		return sample
	}

	// Backend xid age (alertas predictivas wraparound — max global)
	var xidAge int64
	if conn.QueryRow(pollCtx, `SELECT max(age(datfrozenxid))::bigint FROM pg_database`).Scan(&xidAge) == nil {
		sample.XidAge = &xidAge
	}

	// WAL bytes acumulados (contador absoluto desde startup; usar diff entre samples para tasa)
	var walBytes int64
	if conn.QueryRow(pollCtx, `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint`).Scan(&walBytes) == nil {
		sample.WalBytes = &walBytes
	}

	// Slow query percentiles via pg_stat_statements (si la extension esta disponible en este target)
	var hasStatStatements bool
	if conn.QueryRow(pollCtx, `SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')`).Scan(&hasStatStatements) == nil && hasStatStatements {
		var p50, p95, p99 *float64
		if conn.QueryRow(pollCtx, `
			SELECT
			  percentile_disc(0.5) WITHIN GROUP (ORDER BY mean_exec_time)::float8,
			  percentile_disc(0.95) WITHIN GROUP (ORDER BY mean_exec_time)::float8,
			  percentile_disc(0.99) WITHIN GROUP (ORDER BY mean_exec_time)::float8
			FROM pg_stat_statements
			WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
			  AND calls > 1
		`).Scan(&p50, &p95, &p99) == nil {
			sample.SlowQueryP50Ms = p50
			sample.SlowQueryP95Ms = p95
			sample.SlowQueryP99Ms = p99
		}
	}

	return sample
}

func collectRedisDB(ctx context.Context, addr, password string) models.DatabaseSample {
	sample := models.DatabaseSample{OK: true}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))

	r := bufio.NewReader(conn)

	if password != "" {
		fmt.Fprintf(conn, "*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n", len(password), password)
		line, err := r.ReadString('\n')
		if err != nil || !strings.HasPrefix(strings.TrimSpace(line), "+OK") {
			return models.DatabaseSample{OK: false, ErrorMessage: "Redis AUTH failed"}
		}
	}

	fmt.Fprintf(conn, "*1\r\n$4\r\nINFO\r\n")
	// Bulk string header: $<length>\r\n
	header, err := r.ReadString('\n')
	if err != nil || !strings.HasPrefix(header, "$") {
		return models.DatabaseSample{OK: false, ErrorMessage: "unexpected Redis INFO response"}
	}
	length, err := strconv.Atoi(strings.TrimSpace(header[1:]))
	if err != nil || length <= 0 {
		return models.DatabaseSample{OK: false, ErrorMessage: "bad Redis bulk string length"}
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: "failed reading Redis INFO"}
	}

	info := make(map[string]string)
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if parts := strings.SplitN(line, ":", 2); len(parts) == 2 {
			info[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
		}
	}

	if v, ok := info["connected_clients"]; ok {
		n, _ := strconv.Atoi(v)
		sample.ConnectedClients = &n
	}
	if v, ok := info["used_memory"]; ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			sample.MemoryUsedBytes = &n
		}
	}
	if v, ok := info["maxmemory"]; ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			sample.MemoryMaxBytes = &n
		}
	}
	if v, ok := info["instantaneous_ops_per_sec"]; ok {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			sample.OpsPerSec = &f
		}
	}
	if v, ok := info["keyspace_hits"]; ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			sample.KeyspaceHits = &n
		}
	}
	if v, ok := info["keyspace_misses"]; ok {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			sample.KeyspaceMisses = &n
		}
	}

	return sample
}

// DBTargetsSummary returns aggregate counts used by the dashboard overview.
// Returns zero values if the db_targets table doesn't exist yet.
func (s *Store) DBTargetsSummary(ctx context.Context) map[string]any {
	row := s.pool.QueryRow(ctx, `
		SELECT
		  count(*)::int                                                   AS total,
		  count(*) FILTER (WHERE enabled = true)::int                    AS enabled,
		  count(*) FILTER (WHERE enabled = true AND last_ok = true)::int  AS ok,
		  count(*) FILTER (WHERE enabled = true AND last_ok = false)::int AS err,
		  count(*) FILTER (WHERE type = 'postgres')::int                  AS pg_count,
		  count(*) FILTER (WHERE type = 'redis')::int                     AS redis_count
		FROM (
		  SELECT t.enabled, t.type,
		    (SELECT s.ok FROM db_samples s WHERE s.target_id = t.id ORDER BY s.captured_at DESC LIMIT 1) AS last_ok
		  FROM db_targets t
		) sub
	`)
	var total, enabled, ok, errCount, pgCount, redisCount int
	if err := row.Scan(&total, &enabled, &ok, &errCount, &pgCount, &redisCount); err != nil {
		return map[string]any{"total": 0, "enabled": 0, "ok": 0, "error": 0, "pg_count": 0, "redis_count": 0}
	}
	return map[string]any{
		"total":       total,
		"enabled":     enabled,
		"ok":          ok,
		"error":       errCount,
		"pg_count":    pgCount,
		"redis_count": redisCount,
	}
}
