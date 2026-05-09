// Package runtime consolida el loop de envío de métricas, inventario y
// chequeo de versión. Es usado tanto por el comando "run" standalone como
// por el servicio (kardianos/service).
package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"resource-monitor/agent/internal/buffer"
	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/collector"
	"resource-monitor/agent/internal/config"
	"resource-monitor/agent/internal/updater"
	"resource-monitor/agent/internal/version"
)

// Run ejecuta el loop principal del agente hasta que ctx se cancele.
// Lanza tres rutinas paralelas: métricas, inventario, chequeo de updates.
// Llama a sendOfflineNotice al salir.
func Run(ctx context.Context, cfg config.Config) error {
	if cfg.Credential == "" {
		return errors.New("missing credential — re-run install with --enrollment-token")
	}

	var buf *buffer.Buffer
	bufDir := cfg.BufferDir
	if bufDir == "" {
		bufDir = config.DefaultBufferDir()
	}
	if b, err := buffer.New(bufDir); err == nil {
		buf = b
	} else {
		log.Printf("buffer disabled: %v", err)
	}

	go runInventoryLoop(ctx, cfg)
	go runUpdateCheck(ctx, cfg)
	go runMetricsLoop(ctx, cfg, buf)

	<-ctx.Done()

	// shutdown limpio: avisar al server para no esperar OFFLINE_AFTER_SECONDS.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	api := newClient(cfg)
	if err := api.SendOfflineNotice(shutdownCtx, "agent_shutdown"); err != nil {
		log.Printf("offline notice failed: %v", err)
	} else {
		log.Printf("offline notice sent")
	}
	return nil
}

func newClient(cfg config.Config) *client.Client {
	return client.NewWithTLS(cfg.ServerURL, cfg.Credential, cfg.InsecureSkipTLS)
}

func runMetricsLoop(ctx context.Context, cfg config.Config, buf *buffer.Buffer) {
	ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()

	for {
		sendWithRetry(ctx, cfg, buf)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runUpdateCheck(ctx context.Context, cfg config.Config) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	check := func() {
		latest, has, err := updater.CheckLatest(ctx, cfg.ServerURL, version.Version)
		if err == nil && has {
			log.Printf("update available: current=%s latest=%s", version.Version, latest)
		}
	}
	check()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func runInventoryLoop(ctx context.Context, cfg config.Config) {
	sendInventory(ctx, &cfg, true)
	// chequeo de cambio cada hora; envío forzado cada 24h
	tickChange := time.NewTicker(1 * time.Hour)
	defer tickChange.Stop()
	tick24h := time.NewTicker(24 * time.Hour)
	defer tick24h.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tickChange.C:
			sendInventory(ctx, &cfg, false)
		case <-tick24h.C:
			sendInventory(ctx, &cfg, true)
		}
	}
}

func sendInventory(ctx context.Context, cfg *config.Config, force bool) {
	if cfg.Credential == "" {
		return
	}
	inv := collector.Inventory{
		Hardware: collector.CollectHardware(),
		Software: collector.CollectSoftware(),
	}
	fingerprint := collector.InventoryFingerprint(inv)
	if !force && fingerprint != "" && fingerprint == cfg.InventoryFingerprint {
		return // sin cambios — no enviamos
	}
	api := newClient(*cfg)
	if err := api.SendInventory(ctx, inv); err != nil {
		log.Printf("inventory send failed: %v", err)
		return
	}
	log.Printf("inventory sent hardware=%s software=%d force=%v", inv.Hardware.CPUModel, len(inv.Software), force)
	if fingerprint != "" && fingerprint != cfg.InventoryFingerprint {
		cfg.InventoryFingerprint = fingerprint
		_ = config.Save(cfg.ConfigPath, *cfg)
	}
}

func sendWithRetry(ctx context.Context, cfg config.Config, buf *buffer.Buffer) {
	delays := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	var lastErr error
	for attempt, delay := range delays {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
		if err := sendOnce(ctx, cfg); err != nil {
			lastErr = err
			if errors.Is(err, client.ErrUnauthorized) {
				log.Printf("AUTH ERROR: %v — agent will keep retrying every %ds; reinstall on this host with a new --enrollment-token to recover", err, cfg.IntervalSeconds)
				return
			}
			log.Printf("send metrics failed attempt=%d/%d: %v", attempt+1, len(delays), err)
			continue
		}
		// éxito: drenar buffer offline si tiene algo pendiente
		drainBuffer(ctx, cfg, buf)
		return
	}
	// 3 intentos fallidos: persistir si tenemos buffer
	if buf != nil && lastErr != nil {
		bufferLatest(ctx, cfg, buf)
	}
}

