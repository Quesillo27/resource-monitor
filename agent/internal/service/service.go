package service

import (
	"context"
	"log"
	"time"

	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/collector"
	"resource-monitor/agent/internal/config"

	"github.com/kardianos/service"
)

const serviceName = "resource-monitor-agent"

type program struct {
	configPath string
	cancel     context.CancelFunc
}

func Install(configPath string) error {
	svc, err := service.New(&program{configPath: configPath}, serviceConfig(configPath))
	if err != nil {
		return err
	}
	if _, err := svc.Status(); err == nil {
		_ = svc.Stop()
		_ = svc.Uninstall()
	}
	if err := svc.Install(); err != nil {
		return err
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
	go p.run(ctx)
	return nil
}

func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	return nil
}

func (p *program) run(ctx context.Context) {
	cfg, err := config.Load(p.configPath)
	if err != nil {
		log.Printf("load config: %v", err)
		return
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 60
	}
	ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()

	for {
		sendWithRetry(ctx, cfg)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func sendWithRetry(ctx context.Context, cfg config.Config) {
	delays := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	for attempt, delay := range delays {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
		if err := send(ctx, cfg); err != nil {
			log.Printf("send metrics failed attempt=%d/%d: %v", attempt+1, len(delays), err)
			continue
		}
		return
	}
}

func send(ctx context.Context, cfg config.Config) error {
	info, err := collector.HostInfo()
	if err != nil {
		return err
	}
	if cfg.Name != "" {
		info.Name = cfg.Name
	}
	api := client.New(cfg.ServerURL, cfg.Credential)
	if err := api.Heartbeat(ctx, info); err != nil {
		return err
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

func serviceConfig(configPath string) *service.Config {
	return &service.Config{
		Name:        serviceName,
		DisplayName: "Resource Monitor Agent",
		Description: "Collects CPU, memory, disk and host metrics for Resource Monitor.",
		Arguments:   []string{"service", "--config", configPath},
	}
}

func Status(configPath string) (service.Status, error) {
	svc, err := service.New(&program{configPath: configPath}, serviceConfig(configPath))
	if err != nil {
		return service.StatusUnknown, err
	}
	return svc.Status()
}
