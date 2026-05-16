package store

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

// GetPGLiveInfo fetches live PostgreSQL server information: version, uptime,
// connections, XID wraparound age, oldest open transaction, checkpoint stats,
// sequences near overflow, and all databases sizes.
func (s *Store) GetPGLiveInfo(ctx context.Context, id string) (*models.PGLiveInfo, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("live info only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	info := &models.PGLiveInfo{}

	_ = conn.QueryRow(liveCtx, `SHOW server_version`).Scan(&info.Version)
	_ = conn.QueryRow(liveCtx, `SELECT current_database()`).Scan(&info.DBName)

	var startTime time.Time
	if conn.QueryRow(liveCtx, `SELECT pg_postmaster_start_time()`).Scan(&startTime) == nil {
		info.StartedAt = startTime.Format(time.RFC3339)
		info.UptimeSeconds = int64(time.Since(startTime).Seconds())
	}

	var maxConnStr string
	if conn.QueryRow(liveCtx, `SELECT current_setting('max_connections')`).Scan(&maxConnStr) == nil {
		info.MaxConnections, _ = strconv.Atoi(maxConnStr)
	}

	// XID wraparound risk (critical if > 1.5B, PG freezes at 2B)
	_ = conn.QueryRow(liveCtx, `SELECT max(age(datfrozenxid)) FROM pg_database`).Scan(&info.XidAge)

	// Oldest open transaction in ms
	_ = conn.QueryRow(liveCtx, `
		SELECT COALESCE(
			GREATEST(0, extract(epoch from max(now() - xact_start)) * 1000)::bigint, 0
		)
		FROM pg_stat_activity
		WHERE xact_start IS NOT NULL AND pid != pg_backend_pid()
	`).Scan(&info.OldestXactMs)

	// Checkpoint stats
	_ = conn.QueryRow(liveCtx, `
		SELECT checkpoints_timed, checkpoints_req, buffers_clean, buffers_backend
		FROM pg_stat_bgwriter
	`).Scan(&info.Checkpoints.Timed, &info.Checkpoints.Requested,
		&info.Checkpoints.BuffersClean, &info.Checkpoints.BuffersBackend)

	// All databases by size
	dbRows, qErr := conn.Query(liveCtx, `
		SELECT datname, pg_database_size(datname)::bigint
		FROM pg_database
		WHERE datname NOT IN ('template0', 'template1')
		  AND datallowconn = true
		ORDER BY pg_database_size(datname) DESC
		LIMIT 10
	`)
	if qErr == nil {
		defer dbRows.Close()
		for dbRows.Next() {
			var d models.DBSize
			if dbRows.Scan(&d.Name, &d.Bytes) == nil {
				info.Databases = append(info.Databases, d)
			}
		}
	}

	// Sequences > 50% used (via pg_sequences view, available since PG 10)
	seqRows, seqErr := conn.Query(liveCtx, `
		SELECT schemaname, sequencename,
		       COALESCE(last_value, 0) as current_val,
		       max_value,
		       ROUND(100.0 * COALESCE(last_value, 0) / NULLIF(max_value, 0), 2) as pct
		FROM pg_sequences
		WHERE max_value > 0
		  AND COALESCE(last_value, 0) > 0
		  AND 100.0 * COALESCE(last_value, 0) / max_value > 50
		ORDER BY 5 DESC
		LIMIT 10
	`)
	if seqErr == nil {
		defer seqRows.Close()
		for seqRows.Next() {
			var sq models.SequenceInfo
			if seqRows.Scan(&sq.Schema, &sq.Name, &sq.Current, &sq.Max, &sq.PctUsed) == nil {
				info.Sequences = append(info.Sequences, sq)
			}
		}
	}

	return info, nil
}

// GetVacuumStats returns vacuum/bloat info for all user tables, ordered by dead tuples.
func (s *Store) GetVacuumStats(ctx context.Context, id string) ([]models.VacuumStat, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("vacuum stats only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	rows, err := conn.Query(liveCtx, `
		SELECT
			schemaname, relname,
			COALESCE(n_live_tup, 0),
			COALESCE(n_dead_tup, 0),
			CASE WHEN n_live_tup + n_dead_tup > 0
			     THEN ROUND(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2)
			     ELSE 0 END AS bloat_pct,
			COALESCE(to_char(GREATEST(last_vacuum, last_autovacuum), 'YYYY-MM-DD HH24:MI'), '') AS last_vacuum,
			COALESCE(to_char(GREATEST(last_analyze, last_autoanalyze), 'YYYY-MM-DD HH24:MI'), '') AS last_analyze,
			COALESCE(vacuum_count + autovacuum_count, 0),
			COALESCE(analyze_count + autoanalyze_count, 0)
		FROM pg_stat_user_tables
		ORDER BY n_dead_tup DESC, n_live_tup DESC
		LIMIT 25
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := []models.VacuumStat{}
	for rows.Next() {
		var v models.VacuumStat
		if rows.Scan(&v.Schema, &v.Table, &v.LiveTuples, &v.DeadTuples,
			&v.BloatPct, &v.LastVacuum, &v.LastAnalyze,
			&v.VacuumCount, &v.AnalyzeCount) == nil {
			stats = append(stats, v)
		}
	}
	return stats, rows.Err()
}

// GetIndexUsage returns all non-PK indexes ordered by scan count ascending
// (unused indexes first), useful to identify candidates for removal.
func (s *Store) GetIndexUsage(ctx context.Context, id string) ([]models.IndexUsage, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("index usage only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	rows, err := conn.Query(liveCtx, `
		SELECT
			s.schemaname,
			s.relname AS table_name,
			s.indexrelname AS index_name,
			s.idx_scan,
			pg_relation_size(s.indexrelid) AS index_bytes,
			ix.indisunique
		FROM pg_stat_user_indexes s
		JOIN pg_index ix ON ix.indexrelid = s.indexrelid
		WHERE NOT ix.indisprimary
		ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
		LIMIT 30
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	indexes := []models.IndexUsage{}
	for rows.Next() {
		var idx models.IndexUsage
		if rows.Scan(&idx.Schema, &idx.Table, &idx.Index,
			&idx.Scans, &idx.SizeBytes, &idx.IsUnique) == nil {
			indexes = append(indexes, idx)
		}
	}
	return indexes, rows.Err()
}

// GetSlowQueries queries pg_stat_statements for the top 15 slowest queries.
// Returns empty slice with no error if the extension is not installed.
func (s *Store) GetSlowQueries(ctx context.Context, id string) ([]models.SlowQuery, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("slow queries only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	// PG 13+ uses total_exec_time; PG 10–12 uses total_time
	const qNew = `
		SELECT left(query, 200), calls,
		       total_exec_time, mean_exec_time, max_exec_time, rows,
		       CASE WHEN shared_blks_hit + shared_blks_read > 0
		            THEN ROUND(100.0 * shared_blks_hit / (shared_blks_hit + shared_blks_read), 2)
		            ELSE 100 END
		FROM pg_stat_statements
		WHERE query NOT LIKE '%pg_stat_statements%'
		  AND query NOT LIKE 'BEGIN%' AND query NOT LIKE 'COMMIT%'
		ORDER BY total_exec_time DESC LIMIT 15`

	const qOld = `
		SELECT left(query, 200), calls,
		       total_time, mean_time, max_time, rows,
		       CASE WHEN shared_blks_hit + shared_blks_read > 0
		            THEN ROUND(100.0 * shared_blks_hit / (shared_blks_hit + shared_blks_read), 2)
		            ELSE 100 END
		FROM pg_stat_statements
		WHERE query NOT LIKE '%pg_stat_statements%'
		  AND query NOT LIKE 'BEGIN%' AND query NOT LIKE 'COMMIT%'
		ORDER BY total_time DESC LIMIT 15`

	rows, qErr := conn.Query(liveCtx, qNew)
	if qErr != nil {
		rows, qErr = conn.Query(liveCtx, qOld)
	}
	if qErr != nil {
		// Extension not installed — return empty, not an error
		return []models.SlowQuery{}, nil
	}
	defer rows.Close()

	queries := []models.SlowQuery{}
	for rows.Next() {
		var q models.SlowQuery
		if rows.Scan(&q.Query, &q.Calls, &q.TotalMs, &q.MeanMs, &q.MaxMs, &q.Rows, &q.CacheHitPct) == nil {
			queries = append(queries, q)
		}
	}
	return queries, rows.Err()
}

// GetRedisLiveInfo opens a connection to a Redis target and fetches extended
// metrics: fragmentation ratio, evicted/expired keys, blocked clients, role, keyspace.
func (s *Store) GetRedisLiveInfo(ctx context.Context, id string) (*models.RedisLiveInfo, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "redis" {
		return nil, fmt.Errorf("redis live info only available for redis targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(liveCtx, "tcp", t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(8 * time.Second))

	r := bufio.NewReader(conn)

	if pw := t.Params["password"]; pw != "" {
		fmt.Fprintf(conn, "*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n", len(pw), pw)
		line, err := r.ReadString('\n')
		if err != nil || !strings.HasPrefix(strings.TrimSpace(line), "+OK") {
			return nil, fmt.Errorf("Redis AUTH failed")
		}
	}

	fmt.Fprintf(conn, "*1\r\n$4\r\nINFO\r\n")
	header, err := r.ReadString('\n')
	if err != nil || !strings.HasPrefix(header, "$") {
		return nil, fmt.Errorf("unexpected Redis INFO response")
	}
	length, err := strconv.Atoi(strings.TrimSpace(header[1:]))
	if err != nil || length <= 0 {
		return nil, fmt.Errorf("bad Redis INFO response length")
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("failed reading Redis INFO")
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

	result := &models.RedisLiveInfo{}

	if v, ok := info["mem_fragmentation_ratio"]; ok {
		result.FragRatio, _ = strconv.ParseFloat(v, 64)
	}
	if v, ok := info["evicted_keys"]; ok {
		result.EvictedKeys, _ = strconv.ParseInt(v, 10, 64)
	}
	if v, ok := info["expired_keys"]; ok {
		result.ExpiredKeys, _ = strconv.ParseInt(v, 10, 64)
	}
	if v, ok := info["blocked_clients"]; ok {
		n, _ := strconv.Atoi(v)
		result.BlockedClients = n
	}
	if v, ok := info["uptime_in_seconds"]; ok {
		result.UptimeSeconds, _ = strconv.ParseInt(v, 10, 64)
	}
	if v, ok := info["role"]; ok {
		result.Role = v
	}

	// Parse keyspace section: db0:keys=10,expires=2,avg_ttl=0
	for k, v := range info {
		if !strings.HasPrefix(k, "db") {
			continue
		}
		kv := models.RedisKeyspace{DB: k}
		for _, part := range strings.Split(v, ",") {
			if p := strings.SplitN(part, "=", 2); len(p) == 2 {
				switch p[0] {
				case "keys":
					kv.Keys, _ = strconv.ParseInt(p[1], 10, 64)
				case "expires":
					kv.Expires, _ = strconv.ParseInt(p[1], 10, 64)
				}
			}
		}
		result.Keyspace = append(result.Keyspace, kv)
	}

	return result, nil
}

// TestConnection attempts to open a connection to the given DSN/type combination
// and returns the round-trip duration. Returns (0, error) on failure.
func TestConnection(ctx context.Context, dbType, dsn string, params map[string]string) (int64, error) {
	start := time.Now()
	switch dbType {
	case "postgres":
		testCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		conn, err := pgx.Connect(testCtx, dsn)
		if err != nil {
			return 0, err
		}
		var v string
		_ = conn.QueryRow(testCtx, "SHOW server_version").Scan(&v)
		conn.Close(testCtx)
	case "redis":
		d := net.Dialer{Timeout: 5 * time.Second}
		conn, err := d.DialContext(ctx, "tcp", dsn)
		if err != nil {
			return 0, err
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		if pw := params["password"]; pw != "" {
			r := bufio.NewReader(conn)
			fmt.Fprintf(conn, "*2\r\n$4\r\nAUTH\r\n$%d\r\n%s\r\n", len(pw), pw)
			line, authErr := r.ReadString('\n')
			if authErr != nil || !strings.HasPrefix(strings.TrimSpace(line), "+OK") {
				return 0, fmt.Errorf("authentication failed")
			}
		}
	case "mysql", "mariadb":
		// Reusa el collector para validar — no nos interesa el sample, solo el ping
		s := collectMySQLDB(ctx, dsn, "basic")
		if !s.OK {
			return 0, fmt.Errorf("%s", s.ErrorMessage)
		}
	case "sqlite":
		s := collectSQLiteDB(ctx, dsn)
		if !s.OK {
			return 0, fmt.Errorf("%s", s.ErrorMessage)
		}
	case "mongodb":
		s := collectMongoDB(ctx, dsn, "basic")
		if !s.OK {
			return 0, fmt.Errorf("%s", s.ErrorMessage)
		}
	default:
		return 0, fmt.Errorf("unsupported type: %s", dbType)
	}
	return time.Since(start).Milliseconds(), nil
}

// GetActiveQueries returns currently active (non-idle) queries on the target.
func (s *Store) GetActiveQueries(ctx context.Context, id string) ([]models.ActiveQuery, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("active queries only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	rows, err := conn.Query(liveCtx, `
		SELECT pid,
		       COALESCE(state, 'unknown') AS state,
		       COALESCE(left(query, 300), '') AS query,
		       COALESCE(
		           EXTRACT(EPOCH FROM (now() - query_start)) * 1000,
		           0
		       )::bigint AS duration_ms,
		       COALESCE(
		           CASE WHEN wait_event_type IS NOT NULL
		                THEN wait_event_type || ':' || COALESCE(wait_event, '')
		                ELSE '' END,
		           ''
		       ) AS wait_event,
		       COALESCE(application_name, '') AS app_name,
		       COALESCE(usename, '') AS user_name,
		       COALESCE(client_addr::text, 'local') AS client_addr,
		       COALESCE(datname, '') AS database,
		       COALESCE(
		           EXTRACT(EPOCH FROM (now() - backend_start)) * 1000,
		           0
		       )::bigint AS backend_age_ms
		FROM pg_stat_activity
		WHERE state IS NOT NULL
		  AND pid != pg_backend_pid()
		ORDER BY
		  CASE state
		    WHEN 'active'                    THEN 1
		    WHEN 'idle in transaction'       THEN 2
		    WHEN 'idle in transaction (aborted)' THEN 3
		    ELSE 4
		  END,
		  query_start ASC NULLS LAST
		LIMIT 100
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	queries := []models.ActiveQuery{}
	for rows.Next() {
		var q models.ActiveQuery
		if rows.Scan(&q.PID, &q.State, &q.Query, &q.DurationMs, &q.WaitEvent,
			&q.AppName, &q.UserName, &q.ClientAddr, &q.Database, &q.BackendAgeMs) == nil {
			queries = append(queries, q)
		}
	}
	return queries, rows.Err()
}

// GetTableSizes returns the top tables by total size.
func (s *Store) GetTableSizes(ctx context.Context, id string) ([]models.TableSize, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("table sizes only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	rows, err := conn.Query(liveCtx, `
		SELECT
		    schemaname,
		    tablename,
		    pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)) AS total_bytes,
		    pg_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)) AS table_bytes,
		    pg_indexes_size(quote_ident(schemaname)||'.'||quote_ident(tablename)) AS index_bytes
		FROM pg_tables
		WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
		ORDER BY total_bytes DESC
		LIMIT 15
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sizes := []models.TableSize{}
	for rows.Next() {
		var sz models.TableSize
		if rows.Scan(&sz.Schema, &sz.Table, &sz.TotalBytes, &sz.TableBytes, &sz.IndexBytes) == nil {
			sizes = append(sizes, sz)
		}
	}
	return sizes, rows.Err()
}

// GetPGReplication returns replication standby info from pg_stat_replication.
// Returns an empty slice (not an error) if this server has no standbys.
func (s *Store) GetPGReplication(ctx context.Context, id string) ([]models.PGReplicaInfo, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if t.Type != "postgres" {
		return nil, fmt.Errorf("replication only available for postgres targets")
	}

	liveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, err := pgx.Connect(liveCtx, t.DSN)
	if err != nil {
		return nil, err
	}
	defer conn.Close(liveCtx)

	rows, err := conn.Query(liveCtx, `
		SELECT
		  COALESCE(application_name, ''),
		  COALESCE(client_addr::text, ''),
		  COALESCE(state, ''),
		  COALESCE(sync_state, ''),
		  COALESCE(
		    EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))::bigint * 1000,
		    0
		  )::bigint AS replay_lag_ms,
		  COALESCE(
		    (pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) / 1024)::bigint,
		    0
		  )::bigint AS sent_lag_kb,
		  COALESCE(
		    (pg_wal_lsn_diff(sent_lsn, replay_lsn) / 1024)::bigint,
		    0
		  )::bigint AS apply_lag_kb
		FROM pg_stat_replication
		ORDER BY application_name
	`)
	if err != nil {
		// Not a primary or no permissions — return empty slice
		return []models.PGReplicaInfo{}, nil
	}
	defer rows.Close()

	replicas := []models.PGReplicaInfo{}
	for rows.Next() {
		var r models.PGReplicaInfo
		if rows.Scan(&r.AppName, &r.ClientAddr, &r.State, &r.SyncState, &r.ReplayLagMs, &r.SentLagKB, &r.ApplyLagKB) == nil {
			replicas = append(replicas, r)
		}
	}
	return replicas, rows.Err()
}
