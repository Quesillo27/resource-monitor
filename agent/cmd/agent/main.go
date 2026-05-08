package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/collector"
	"resource-monitor/agent/internal/config"
	agentservice "resource-monitor/agent/internal/service"
	"resource-monitor/agent/internal/updater"
	"resource-monitor/agent/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		runCmd(nil)
		return
	}

	switch os.Args[1] {
	case "install":
		installCmd(os.Args[2:])
	case "uninstall":
		uninstallCmd(os.Args[2:])
	case "service":
		serviceCmd(os.Args[2:])
	case "install-service":
		installServiceCmd(os.Args[2:])
	case "run":
		runCmd(os.Args[2:])
	case "once":
		onceCmd(os.Args[2:])
	case "doctor":
		doctorCmd(os.Args[2:])
	case "status":
		statusCmd(os.Args[2:])
	default:
		runCmd(os.Args[1:])
	}
}

func installCmd(args []string) {
	fs, cfg := commonFlags("install")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	normalizeFlagConfig(cfg)
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

	existing, err := config.Load(path)
	if err == nil {
		if cfg.Credential == "" && cfg.EnrollmentToken == "" {
			cfg.Credential = existing.Credential
		}
		if cfg.AgentID == "" {
			cfg.AgentID = existing.AgentID
		}
		if cfg.Name == "" {
			cfg.Name = existing.Name
		}
	}
	if cfg.Credential == "" && cfg.EnrollmentToken != "" {
		if err := registerAndSave(cfg, path); err != nil {
			log.Fatalf("register agent: %v", err)
		}
	} else if cfg.Credential == "" {
		log.Fatal("missing existing credential or --enrollment-token")
	} else if err := config.Save(path, *cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}

	targetPath, err := ensureInstalledBinary()
	if err != nil {
		log.Fatalf("install binary: %v", err)
	}
	if err := runInstallService(targetPath, path); err != nil {
		log.Fatalf("install service: %v", err)
	}
	fmt.Printf("resource monitor agent installed with config %s\n", path)
	fmt.Printf("binary installed at %s\n", targetPath)
	fmt.Printf("agent version %s\n", version.Version)
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

func installServiceCmd(args []string) {
	fs := flag.NewFlagSet("install-service", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultServiceConfigPath(), "config file path")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	if err := agentservice.Install(*configPath); err != nil {
		log.Fatalf("install service: %v", err)
	}
}

func runCmd(args []string) {
	fs, cfg := commonFlags("run")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	normalizeFlagConfig(cfg)

	loaded, err := config.LoadWithOverrides(*cfg)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if loaded.IntervalSeconds <= 0 {
		loaded.IntervalSeconds = 60
	}

	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	go runInventoryLoop(ctx, loaded)
	go runUpdateCheck(ctx, loaded.ServerURL)
	if err := runLoop(ctx, loaded); err != nil {
		log.Fatal(err)
	}
}

func runUpdateCheck(ctx context.Context, serverURL string) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	check := func() {
		latest, hasUpdate, err := updater.CheckLatest(ctx, serverURL, version.Version)
		if err != nil {
			return // silent — server may not yet expose the endpoint
		}
		if hasUpdate {
			log.Printf("update available: current=%s latest=%s", version.Version, latest)
		}
	}
	check() // immediate check on startup
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

func onceCmd(args []string) {
	fs, cfg := commonFlags("once")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	normalizeFlagConfig(cfg)
	loaded, err := config.LoadWithOverrides(*cfg)
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

func statusCmd(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultServiceConfigPath(), "config file path")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	status, err := agentservice.Status(*configPath)
	if err != nil {
		fmt.Printf("service_status=unknown error=%v\n", err)
	} else {
		fmt.Printf("service_status=%v\n", status)
	}
	fmt.Printf("config=%s\nserver_url=%s\nagent_id=%s\nname=%s\ninterval_seconds=%d\nprofile=%s\ninstall_path=%s\n", *configPath, cfg.ServerURL, cfg.AgentID, cfg.Name, cfg.IntervalSeconds, cfg.Profile, config.DefaultInstallPath())
}

func doctorCmd(args []string) {
	fs, cfg := commonFlags("doctor")
	if err := fs.Parse(args); err != nil {
		log.Fatal(err)
	}
	normalizeFlagConfig(cfg)
	loaded, err := config.LoadWithOverrides(*cfg)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if loaded.ConfigPath == "" {
		loaded.ConfigPath = config.DefaultServiceConfigPath()
	}
	fmt.Printf("config=%s\nserver_url=%s\n", loaded.ConfigPath, loaded.ServerURL)
	fmt.Printf("profile=%s\ninstall_path=%s\n", loaded.Profile, config.DefaultInstallPath())
	if loaded.Credential == "" && loaded.EnrollmentToken == "" {
		log.Fatal("missing credential or enrollment token")
	}
	if err := sendOnce(context.Background(), loaded); err != nil {
		log.Fatalf("send test failed: %v", err)
	}
	fmt.Println("send test ok")
}

func commonFlags(name string) (*flag.FlagSet, *config.Config) {
	cfg := &config.Config{}
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	fs.StringVar(&cfg.ConfigPath, "config", config.DefaultServiceConfigPath(), "config file path")
	fs.StringVar(&cfg.ServerURL, "server-url", "", "central server URL")
	fs.StringVar(&cfg.EnrollmentToken, "enrollment-token", "", "one-time enrollment token")
	fs.StringVar(&cfg.Credential, "credential", "", "agent credential")
	fs.StringVar(&cfg.Name, "name", "", "agent display name")
	fs.StringVar(&cfg.Profile, "profile", "", "metrics profile: minimal or balanced")
	fs.StringVar(&cfg.ServiceChecksCSV, "services", "", "comma-separated process/service names to check")
	fs.IntVar(&cfg.IntervalSeconds, "interval", 0, "collection interval in seconds")
	return fs, cfg
}

func normalizeFlagConfig(cfg *config.Config) {
	if cfg.Profile == "" {
		cfg.Profile = "balanced"
	}
	if cfg.ServiceChecksCSV != "" {
		cfg.ServiceChecks = append(cfg.ServiceChecks, config.SplitCSV(cfg.ServiceChecksCSV)...)
	}
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
		sendOnceWithRetry(ctx, cfg)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func sendOnceWithRetry(ctx context.Context, cfg config.Config) {
	delays := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	for attempt, delay := range delays {
		if delay > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
		}
		if err := sendOnce(ctx, cfg); err != nil {
			log.Printf("send metrics failed attempt=%d/%d: %v", attempt+1, len(delays), err)
			continue
		}
		return
	}
}

func runInventoryLoop(ctx context.Context, cfg config.Config) {
	sendInventory(ctx, cfg)
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sendInventory(ctx, cfg)
		}
	}
}

