package service

import (
	"context"
	"log"
	"time"

	"resource-monitor/agent/internal/config"
	"resource-monitor/agent/internal/dbhost"
	agentruntime "resource-monitor/agent/internal/runtime"

	"github.com/kardianos/service"
)

const serviceName = "resource-monitor-agent"

type program struct {
	configPath string
	cancel     context.CancelFunc
	done       chan struct{}
}

func Install(configPath string) error {
	cfg := serviceConfig(configPath)
	svc, err := service.New(&program{configPath: configPath}, cfg)
	if err != nil {
		return err
	}
	if _, err := svc.Status(); err == nil {
		_ = svc.Stop()
		_ = svc.Uninstall()
	}
	// Recreate svc to release Windows SCM handles before installing.
	// On Windows, DeleteService marks for deletion until all handles close;
	// a fresh svc object ensures Install() doesn't race the deletion.
	var installErr error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Second)
		}
		svc, err = service.New(&program{configPath: configPath}, cfg)
		if err != nil {
			return err
		}
		if installErr = svc.Install(); installErr == nil {
			break
		}
	}
	if installErr != nil {
		return installErr
	}
	return svc.Start()
}

func Uninstall(configPath string) error {
	svc, err := service.New(&program{configPath: configPath}, serviceConfig(configPath))
	if err != nil {
		return err
	}
	_ = svc.Stop()
	return svc.Uninstall()
}

func Run(configPath string) error {
	svc, err := service.New(&program{configPath: configPath}, serviceConfig(configPath))
	if err != nil {
		return err
	}
	return svc.Run()
}

func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go func() {
		defer close(p.done)
		p.run(ctx)
	}()
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	if p.done != nil {
		// dejar margen para que runtime.Run envíe el offline notice
		select {
		case <-p.done:
		case <-time.After(8 * time.Second):
		}
	}
	return nil
}

func (p *program) run(ctx context.Context) {
	cfg, err := config.Load(p.configPath)
	if err != nil {
		log.Printf("load config: %v", err)
		return
	}
	if cfg.IntervalSeconds < config.MinIntervalSeconds {
		cfg.IntervalSeconds = config.MinIntervalSeconds
	}
	if cfg.Mode == "db" {
		if err := dbhost.Run(ctx, cfg); err != nil {
			log.Printf("dbhost runtime exited: %v", err)
		}
		return
	}
	if err := agentruntime.Run(ctx, cfg); err != nil {
		log.Printf("agent runtime exited: %v", err)
	}
}

// serviceConfig configura el servicio nativo (systemd/SCM/launchd) con
// auto-restart en caso de crash. systemd usa Restart=always (default) con
// RestartSec=120 hardcoded en kardianos; Windows usa OnFailure=restart con
// delay de 10s y reset de errores cada 60s.
func serviceConfig(configPath string) *service.Config {
	return &service.Config{
		Name:        serviceName,
		DisplayName: "Resource Monitor Agent",
		Description: "Collects CPU, memory, disk and host metrics for Resource Monitor.",
		Arguments:   []string{"service", "--config", configPath},
		Option: service.KeyValue{
			"Restart":                "always",
			"SuccessExitStatus":      "0",
			"LogOutput":              true,
			"OnFailure":              "restart",
			"OnFailureDelayDuration": "10s",
			"OnFailureResetPeriod":   60,
		},
	}
}

func Status(configPath string) (service.Status, error) {
	svc, err := service.New(&program{configPath: configPath}, serviceConfig(configPath))
	if err != nil {
		return service.StatusUnknown, err
	}
	return svc.Status()
}
