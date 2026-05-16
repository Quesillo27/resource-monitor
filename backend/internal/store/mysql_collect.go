package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	_ "github.com/go-sql-driver/mysql"
)

// mysqlURLToDSN convierte mysql://user:pass@host:port/db?param=v al formato
// nativo de go-sql-driver: user:pass@tcp(host:port)/db?param=v.
// Acepta también mariadb://... como alias.
func mysqlURLToDSN(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		// Asume formato nativo del driver, lo dejamos pasar tal cual
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "mysql" && u.Scheme != "mariadb" {
		return "", fmt.Errorf("scheme %q no soportado para MySQL", u.Scheme)
	}
	host := u.Host
	if host == "" {
		host = "127.0.0.1:3306"
	} else if !strings.Contains(host, ":") {
		host += ":3306"
	}
	dbname := strings.TrimPrefix(u.Path, "/")
	auth := ""
	if u.User != nil {
		user := u.User.Username()
		if pass, ok := u.User.Password(); ok {
			auth = user + ":" + pass + "@"
		} else {
			auth = user + "@"
		}
	}
	dsn := fmt.Sprintf("%stcp(%s)/%s", auth, host, dbname)
	if q := u.RawQuery; q != "" {
		dsn += "?" + q
	}
	// Defaults razonables
	if !strings.Contains(dsn, "parseTime=") {
		if strings.Contains(dsn, "?") {
			dsn += "&parseTime=true"
		} else {
			dsn += "?parseTime=true"
		}
	}
	if !strings.Contains(dsn, "timeout=") {
		dsn += "&timeout=10s"
	}
	return dsn, nil
}

// status mapea SHOW GLOBAL STATUS a un map para lookups O(1).
func mysqlGlobalStatus(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, "SHOW GLOBAL STATUS")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]string, 400)
	for rows.Next() {
		var name, val string
		if err := rows.Scan(&name, &val); err == nil {
			out[name] = val
		}
	}
	return out, nil
}

func mysqlGlobalVars(ctx context.Context, db *sql.DB, names ...string) map[string]string {
	if len(names) == 0 {
		return nil
	}
	placeholders := make([]string, len(names))
	args := make([]any, len(names))
	for i, n := range names {
		placeholders[i] = "?"
		args[i] = n
	}
	q := "SHOW GLOBAL VARIABLES WHERE Variable_name IN (" + strings.Join(placeholders, ",") + ")"
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, val string
		if err := rows.Scan(&name, &val); err == nil {
			out[name] = val
		}
	}
	return out
}

func atoi64(s string) int64 {
	v, _ := strconv.ParseInt(s, 10, 64)
	return v
}

func atof64(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func collectMySQLDB(ctx context.Context, raw string) models.DatabaseSample {
	sample := models.DatabaseSample{OK: true}
	pollCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	dsn, err := mysqlURLToDSN(raw)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	defer db.Close()
	db.SetMaxOpenConns(2)
	db.SetConnMaxLifetime(15 * time.Second)

	if err := db.PingContext(pollCtx); err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}

	status, err := mysqlGlobalStatus(pollCtx, db)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}

	// Conexiones activas / total
	if v, ok := status["Threads_connected"]; ok {
		c := int(atoi64(v))
		sample.ConnectionsTotal = &c
	}
	if v, ok := status["Threads_running"]; ok {
		c := int(atoi64(v))
		sample.ConnectionsActive = &c
	}
	if total, idle := sample.ConnectionsTotal, sample.ConnectionsActive; total != nil && idle != nil {
		i := *total - *idle
		if i < 0 {
			i = 0
		}
		sample.ConnectionsIdle = &i
	}

	// max_connections
	vars := mysqlGlobalVars(pollCtx, db, "max_connections")
	if v, ok := vars["max_connections"]; ok {
		mc := int(atoi64(v))
		sample.MaxConnections = &mc
	}

	// TPS source: Com_commit + Com_rollback (totales acumulados)
	commits := atoi64(status["Com_commit"])
	rollbacks := atoi64(status["Com_rollback"])
	sample.TransactionsCommitted = &commits
	sample.TransactionsRolledBack = &rollbacks

	// Innodb buffer pool hit ratio: 1 - (reads/read_requests)
	bpReads := atof64(status["Innodb_buffer_pool_reads"])
	bpReadReqs := atof64(status["Innodb_buffer_pool_read_requests"])
	if bpReadReqs > 0 {
		ratio := 1.0 - (bpReads / bpReadReqs)
		if ratio < 0 {
			ratio = 0
		}
		sample.CacheHitRatio = &ratio
	}

	// Tuple-equivalent counters: Innodb_rows_*
	if v, ok := status["Innodb_rows_read"]; ok {
		x := atoi64(v)
		sample.TuplesReturned = &x
	}
	if v, ok := status["Innodb_rows_inserted"]; ok {
		x := atoi64(v)
		sample.TuplesInserted = &x
	}
	if v, ok := status["Innodb_rows_updated"]; ok {
		x := atoi64(v)
		sample.TuplesUpdated = &x
	}
	if v, ok := status["Innodb_rows_deleted"]; ok {
		x := atoi64(v)
		sample.TuplesDeleted = &x
	}

	// Created_tmp_disk_tables como proxy de temp_files
	if v, ok := status["Created_tmp_disk_tables"]; ok {
		x := atoi64(v)
		sample.TempFiles = &x
	}

	// Slow queries: contador acumulado de queries marcadas slow_query_log
	if v, ok := status["Slow_queries"]; ok {
		x := int(atoi64(v))
		sample.SlowQueries = &x
	}

	// Locks en espera (best-effort): InnoDB row locks waiting
	if v, ok := status["Innodb_row_lock_current_waits"]; ok {
		x := int(atoi64(v))
		sample.ActiveLocks = &x
	}
	// Connections waiting (kernel queue)
	if v, ok := status["Threads_cached"]; ok {
		_ = v // no lo usamos directamente; se podría exponer en extras
	}

	// Tamaño total de la base actual (si se especificó base en el DSN)
	var dbSize int64
	if err := db.QueryRowContext(pollCtx, `
		SELECT COALESCE(SUM(data_length + index_length), 0)
		FROM information_schema.tables
		WHERE table_schema = DATABASE()
	`).Scan(&dbSize); err == nil && dbSize > 0 {
		sample.DBSizeBytes = &dbSize
	}

	// Bytes leídos/escritos InnoDB → blks_read/hit como proxy
	if v, ok := status["Innodb_buffer_pool_reads"]; ok {
		x := atoi64(v)
		sample.BlksRead = &x
	}
	if v, ok := status["Innodb_buffer_pool_read_requests"]; ok {
		x := atoi64(v)
		sample.BlksHit = &x
	}

	return sample
}
