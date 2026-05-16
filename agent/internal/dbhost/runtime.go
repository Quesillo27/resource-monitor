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
// Termina cuando ctx se cancela. El polling de la BD se deja a F3 (cuando
// el agente toma el control sobre el manager); por ahora solo metricas de host.
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

	log.Printf("dbhost: arranque mode=db engine=%s datadir=%s log=%s pid=%d interval=%s",
		det.Engine, det.DataDir, logPath, det.PID, interval)

	// Primera muestra cubre baseline (deltas vendran desde la segunda)
	sample := Collect(ctx, det, state, logPath)
	if err := sendHeartbeat(ctx, api, det, sample); err != nil {
		log.Printf("dbhost: heartbeat inicial fallo: %v", err)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			s := Collect(ctx, det, state, logPath)
			if err := sendHeartbeat(ctx, api, det, s); err != nil {
				log.Printf("dbhost: heartbeat fallo: %v", err)
			}
		}
	}
}

func sendHeartbeat(ctx context.Context, api *client.Client, det Detected, sample client.DBHostSample) error {
	reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return api.DBHostHeartbeat(reqCtx, client.DBHostHeartbeatRequest{
		AgentVersion:  version.Version,
		EngineVersion: det.EngineVersion,
		Sample:        sample,
	})
}
