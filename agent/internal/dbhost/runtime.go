package dbhost

import (
	"context"
	"log"
	"time"

	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/config"
	"resource-monitor/agent/internal/version"
)

// Run ejecuta el bucle del modo "agente de BD": detecta motor, conecta al
// server con la credencial guardada y emite samples cada IntervalSeconds.
// Termina cuando ctx se cancela.
//
// El sample del host (FS, I/O, OOM, log, proceso) se envia siempre.
// Adicionalmente, si engine==postgres y hay DSN local resuelto, recolecta
// metricas de la BD localmente y las manda en el mismo heartbeat — el
// backend las persiste como sample del db_target y el manager skip su
// polling remoto (F3).
func Run(ctx context.Context, cfg config.Config) error {
	det, err := Detect(cfg.Engine)
	if err != nil {
		log.Printf("dbhost: detector fallo: %v (engine=%q)", err, cfg.Engine)
		// Continuamos con lo configurado en cfg como fallback.
		det = Detected{Engine: cfg.Engine, DataDir: cfg.DataDir, LogPath: cfg.LogPath}
	}
	if cfg.DataDir != "" {
		det.DataDir = cfg.DataDir
	}
	if cfg.LogPath != "" {
		det.LogPath = cfg.LogPath
	}
	logPath := det.LogPath
	if logPath == "" {
		logPath = cfg.LogPath
	}

	api := client.NewWithTLS(cfg.ServerURL, cfg.Credential, cfg.InsecureSkipTLS)
	state := &State{}

	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	if interval < 10*time.Second {
		interval = 10 * time.Second
	}

	log.Printf("dbhost: arranque mode=db engine=%s datadir=%s log=%s pid=%d interval=%s db_local=%v",
		det.Engine, det.DataDir, logPath, det.PID, interval, cfg.DBLocalDSN != "" || det.Engine == "postgres")

	// Primera muestra cubre baseline (deltas vendran desde la segunda)
	hostSample := Collect(ctx, det, state, logPath)
	dbSample := CollectDBSample(ctx, det.Engine, cfg.DBLocalDSN)
	if err := sendHeartbeat(ctx, api, det, hostSample, dbSample); err != nil {
		log.Printf("dbhost: heartbeat inicial fallo: %v", err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			hostSample := Collect(ctx, det, state, logPath)
			dbSample := CollectDBSample(ctx, det.Engine, cfg.DBLocalDSN)
			if err := sendHeartbeat(ctx, api, det, hostSample, dbSample); err != nil {
				log.Printf("dbhost: heartbeat fallo: %v", err)
			}
		}
	}
}

func sendHeartbeat(ctx context.Context, api *client.Client, det Detected, hostSample client.DBHostSample, dbSample *client.DatabaseSample) error {
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return api.DBHostHeartbeat(reqCtx, client.DBHostHeartbeatRequest{
		AgentVersion:  version.Version,
		EngineVersion: det.EngineVersion,
		Sample:        hostSample,
		DBSample:      dbSample,
	})
}
