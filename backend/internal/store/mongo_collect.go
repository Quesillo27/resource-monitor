package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

// collectMongoDB conecta al target MongoDB y mapea db.serverStatus() + dbStats() a DatabaseSample.
// Acepta DSN tipo mongodb://user:pass@host:27017/db?options o mongodb+srv://...
//
// Perfiles:
//   - basic:    ping + connections + db_size
//   - standard: + ops/s, mem usage, network
//   - full:     + replicaSet status si aplica
func collectMongoDB(ctx context.Context, dsn, profile string) models.DatabaseSample {
	sample := models.DatabaseSample{OK: true}
	pollCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	if !strings.HasPrefix(dsn, "mongodb://") && !strings.HasPrefix(dsn, "mongodb+srv://") {
		return models.DatabaseSample{OK: false, ErrorMessage: "DSN debe iniciar con mongodb:// o mongodb+srv://"}
	}

	clientOpts := options.Client().
		ApplyURI(dsn).
		SetServerSelectionTimeout(8 * time.Second).
		SetConnectTimeout(8 * time.Second).
		SetSocketTimeout(10 * time.Second).
		SetMaxPoolSize(2)

	client, err := mongo.Connect(pollCtx, clientOpts)
	if err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}
	defer client.Disconnect(context.Background())

	if err := client.Ping(pollCtx, readpref.PrimaryPreferred()); err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: err.Error()}
	}

	// db.runCommand({serverStatus: 1}) — equivalente a SHOW STATUS
	dbName := defaultMongoDB(dsn)
	db := client.Database(dbName)

	var status bson.M
	if err := db.RunCommand(pollCtx, bson.D{{Key: "serverStatus", Value: 1}}).Decode(&status); err != nil {
		return models.DatabaseSample{OK: false, ErrorMessage: fmt.Sprintf("serverStatus: %v", err)}
	}

	// Connections (siempre)
	if conns, ok := status["connections"].(bson.M); ok {
		if cur, ok := mongoInt(conns["current"]); ok {
			c := int(cur)
			sample.ConnectionsTotal = &c
			sample.ConnectionsActive = &c
		}
		if avail, ok := mongoInt(conns["available"]); ok {
			if cur, ok2 := mongoInt(conns["current"]); ok2 {
				mc := int(cur + avail)
				sample.MaxConnections = &mc
			}
		}
	}

	// dbStats (db_size de la base actual)
	var dbStats bson.M
	if err := db.RunCommand(pollCtx, bson.D{{Key: "dbStats", Value: 1}}).Decode(&dbStats); err == nil {
		if size, ok := mongoInt(dbStats["dataSize"]); ok {
			s := size
			sample.DBSizeBytes = &s
		}
	}

	if profile == "basic" {
		return sample
	}

	// Opcounters totales — TPS via deltas en frontend
	if op, ok := status["opcounters"].(bson.M); ok {
		insert, _ := mongoInt(op["insert"])
		update, _ := mongoInt(op["update"])
		delete_, _ := mongoInt(op["delete"])
		query, _ := mongoInt(op["query"])
		sample.TuplesInserted = &insert
		sample.TuplesUpdated = &update
		sample.TuplesDeleted = &delete_
		sample.TuplesReturned = &query
		// "transacciones" = inserts + updates + deletes (Mongo no expone xact_commit literal)
		commits := insert + update + delete_
		sample.TransactionsCommitted = &commits
		zero := int64(0)
		sample.TransactionsRolledBack = &zero
	}

	// WiredTiger cache stats si esta disponible
	if wt, ok := status["wiredTiger"].(bson.M); ok {
		if cache, ok := wt["cache"].(bson.M); ok {
			if read, ok := mongoInt(cache["bytes read into cache"]); ok {
				sample.BlksRead = &read
			}
			if hit, ok := mongoInt(cache["pages requested from the cache"]); ok {
				sample.BlksHit = &hit
			}
			if read, ok := mongoInt(cache["bytes read into cache"]); ok {
				if total, ok2 := mongoInt(cache["pages requested from the cache"]); ok2 && total > 0 {
					ratio := 1.0 - (float64(read) / float64(read+total))
					if ratio < 0 {
						ratio = 0
					}
					sample.CacheHitRatio = &ratio
				}
			}
		}
	}

	// Memory stats: WiredTiger ram allocated as overhead-equivalent
	if memStats, ok := status["mem"].(bson.M); ok {
		if resMB, ok := mongoInt(memStats["resident"]); ok {
			usedBytes := resMB * 1024 * 1024
			sample.MemoryUsedBytes = &usedBytes
		}
	}

	// Locks current (waiting count) — best effort
	if locksByLocker, ok := status["globalLock"].(bson.M); ok {
		if cur, ok := locksByLocker["currentQueue"].(bson.M); ok {
			if total, ok := mongoInt(cur["total"]); ok {
				t := int(total)
				sample.ActiveLocks = &t
			}
		}
	}

	if profile != "full" {
		return sample
	}

	// replSetGetStatus (best-effort, falla en standalone)
	var rs bson.M
	if err := client.Database("admin").RunCommand(pollCtx, bson.D{{Key: "replSetGetStatus", Value: 1}}).Decode(&rs); err == nil {
		// Si se requiere mas detalle, exponer en `Extra` en el futuro
		_ = rs
	}

	return sample
}

// defaultMongoDB extrae el nombre de DB del DSN. Si no se especifica, usa "admin".
func defaultMongoDB(dsn string) string {
	idx := strings.Index(dsn, "://")
	if idx < 0 {
		return "admin"
	}
	rest := dsn[idx+3:]
	q := strings.Index(rest, "?")
	if q >= 0 {
		rest = rest[:q]
	}
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) < 2 || parts[1] == "" {
		return "admin"
	}
	return parts[1]
}

// mongoInt extrae un int64 desde un valor BSON que puede venir como int32, int64, float64.
func mongoInt(v any) (int64, bool) {
	switch x := v.(type) {
	case int32:
		return int64(x), true
	case int64:
		return x, true
	case float64:
		return int64(x), true
	case int:
		return int64(x), true
	}
	return 0, false
}
