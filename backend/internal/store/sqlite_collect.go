package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	_ "modernc.org/sqlite"
)

// sqliteDSNToPath extrae el path del archivo desde un DSN tipo
//
//	sqlite:///abs/path/file.db
//	sqlite://./relative/file.db
//	/abs/path/file.db   (path directo)
func sqliteDSNToPath(raw string) (string, string, error) {
	// Caso path directo (sin scheme): retorna tal cual
	if !strings.Contains(raw, "://") {
		return raw, raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", err
	}
	if u.Scheme != "sqlite" && u.Scheme != "file" {
		return "", "", fmt.Errorf("scheme %q no soportado para SQLite", u.Scheme)
	}
	path := u.Path
	if u.Host != "" && u.Host != "localhost" {
		// sqlite://host/path no tiene sentido — interpretamos host+path como path relativo
		path = u.Host + u.Path
	}
	if path == "" {
		return "", "", fmt.Errorf("ruta de archivo vacía en DSN SQLite")
	}
	// Para abrir con modernc.org/sqlite usamos el path directo
	return path, path, nil
}

func collectSQLiteDB(ctx context.Context, raw string) models.DatabaseSample {
	sample := models.DatabaseSample{OK: true}
	pollCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	path, openArg, err := sqliteDSNToPath(raw)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}

	// Tamaño del archivo en disco (incluye -wal y -shm si existen)
	if st, err := os.Stat(path); err == nil {
		size := st.Size()
		if w, err := os.Stat(path + "-wal"); err == nil {
			size += w.Size()
		}
		if sh, err := os.Stat(path + "-shm"); err == nil {
			size += sh.Size()
		}
		sample.DBSizeBytes = &size
	}

	// Abrir en modo read-only para no contaminar el WAL del target
	dsn := openArg + "?mode=ro&_pragma=busy_timeout(2000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	if err := db.PingContext(pollCtx); err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}

	// PRAGMA page_count * page_size = tamaño lógico de la base
	var pageCount, pageSize int64
	_ = db.QueryRowContext(pollCtx, "PRAGMA page_count").Scan(&pageCount)
	_ = db.QueryRowContext(pollCtx, "PRAGMA page_size").Scan(&pageSize)
	if pageCount > 0 && pageSize > 0 {
		logical := pageCount * pageSize
		// Si no obtuvimos el tamaño en disco, usamos el lógico
		if sample.DBSizeBytes == nil {
			sample.DBSizeBytes = &logical
		}
	}

	// Conexiones: SQLite es embebido — siempre 1 conexión activa (la nuestra)
	one := 1
	zero := 0
	sample.ConnectionsActive = &one
	sample.ConnectionsTotal = &one
	sample.ConnectionsIdle = &zero
	sample.ConnectionsWaiting = &zero

	// Cache hit ratio: SQLite no expone uno directo. Usamos PRAGMA cache_stats si está disponible.
	// modernc.org/sqlite expone esto via funciones, no PRAGMA estándar — lo dejamos sin valor.

	// Locks: PRAGMA locking_mode + table count como contexto débil
	var freelist int64
	if db.QueryRowContext(pollCtx, "PRAGMA freelist_count").Scan(&freelist) == nil {
		// No tiene un campo dedicado; lo guardamos como bytes temporales (proxy de espacio "desperdiciado")
		bytes := freelist * pageSize
		sample.TempBytes = &bytes
	}

	return sample
}