func sendOnce(ctx context.Context, cfg config.Config) error {
	info, err := collector.HostInfo()
	if err != nil {
		return err
	}
	if cfg.Name != "" {
		info.Name = cfg.Name
	}
	info.AgentVersion = version.Version
	api := newClient(cfg)
	resp, err := api.HeartbeatWithCommands(ctx, info)
	if err != nil {
		return err
	}
	if resp != nil && len(resp.Commands) > 0 {
		go processCommands(cfg, resp.Commands)
	}
	metrics, err := collector.Collect(ctx, cfg.Profile, cfg.ServiceChecks)
	if err != nil {
		return err
	}
	if err := api.SendMetrics(ctx, metrics); err != nil {
		return err
	}
	return nil
}

// processCommands ejecuta los comandos enviados por el manager. Corre en
// goroutine para no bloquear el ciclo de métricas.
func processCommands(cfg config.Config, commands []client.AgentCommand) {
	api := newClient(cfg)
	for _, cmd := range commands {
		log.Printf("command received id=%s command=%s", cmd.ID, cmd.Command)
		ok, result, errMsg := runCommand(cfg, cmd)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if err := api.CompleteCommand(ctx, cmd.ID, ok, result, errMsg); err != nil {
			log.Printf("complete command %s failed: %v", cmd.ID, err)
		}
		cancel()
	}
}

func runCommand(cfg config.Config, cmd client.AgentCommand) (bool, map[string]any, string) {
	switch cmd.Command {
	case "update":
		return handleUpdateCommand(cfg)
	case "restart":
		// no-op explícito: el agente no se mata a sí mismo, deja que el
		// service manager lo reinicie cuando pierda contacto. Útil para
		// disparar un reload sin downtime real.
		return true, map[string]any{"action": "restart_acknowledged"}, ""
	case "ping":
		return true, map[string]any{"pong": time.Now().UTC().Format(time.RFC3339)}, ""
	default:
		return false, nil, "unknown command: " + cmd.Command
	}
}

func handleUpdateCommand(cfg config.Config) (bool, map[string]any, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	latest, has, err := updater.CheckLatest(ctx, cfg.ServerURL, version.Version)
	if err != nil {
		return false, nil, "check latest: " + err.Error()
	}
	if !has {
		return true, map[string]any{"current": version.Version, "latest": latest, "skipped": "already up to date"}, ""
	}
	tempBin, err := updater.SelfUpdate(ctx, cfg.ServerURL)
	if err != nil {
		return false, nil, "self-update: " + err.Error()
	}
	log.Printf("self-update applied: %s -> %s (temp=%s)", version.Version, latest, tempBin)
	// En Linux disparar restart explícito (en Windows el helper lo hace).
	if err := updater.RestartLinuxService(ctx); err == nil {
		log.Printf("systemctl restart issued")
	}
	return true, map[string]any{"from": version.Version, "to": latest}, ""
}

func bufferLatest(ctx context.Context, cfg config.Config, buf *buffer.Buffer) {
	info, err := collector.HostInfo()
	if err != nil {
		return
	}
	if cfg.Name != "" {
		info.Name = cfg.Name
	}
	metrics, err := collector.Collect(ctx, cfg.Profile, cfg.ServiceChecks)
	if err != nil {
		return
	}
	if err := buf.Append("heartbeat", info); err != nil {
		log.Printf("buffer append heartbeat: %v", err)
	}
	if err := buf.Append("metrics", metrics); err != nil {
		log.Printf("buffer append metrics: %v", err)
	}
	log.Printf("server unreachable — sample buffered (pending=%d)", buf.Count())
}

func drainBuffer(ctx context.Context, cfg config.Config, buf *buffer.Buffer) {
	if buf == nil || buf.Count() == 0 {
		return
	}
	api := newClient(cfg)
	count := 0
	err := buf.Drain(ctx, func(e buffer.Entry) error {
		switch e.Kind {
		case "heartbeat":
			var h collector.Host
			if err := json.Unmarshal(e.Payload, &h); err != nil {
				return nil
			}
			if err := api.Heartbeat(ctx, h); err != nil {
				return err
			}
		case "metrics":
			var m collector.Metrics
			if err := json.Unmarshal(e.Payload, &m); err != nil {
				return nil
			}
			if err := api.SendMetrics(ctx, m); err != nil {
				return err
			}
		case "inventory":
			var inv collector.Inventory
			if err := json.Unmarshal(e.Payload, &inv); err != nil {
				return nil
			}
			if err := api.SendInventory(ctx, inv); err != nil {
				return err
			}
		}
		count++
		return nil
	})
	if err != nil {
		log.Printf("drain buffer paused (pending=%d): %v", buf.Count(), err)
	} else if count > 0 {
		log.Printf("buffer drained: %d entries reenviadas", count)
	}
}
