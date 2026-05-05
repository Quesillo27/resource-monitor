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
	return svc.Install()
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
		if err := send(ctx, cfg); err != nil {
			log.Printf("send metrics failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
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
	metrics, err := collector.Collect(ctx)
	if err != nil {
		return err
	}
	return api.SendMetrics(ctx, metrics)
}

func serviceConfig(configPath string) *service.Config {
	return &service.Config{
		Name:        serviceName,
		DisplayName: "Resource Monitor Agent",
		Description: "Collects CPU, memory, disk and host metrics for Resource Monitor.",
		Arguments:   []string{"service", "--config", configPath},
	}
}
