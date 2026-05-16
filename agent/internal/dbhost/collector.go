package dbhost

import (
	"context"
	"time"

	"resource-monitor/agent/internal/client"
)

// State guarda contadores acumulativos entre samples para calcular deltas
// (OOM kills, I/O ops/bytes) y el cursor del log tail. Vive en el runtime.
type State struct {
	PrevOOMKills      int64
	PrevIOReadOps     int64
	PrevIOWriteOps    int64
	PrevIOReadBytes   int64
	PrevIOWriteBytes  int64
	LogCursor         int64  // offset en bytes dentro del log file
	LogInode          uint64 // detectar rotacion
	PrevPGCPUTicks    uint64 // ticks acumulados de CPU del proceso PG
	PrevSampleAt      time.Time
}

// Collect produce un sample del host BD usando el estado previo para
// calcular deltas. Implementacion platform-specific.
func Collect(ctx context.Context, det Detected, st *State, logPath string) client.DBHostSample {
	return collect(ctx, det, st, logPath)
}
