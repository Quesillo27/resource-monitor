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
	DownloadURL    string `json:"download_url"`
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
	SwapTotalBytes    uint64       `json:"swap_total_bytes,omitempty"`
	SwapUsedBytes     uint64       `json:"swap_used_bytes,omitempty"`
	SwapUsedPercent   float64      `json:"swap_used_percent,omitempty"`
	Disks             []DiskMetric `json:"disks"`
	Networks          []NetMetric  `json:"networks,omitempty"`
	Processes         []ProcMetric `json:"processes,omitempty"`
	Services          []SvcMetric  `json:"services,omitempty"`
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

type NetMetric struct {
	Name      string `json:"name"`
	BytesSent uint64 `json:"bytes_sent"`
	BytesRecv uint64 `json:"bytes_recv"`
	Up        bool   `json:"up"`
}

type ProcMetric struct {
	PID           int32   `json:"pid"`
	Name          string  `json:"name"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemoryPercent float32 `json:"memory_percent"`
}

type SvcMetric struct {
	Name   string `json:"name"`
	Status string `json:"status"`
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
