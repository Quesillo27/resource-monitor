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
	Profile        string `json:"profile"`
	Services       string `json:"services"`
	Interval       int    `json:"interval"`
}

type AgentUpdateRequest struct {
	Name string `json:"name"`
}

type AlertRule struct {
	ID              string   `json:"id,omitempty"`
	AgentID         *string  `json:"agent_id,omitempty"`
	Metric          string   `json:"metric"`
	ResourceKey     string   `json:"resource_key"`
	Severity        string   `json:"severity"`
	Enabled         bool     `json:"enabled"`
	Threshold       float64  `json:"threshold"`
	DurationSamples int      `json:"duration_samples"`
	NotifyEmail     bool     `json:"notify_email"`
	NotifyTelegram  bool     `json:"notify_telegram"`
	CooldownMinutes int      `json:"cooldown_minutes"`
	Description     string   `json:"description"`
	Source          string   `json:"source,omitempty"`
	CurrentValue    *float64 `json:"current_value,omitempty"`
}

type AlertRulesRequest struct {
	Rules []AlertRule `json:"rules"`
}

type SMTPSettings struct {
	Enabled         bool   `json:"enabled"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	Password        string `json:"password,omitempty"`
	FromAddress     string `json:"from_address"`
	ToAddresses     string `json:"to_addresses"`
	UseTLS          bool   `json:"use_tls"`
	UseStartTLS     bool   `json:"use_starttls"`
	CooldownMinutes int    `json:"cooldown_minutes"`
}

type TelegramSettings struct {
	Enabled         bool   `json:"enabled"`
	BotToken        string `json:"bot_token,omitempty"`
	ChatIDs         string `json:"chat_ids"`
	ParseMode       string `json:"parse_mode"`
	CooldownMinutes int    `json:"cooldown_minutes"`
}

type UserDTO struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	Role      string    `json:"role"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type UserCreateRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
	Active   *bool  `json:"active,omitempty"`
}

type UserUpdateRequest struct {
	Username string `json:"username"`
	Role     string `json:"role"`
	Active   *bool  `json:"active,omitempty"`
}

type UserPasswordRequest struct {
	Password string `json:"password"`
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
	ID                        string       `json:"id"`
	AgentID                   string       `json:"agent_id"`
	AgentName                 string       `json:"agent_name"`
	Type                      string       `json:"type"`
	Severity                  string       `json:"severity"`
	Message                   string       `json:"message"`
	ResourceKey               string       `json:"resource_key"`
	RuleID                    *string      `json:"rule_id,omitempty"`
	ObservedValue             *float64     `json:"observed_value,omitempty"`
	ThresholdValue            *float64     `json:"threshold_value,omitempty"`
	Unit                      string       `json:"unit,omitempty"`
	DurationSamples           int          `json:"duration_samples,omitempty"`
	NotifyEmail               bool         `json:"notify_email"`
	NotifyTelegram            bool         `json:"notify_telegram"`
	NotificationCount         int          `json:"notification_count"`
	TelegramNotificationCount int          `json:"telegram_notification_count"`
	ProcessSnapshot           []ProcMetric `json:"process_snapshot,omitempty"`
	Active                    bool         `json:"active"`
	OpenedAt                  time.Time    `json:"opened_at"`
	ResolvedAt                *time.Time   `json:"resolved_at"`
}
