package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

type Config struct {
	ConfigPath      string `json:"-"`
	ServerURL       string `json:"server_url"`
	EnrollmentToken string `json:"enrollment_token,omitempty"`
	Credential      string `json:"credential,omitempty"`
	AgentID         string `json:"agent_id,omitempty"`
	IntervalSeconds int    `json:"interval_seconds"`
	Name            string `json:"name,omitempty"`
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
	if overrides.IntervalSeconds > 0 {
		cfg.IntervalSeconds = overrides.IntervalSeconds
	}
	if cfg.IntervalSeconds == 0 {
		cfg.IntervalSeconds = 60
	}
	return cfg, nil
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
