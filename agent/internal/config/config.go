package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const (
	// MinIntervalSeconds evita que un usuario configure un intervalo
	// agresivo que sature al backend (rate limit del agente).
	MinIntervalSeconds = 10
)

type Config struct {
	ConfigPath           string   `json:"-"`
	ServerURL            string   `json:"server_url"`
	EnrollmentToken      string   `json:"enrollment_token,omitempty"`
	Credential           string   `json:"credential,omitempty"`
	AgentID              string   `json:"agent_id,omitempty"`
	IntervalSeconds      int      `json:"interval_seconds"`
	Name                 string   `json:"name,omitempty"`
	Profile              string   `json:"profile,omitempty"`
	ServiceChecks        []string `json:"service_checks,omitempty"`
	ServiceChecksCSV     string   `json:"-"`
	InsecureSkipTLS      bool     `json:"insecure_skip_tls,omitempty"`
	StatusListenAddr     string   `json:"status_listen_addr,omitempty"`
	AllowPublicStatus    bool     `json:"-"`
	BufferDir            string   `json:"buffer_dir,omitempty"`
	InventoryFingerprint string   `json:"inventory_fingerprint,omitempty"`
}

func Load(path string) (Config, error) {
	var cfg Config
	if path == "" {
		path = DefaultServiceConfigPath()
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(bytes, &cfg); err != nil {
		return cfg, err
	}
	cfg.ConfigPath = path
	return cfg, nil
}

func LoadWithOverrides(overrides Config) (Config, error) {
	path := overrides.ConfigPath
	var cfg Config
	if path != "" {
		loaded, err := Load(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return cfg, err
		}
		cfg = loaded
		cfg.ConfigPath = path
	}
	if cfg.ConfigPath == "" {
		cfg.ConfigPath = path
	}
	if overrides.ServerURL != "" {
		cfg.ServerURL = overrides.ServerURL
	}
	if overrides.EnrollmentToken != "" {
		cfg.EnrollmentToken = overrides.EnrollmentToken
	}
	if overrides.Credential != "" {
		cfg.Credential = overrides.Credential
	}
	if overrides.Name != "" {
		cfg.Name = overrides.Name
	}
	if overrides.Profile != "" {
		cfg.Profile = overrides.Profile
	}
	if len(overrides.ServiceChecks) > 0 {
		cfg.ServiceChecks = overrides.ServiceChecks
	}
	if overrides.ServiceChecksCSV != "" {
		cfg.ServiceChecks = append(cfg.ServiceChecks, SplitCSV(overrides.ServiceChecksCSV)...)
	}
	if overrides.IntervalSeconds > 0 {
		cfg.IntervalSeconds = overrides.IntervalSeconds
	}
	if overrides.InsecureSkipTLS {
		cfg.InsecureSkipTLS = true
	}
	if overrides.StatusListenAddr != "" {
		cfg.StatusListenAddr = overrides.StatusListenAddr
	}
	if cfg.IntervalSeconds == 0 {
		cfg.IntervalSeconds = 60
	}
	if cfg.IntervalSeconds < MinIntervalSeconds {
		cfg.IntervalSeconds = MinIntervalSeconds
	}
	if cfg.Profile == "" {
		cfg.Profile = "balanced"
	}
	return cfg, nil
}

func SplitCSV(value string) []string {
	result := []string{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			result = append(result, item)
		}
	}
	return result
}

func Save(path string, cfg Config) error {
	if path == "" {
		path = DefaultServiceConfigPath()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	bytes, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, bytes, 0o600)
}

func DefaultServiceConfigPath() string {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return filepath.Join(programData, "ResourceMonitorAgent", "config.json")
	}
	return "/etc/resource-monitor-agent/config.json"
}

func DefaultInstallPath() string {
	if runtime.GOOS == "windows" {
		programFiles := os.Getenv("ProgramFiles")
		if programFiles == "" {
			programFiles = `C:\Program Files`
		}
		return filepath.Join(programFiles, "ResourceMonitorAgent", "resource-monitor-agent.exe")
	}
	return "/usr/local/bin/resource-monitor-agent"
}

// DefaultBufferDir devuelve el directorio donde se almacenan muestras
// pendientes de envío cuando el server está caído.
func DefaultBufferDir() string {
	if runtime.GOOS == "windows" {
		programData := os.Getenv("ProgramData")
		if programData == "" {
			programData = `C:\ProgramData`
		}
		return filepath.Join(programData, "ResourceMonitorAgent", "buffer")
	}
	return "/var/lib/resource-monitor-agent/buffer"
}