func sendInventory(ctx context.Context, cfg config.Config) {
	if cfg.Credential == "" {
		return
	}
	inv := collector.Inventory{
		Hardware: collector.CollectHardware(),
		Software: collector.CollectSoftware(),
	}
	api := client.New(cfg.ServerURL, cfg.Credential)
	if err := api.SendInventory(ctx, inv); err != nil {
		log.Printf("inventory send failed: %v", err)
	} else {
		log.Printf("inventory sent hardware=%s software=%d", inv.Hardware.CPUModel, len(inv.Software))
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
	log.Printf("heartbeat sent for %s", info.Name)
	metrics, err := collector.Collect(ctx, cfg.Profile, cfg.ServiceChecks)
	if err != nil {
		return err
	}
	if err := api.SendMetrics(ctx, metrics); err != nil {
		return err
	}
	log.Printf("metrics sent cpu=%.1f memory=%.1f disks=%d", metrics.CPUPercent, metrics.MemoryUsedPercent, len(metrics.Disks))
	return nil
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

func ensureInstalledBinary() (string, error) {
	source, err := os.Executable()
	if err != nil {
		return "", err
	}
	source, _ = filepath.Abs(source)
	target := config.DefaultInstallPath()
	target, _ = filepath.Abs(target)
	if samePath(source, target) {
		return target, nil
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := copyFile(source, target); err != nil {
		return "", err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(target, 0o755); err != nil {
			return "", err
		}
	}
	return target, nil
}

func runInstallService(binaryPath, configPath string) error {
	current, err := os.Executable()
	if err != nil {
		return err
	}
	current, _ = filepath.Abs(current)
	binaryPath, _ = filepath.Abs(binaryPath)
	if samePath(current, binaryPath) {
		return agentservice.Install(configPath)
	}
	cmd := exec.Command(binaryPath, "install-service", "--config", configPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func init() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if runtime.GOOS == "windows" {
		log.SetFlags(log.LstdFlags)
	}
}
