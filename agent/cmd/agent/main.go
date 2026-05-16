package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"resource-monitor/agent/internal/buffer"
	"resource-monitor/agent/internal/client"
	"resource-monitor/agent/internal/collector"
	"resource-monitor/agent/internal/config"
	"resource-monitor/agent/internal/dbhost"
	agentruntime "resource-monitor/agent/internal/runtime"
	agentservice "resource-monitor/agent/internal/service"
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
	case "version":
		fmt.Printf("resource-monitor-agent %s (%s/%s)\n", version.Version, runtime.GOOS, runtime.GOARCH)
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
	if cfg.IntervalSeconds < config.MinIntervalSeconds {
		log.Printf("warning: interval %ds below minimum, raising to %ds", cfg.IntervalSeconds, config.MinIntervalSeconds)
		cfg.IntervalSeconds = config.MinIntervalSeconds
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

	if loaded.Credential == "" && loaded.EnrollmentToken != "" {
		if err := registerAndSave(&loaded, loaded.ConfigPath); err != nil {
			log.Fatalf("register agent: %v", err)
		}
	}
	if loaded.Credential == "" {
		log.Fatal("missing credential or enrollment token")
	}

	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()

	if loaded.StatusListenAddr != "" {
		go startStatusServer(ctx, loaded)
	}

	// Dispatch segun modo: agente regular vs agente de BD vinculado.
	if loaded.Mode == "db" {
		if err := dbhost.Run(ctx, loaded); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := agentruntime.Run(ctx, loaded); err != nil {
		log.Fatal(err)
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
	if err := sendOnceCmd(context.Background(), loaded); err != nil {
		log.Fatal(err)
	}
	fmt.Println("metrics sent")
}

func statusCmd(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", config.DefaultServiceConfigPath(), "config file path")
	showMetrics := fs.Bool("metrics", false, "also collect and print sample metrics (without sending)")
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
	fmt.Printf("config=%s\nserver_url=%s\nagent_id=%s\nname=%s\ninterval_seconds=%d\nprofile=%s\ninstall_path=%s\nversion=%s\n",
		*configPath, cfg.ServerURL, cfg.AgentID, cfg.Name, cfg.IntervalSeconds, cfg.Profile,
		config.DefaultInstallPath(), version.Version)
	// pendientes en buffer offline
	bufDir := cfg.BufferDir
	if bufDir == "" {
		bufDir = config.DefaultBufferDir()
	}
	if buf, err := buffer.New(bufDir); err == nil {
		fmt.Printf("buffer_pending=%d\nbuffer_dir=%s\n", buf.Count(), bufDir)
	}
	if *showMetrics {
		fmt.Println("---- collecting sample (no send) ----")
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		host, _ := collector.HostInfo()
		metrics, err := collector.Collect(ctx, cfg.Profile, cfg.ServiceChecks)
		if err != nil {
			fmt.Printf("collect error: %v\n", err)
			return
		}
		out := map[string]any{"host": host, "metrics": metrics}
		data, _ := json.MarshalIndent(out, "", "  ")
		fmt.Println(string(data))
	}
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
	if err := sendOnceCmd(context.Background(), loaded); err != nil {
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
	fs.StringVar(&cfg.Profile, "profile", "", "metrics profile: minimal | balanced | full")
	fs.StringVar(&cfg.ServiceChecksCSV, "services", "", "comma-separated process/service names to check")
	fs.IntVar(&cfg.IntervalSeconds, "interval", 0, fmt.Sprintf("collection interval in seconds (min %d)", config.MinIntervalSeconds))
	fs.BoolVar(&cfg.InsecureSkipTLS, "insecure-skip-tls", false, "skip TLS certificate verification (only for self-signed servers in LAN)")
	fs.StringVar(&cfg.StatusListenAddr, "status-listen", "", "address for local status HTTP endpoint (e.g. 127.0.0.1:9099)")
	fs.BoolVar(&cfg.AllowPublicStatus, "allow-public-status", false, "allow --status-listen to bind on a non-loopback address (network-visible, no auth)")
	// Modo "agente de BD" — vincula el agente a un db_target en vez de a "Equipos".
	fs.StringVar(&cfg.Mode, "mode", "", "operating mode: agent (default) | db")
	fs.StringVar(&cfg.Engine, "engine", "", "db engine when --mode=db: postgres | mysql | mongo (empty = auto-detect)")
	fs.StringVar(&cfg.DataDir, "data-dir", "", "db datadir path (empty = auto-detect from running process)")
	fs.StringVar(&cfg.LogPath, "log-path", "", "db log file path to tail (empty = auto-detect)")
	return fs, cfg
}

func normalizeFlagConfig(cfg *config.Config) {
	if cfg.Profile != "" && cfg.Profile != "minimal" && cfg.Profile != "balanced" && cfg.Profile != "full" {
		log.Fatalf("invalid profile %q (use minimal | balanced | full)", cfg.Profile)
	}
	if cfg.ServiceChecksCSV != "" {
		cfg.ServiceChecks = append(cfg.ServiceChecks, config.SplitCSV(cfg.ServiceChecksCSV)...)
	}
	if cfg.StatusListenAddr != "" {
		host, _, err := net.SplitHostPort(cfg.StatusListenAddr)
		if err != nil {
			log.Fatalf("--status-listen: invalid address %q: %v", cfg.StatusListenAddr, err)
		}
		loopback := host == "127.0.0.1" || host == "::1" || host == "localhost"
		if !loopback && !cfg.AllowPublicStatus {
			log.Fatalf("--status-listen: binding to %q exposes the status endpoint on the network without authentication.\nUse 127.0.0.1:<port> for local-only access, or add --allow-public-status to override.", host)
		}
	}
}

// sendOnceCmd realiza un único envío sincrónico (heartbeat + métricas).
// Lo usan once y doctor.
func sendOnceCmd(ctx context.Context, cfg config.Config) error {
	info, err := collector.HostInfo()
	if err != nil {
		return err
	}
	if cfg.Name != "" {
		info.Name = cfg.Name
	}
	api := client.NewWithTLS(cfg.ServerURL, cfg.Credential, cfg.InsecureSkipTLS)
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
	api := client.NewWithTLS(cfg.ServerURL, "", cfg.InsecureSkipTLS)

	// Modo "agente de BD": registro distinto, contra db_target.
	if cfg.Mode == "db" {
		det, derr := dbhost.Detect(cfg.Engine)
		if derr != nil && cfg.Engine == "" {
			return fmt.Errorf("no se detecto motor de BD y --engine no fue provisto: %v", derr)
		}
		engine := cfg.Engine
		if engine == "" {
			engine = det.Engine
		}
		req := client.DBHostRegisterRequest{
			EnrollmentToken: cfg.EnrollmentToken,
			Hostname:        info.Hostname,
			OS:              info.OS,
			Arch:            info.Arch,
			Engine:          engine,
			EngineVersion:   det.EngineVersion,
			AgentVersion:    version.Version,
		}
		result, err := api.RegisterDBHost(context.Background(), req)
		if err != nil {
			return err
		}
		cfg.HostAgentID = result.HostAgentID
		cfg.DBTargetID = result.DBTargetID
		cfg.Credential = result.Credential
		cfg.Engine = engine
		if cfg.DataDir == "" {
			cfg.DataDir = det.DataDir
		}
		if cfg.LogPath == "" {
			cfg.LogPath = det.LogPath
		}
		cfg.EnrollmentToken = ""
		if path == "" {
			path = defaultConfigForRun()
		}
		cfg.ConfigPath = path
		return config.Save(path, *cfg)
	}

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

// startStatusServer expone un endpoint HTTP local con el último estado del
// agente (sólo para debugging — bind por defecto en 127.0.0.1).
func startStatusServer(ctx context.Context, cfg config.Config) {
	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		host, _ := collector.HostInfo()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version":           version.Version,
			"agent_id":          cfg.AgentID,
			"name":              cfg.Name,
			"profile":           cfg.Profile,
			"interval_seconds":  cfg.IntervalSeconds,
			"server_url":        cfg.ServerURL,
			"host":              host,
			"agent_started_at":  time.Now().Add(-time.Duration(host.AgentUptimeSec) * time.Second),
		})
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		c, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		metrics, err := collector.Collect(c, cfg.Profile, cfg.ServiceChecks)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(metrics)
	})
	server := &http.Server{
		Addr:              cfg.StatusListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("status endpoint listening on %s", cfg.StatusListenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("status endpoint error: %v", err)
	}
}

func init() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	if runtime.GOOS == "windows" {
		log.SetFlags(log.LstdFlags)
	}
}
