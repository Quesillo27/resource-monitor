package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/collector"
	"resource-monitor/agent/internal/config"
	agentservice "resource-monitor/agent/internal/service"
)

func main() {
	if len(os.Args) < 2 {
		runCmd(os.Args[1:])
		return
	}

	switch os.Args[1] {
	case "install":
		installCmd(os.Args[2:])
	case "uninstall":
		uninstallCmd(os.Args[2:])
	case "service":
		serviceCmd(os.Args[2:])
	case "run":
		runCmd(os.Args[2:])
	case "once":
		onceCmd(os.Args[2:])
	default:
		runCmd(os.Args[1:])
	}
}

func installCmd(args []string) {
	fs, cfg := commonFlags("install")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	if cfg.ServerURL == "" {
		log.Fatal("--server-url is required")
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 60
	}

	path := cfg.ConfigPath
	if path == "" {
		path = config.DefaultServiceConfigPath()
	}
	cfg.ConfigPath = path

	if cfg.Credential == "" && cfg.EnrollmentToken != "" {
		if err := registerAndSave(&cfg, path); err != nil {
			log.Fatalf("register agent: %v", err)
		}
	} else if err := config.Save(path, cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	if err := agentservice.Install(path); err != nil {
		log.Fatalf("install service: %v", err)
	}
	fmt.Printf("resource monitor agent installed with config %s\n", path)
}

func uninstallCmd(args []string) {
	fs := flag.NewFlagSet("uninstall", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultServiceConfigPath(), "config file path")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	if err := agentservice.Uninstall(*configPath); err != nil {
		log.Fatalf("uninstall service: %v", err)
	}
	fmt.Println("resource monitor agent uninstalled")
}

func serviceCmd(args []string) {
	fs := flag.NewFlagSet("service", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultServiceConfigPath(), "config file path")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	if err := agentservice.Run(*configPath); err != nil {
		log.Fatalf("run service: %v", err)
	}
}

func runCmd(args []string) {
	fs, cfg := commonFlags("run")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}

	loaded, err := config.LoadWithOverrides(cfg)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if loaded.IntervalSeconds <= 0 {
		loaded.IntervalSeconds = 60
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := runLoop(ctx, loaded); err != nil {
		log.Fatal(err)
	}
}

func onceCmd(args []string) {
	fs, cfg := commonFlags("once")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	loaded, err := config.LoadWithOverrides(cfg)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if loaded.Credential == "" && loaded.EnrollmentToken != "" {
		if err := registerAndSave(&loaded, loaded.ConfigPath); err != nil {
			log.Fatalf("register agent: %v", err)
		}
	}
	if err := sendOnce(context.Background(), loaded); err != nil {
		log.Fatal(err)
	}
	fmt.Println("metrics sent")
}

func commonFlags(name string) (*flag.FlagSet, config.Config) {
	var cfg config.Config
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	fs.StringVar(&cfg.ConfigPath, "config", "", "config file path")
	fs.StringVar(&cfg.ServerURL, "server-url", "", "central server URL")
	fs.StringVar(&cfg.EnrollmentToken, "enrollment-token", "", "one-time enrollment token")
	fs.StringVar(&cfg.Credential, "credential", "", "agent credential")
	fs.StringVar(&cfg.Name, "name", "", "agent display name")
	fs.IntVar(&cfg.IntervalSeconds, "interval", 0, "collection interval in seconds")
	return fs, cfg
}

func runLoop(ctx context.Context, cfg config.Config) error {
	if cfg.Credential == "" && cfg.EnrollmentToken != "" {
		if err := registerAndSave(&cfg, cfg.ConfigPath); err != nil {
			return err
		}
	}
	if cfg.Credential == "" {
		return fmt.Errorf("missing credential or enrollment token")
	}

	ticker := time.NewTicker(time.Duration(cfg.IntervalSeconds) * time.Second)
	defer ticker.Stop()

	for {
		if err := sendOnce(ctx, cfg); err != nil {
			log.Printf("send metrics failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
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

func registerAndSave(cfg *config.Config, path string) error {
	info, err := collector.HostInfo()
	if err != nil {
		return err
	}
	if cfg.Name != "" {
		info.Name = cfg.Name
	}
	api := client.New(cfg.ServerURL, "")
	result, err := api.Register(context.Background(), cfg.EnrollmentToken, info)
	if err != nil {
		return err
	}
	cfg.AgentID = result.AgentID
	cfg.Credential = result.Credential
	cfg.EnrollmentToken = ""
	if path == "" {
		path = defaultConfigForRun()
	}
	cfg.ConfigPath = path
	return config.Save(path, *cfg)
}

func defaultConfigForRun() string {
	dir, err := os.UserConfigDir()
	if err != nil || dir == "" {
		dir = "."
	}
	return filepath.Join(dir, "resource-monitor-agent", "config.json")
}

func init() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if runtime.GOOS == "windows" {
		log.SetFlags(log.LstdFlags)
	}
}
