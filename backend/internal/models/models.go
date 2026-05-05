package models

import "time"

const (
	StatusOnline   = "online"
	StatusWarning  = "warning"
	StatusCritical = "critical"
	StatusOffline  = "offline"
)

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type EnrollmentTokenRequest struct {
	Name           string `json:"name"`
	TTLHours       int    `json:"ttl_hours"`
	ServerURL      string `json:"server_url"`
	AgentName      string `json:"agent_name"`
	InstallStyle   string `json:"install_style"`
	ReleaseVersion string `json:"release_version"`
}

type AgentUpdateRequest struct {
	Name string `json:"name"`
}

type AgentRegisterRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Name            string `json:"name"`
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	UptimeSeconds   uint64 `json:"uptime_seconds"`
}

type AgentAuthResponse struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

type HeartbeatRequest struct {
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	UptimeSeconds uint64 `json:"uptime_seconds"`
}

type MetricsRequest struct {
	CPUPercent        float64      `json:"cpu_percent"`
	MemoryTotalBytes  uint64       `json:"memory_total_bytes"`
	MemoryUsedBytes   uint64       `json:"memory_used_bytes"`
	MemoryUsedPercent float64      `json:"memory_used_percent"`
	Disks             []DiskMetric `json:"disks"`
}

type DiskMetric struct {
	Name        string  `json:"name"`
	Mountpoint  string  `json:"mountpoint"`
	Filesystem  string  `json:"filesystem"`
	TotalBytes  uint64  `json:"total_bytes"`
	UsedBytes   uint64  `json:"used_bytes"`
	FreeBytes   uint64  `json:"free_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

type Agent struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	Hostname      string     `json:"hostname"`
	OS            string     `json:"os"`
	Arch          string     `json:"arch"`
	UptimeSeconds uint64     `json:"uptime_seconds"`
	Status        string     `json:"status"`
	LastSeenAt    *time.Time `json:"last_seen_at"`
	CreatedAt     time.Time  `json:"created_at"`
	CPUPercent    *float64    `json:"cpu_percent,omitempty"`
	MemoryPercent *float64    `json:"memory_used_percent,omitempty"`
	LastMetricAt  *time.Time  `json:"last_metric_at,omitempty"`
	ActiveAlerts  int         `json:"active_alerts"`
	DiskCount     int         `json:"disk_count"`
}

type Alert struct {
	ID         string     `json:"id"`
	AgentID    string     `json:"agent_id"`
	AgentName  string     `json:"agent_name"`
	Type       string     `json:"type"`
	Severity   string     `json:"severity"`
	Message    string     `json:"message"`
	Active     bool       `json:"active"`
	OpenedAt   time.Time  `json:"opened_at"`
	ResolvedAt *time.Time `json:"resolved_at"`
}
