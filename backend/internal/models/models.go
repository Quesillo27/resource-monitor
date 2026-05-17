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
	Name string   `json:"name"`
	Tags *[]string `json:"tags,omitempty"`
}

type AlertRule struct {
	ID              string   `json:"id,omitempty"`
	AgentID         *string  `json:"agent_id,omitempty"`
	DBTargetID      *string  `json:"db_target_id,omitempty"`
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
	PrimaryIP       string `json:"primary_ip,omitempty"`
}

type AgentAuthResponse struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

type HeartbeatRequest struct {
	Name              string   `json:"name"`
	Hostname          string   `json:"hostname"`
	OS                string   `json:"os"`
	Arch              string   `json:"arch"`
	UptimeSeconds     uint64   `json:"uptime_seconds"`
	AgentUptimeSec    uint64   `json:"agent_uptime_seconds,omitempty"`
	AgentVersion      string   `json:"agent_version,omitempty"`
	PrimaryIP         string   `json:"primary_ip,omitempty"`
	LocalServiceNames []string `json:"local_service_names,omitempty"`
}

type MetricsRequest struct {
	CapturedAt        *time.Time   `json:"captured_at,omitempty"`
	Profile           string       `json:"profile,omitempty"`
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
	Temperatures      []TempMetric `json:"temperatures,omitempty"`
	GatewayLatencyMs  *float64     `json:"gateway_latency_ms,omitempty"`
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
	Name       string     `json:"name"`
	BytesSent  uint64     `json:"bytes_sent"`
	BytesRecv  uint64     `json:"bytes_recv"`
	SentMbps   float64    `json:"sent_mbps,omitempty"`
	RecvMbps   float64    `json:"recv_mbps,omitempty"`
	Up         bool       `json:"up"`
	Active     bool       `json:"active,omitempty"`
	Hidden     bool       `json:"hidden,omitempty"`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty"`
	HiddenAt   *time.Time `json:"hidden_at,omitempty"`
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

type TempMetric struct {
	SensorKey    string  `json:"sensor_key"`
	TemperatureC float64 `json:"temperature_c"`
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
	CPUPercent    *float64   `json:"cpu_percent,omitempty"`
	MemoryPercent *float64   `json:"memory_used_percent,omitempty"`
	LastMetricAt  *time.Time `json:"last_metric_at,omitempty"`
	ActiveAlerts  int        `json:"active_alerts"`
	DiskCount     int        `json:"disk_count"`
	Tags          []string      `json:"tags"`
	AgentVersion  string        `json:"agent_version,omitempty"`
	PrimaryIP     string        `json:"primary_ip,omitempty"`
	Profile       string        `json:"profile,omitempty"`
	LastCommand   *AgentCommandSummary `json:"last_command,omitempty"`
}

// AgentCommandSummary expone el último comando del agente al frontend para
// mostrar estado en vivo (pendiente/ejecutando/completado/fallido) sin cargar
// el historial completo.
type AgentCommandSummary struct {
	ID          string     `json:"id"`
	Command     string     `json:"command"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	Error       string     `json:"error,omitempty"`
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
	SeenAt                    *time.Time   `json:"seen_at"`
	SeenByUserID              *string      `json:"seen_by_user_id,omitempty"`
	SeenByUsername            *string      `json:"seen_by_username,omitempty"`
}

type HardwareInfo struct {
	CPUModel        string  `json:"cpu_model"`
	CPUVendor       string  `json:"cpu_vendor"`
	CPUCoresPhys    int     `json:"cpu_cores_physical"`
	CPUCoresLogical int     `json:"cpu_cores_logical"`
	CPUMhz          float64 `json:"cpu_mhz"`
	MemoryTotalGB   float64 `json:"memory_total_gb"`
	KernelVersion   string  `json:"kernel_version"`
	Virtualization  string  `json:"virtualization"`
	Arch            string  `json:"arch"`
}

type HardwareSnapshot struct {
	HardwareInfo
	CapturedAt time.Time `json:"captured_at"`
}

type SoftwareItem struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Publisher string `json:"publisher,omitempty"`
}

type InventoryRequest struct {
	Hardware HardwareInfo   `json:"hardware"`
	Software []SoftwareItem `json:"software"`
}

type InventoryResponse struct {
	Hardware *HardwareSnapshot `json:"hardware,omitempty"`
	Software []SoftwareItem    `json:"software"`
}

type DatabaseTarget struct {
	ID                  string            `json:"id"`
	Name                string            `json:"name"`
	Type                string            `json:"type"` // postgres, redis
	DSN                 string            `json:"dsn"`
	Params              map[string]string `json:"params,omitempty"`
	Enabled             bool              `json:"enabled"`
	PollIntervalSeconds int               `json:"poll_interval_seconds"`
	CreatedAt           time.Time         `json:"created_at"`
	UpdatedAt           time.Time         `json:"updated_at"`
	LastOK              *bool             `json:"last_ok,omitempty"`
	LastError           string            `json:"last_error,omitempty"`
	LastSampleAt        *time.Time        `json:"last_sample_at,omitempty"`
	Sparkline           []int             `json:"sparkline,omitempty"`
}

type DatabaseSample struct {
	ID                     int64     `json:"id"`
	TargetID               string    `json:"target_id"`
	CapturedAt             time.Time `json:"captured_at"`
	OK                     bool      `json:"ok"`
	ErrorMessage           string    `json:"error_message,omitempty"`
	ConnectionsActive      *int      `json:"connections_active,omitempty"`
	ConnectionsIdle        *int      `json:"connections_idle,omitempty"`
	ConnectionsWaiting     *int      `json:"connections_waiting,omitempty"`
	ConnectionsTotal       *int      `json:"connections_total,omitempty"`
	DBSizeBytes            *int64    `json:"db_size_bytes,omitempty"`
	SlowQueries            *int      `json:"slow_queries,omitempty"`
	ActiveLocks            *int      `json:"active_locks,omitempty"`
	CacheHitRatio          *float64  `json:"cache_hit_ratio,omitempty"`
	TransactionsCommitted  *int64    `json:"transactions_committed,omitempty"`
	TransactionsRolledBack *int64    `json:"transactions_rolled_back,omitempty"`
	MemoryUsedBytes        *int64    `json:"memory_used_bytes,omitempty"`
	MemoryMaxBytes         *int64    `json:"memory_max_bytes,omitempty"`
	ConnectedClients       *int      `json:"connected_clients,omitempty"`
	OpsPerSec              *float64  `json:"ops_per_sec,omitempty"`
	KeyspaceHits           *int64    `json:"keyspace_hits,omitempty"`
	KeyspaceMisses         *int64    `json:"keyspace_misses,omitempty"`
	// Métricas históricas extendidas (Fase A — manager-v1.10.0)
	Deadlocks         *int64   `json:"deadlocks,omitempty"`
	TempFiles         *int64   `json:"temp_files,omitempty"`
	TempBytes         *int64   `json:"temp_bytes,omitempty"`
	TuplesReturned    *int64   `json:"tuples_returned,omitempty"`
	TuplesFetched     *int64   `json:"tuples_fetched,omitempty"`
	TuplesInserted    *int64   `json:"tuples_inserted,omitempty"`
	TuplesUpdated     *int64   `json:"tuples_updated,omitempty"`
	TuplesDeleted     *int64   `json:"tuples_deleted,omitempty"`
	WalBytes          *int64   `json:"wal_bytes,omitempty"`
	XidAge            *int64   `json:"xid_age,omitempty"`
	BlksRead          *int64   `json:"blks_read,omitempty"`
	BlksHit           *int64   `json:"blks_hit,omitempty"`
	MaxConnections    *int     `json:"max_connections,omitempty"`
	SlowQueryP50Ms    *float64 `json:"slow_query_p50_ms,omitempty"`
	SlowQueryP95Ms    *float64 `json:"slow_query_p95_ms,omitempty"`
	SlowQueryP99Ms    *float64 `json:"slow_query_p99_ms,omitempty"`
}

type PGLiveInfo struct {
	Version        string          `json:"version"`
	StartedAt      string          `json:"started_at"`
	UptimeSeconds  int64           `json:"uptime_seconds"`
	MaxConnections int             `json:"max_connections"`
	DBName         string          `json:"db_name"`
	Databases      []DBSize        `json:"databases"`
	XidAge         int64           `json:"xid_age"`
	OldestXactMs   int64           `json:"oldest_xact_ms"`
	Checkpoints    CheckpointStats `json:"checkpoints"`
	Sequences      []SequenceInfo  `json:"sequences,omitempty"`
}

type CheckpointStats struct {
	Timed          int64 `json:"timed"`
	Requested      int64 `json:"requested"`
	BuffersClean   int64 `json:"buffers_clean"`
	BuffersBackend int64 `json:"buffers_backend"`
}

type SequenceInfo struct {
	Schema  string  `json:"schema"`
	Name    string  `json:"name"`
	Current int64   `json:"current"`
	Max     int64   `json:"max"`
	PctUsed float64 `json:"pct_used"`
}

type DBSize struct {
	Name  string `json:"name"`
	Bytes int64  `json:"bytes"`
}

type ActiveQuery struct {
	PID           int    `json:"pid"`
	State         string `json:"state"`
	Query         string `json:"query"`
	DurationMs    int64  `json:"duration_ms"`
	WaitEvent     string `json:"wait_event,omitempty"`
	AppName       string `json:"app_name,omitempty"`
	UserName      string `json:"user_name,omitempty"`
	ClientAddr    string `json:"client_addr,omitempty"`
	Database      string `json:"database,omitempty"`
	BackendAgeMs  int64  `json:"backend_age_ms,omitempty"`
}

type TableSize struct {
	Schema     string `json:"schema"`
	Table      string `json:"table"`
	TotalBytes int64  `json:"total_bytes"`
	TableBytes int64  `json:"table_bytes"`
	IndexBytes int64  `json:"index_bytes"`
}

// BlockingLock representa una sesion bloqueada por otra (usa pg_blocking_pids).
type BlockingLock struct {
	BlockedPID    int    `json:"blocked_pid"`
	BlockedQuery  string `json:"blocked_query"`
	BlockedUser   string `json:"blocked_user,omitempty"`
	BlockedApp    string `json:"blocked_app,omitempty"`
	BlockedTimeMs int64  `json:"blocked_time_ms"`
	BlockingPID   int    `json:"blocking_pid"`
	BlockingQuery string `json:"blocking_query"`
	BlockingUser  string `json:"blocking_user,omitempty"`
	BlockingApp   string `json:"blocking_app,omitempty"`
	BlockingState string `json:"blocking_state,omitempty"`
	WaitEvent     string `json:"wait_event,omitempty"`
	LockType      string `json:"lock_type,omitempty"`
	Relation      string `json:"relation,omitempty"`
}

// TableIO representa I/O por tabla — pg_statio_user_tables.
type TableIO struct {
	Schema       string `json:"schema"`
	Table        string `json:"table"`
	HeapRead     int64  `json:"heap_read"`
	HeapHit      int64  `json:"heap_hit"`
	IdxRead      int64  `json:"idx_read"`
	IdxHit       int64  `json:"idx_hit"`
	HitRatioPct  float64 `json:"hit_ratio_pct"`
}

// PGSetting es una entrada de pg_settings con metadata clave.
type PGSetting struct {
	Name      string `json:"name"`
	Value     string `json:"value"`
	Unit      string `json:"unit,omitempty"`
	Category  string `json:"category,omitempty"`
	ShortDesc string `json:"short_desc,omitempty"`
	Source    string `json:"source,omitempty"`
}

type VacuumStat struct {
	Schema       string  `json:"schema"`
	Table        string  `json:"table"`
	LiveTuples   int64   `json:"live_tuples"`
	DeadTuples   int64   `json:"dead_tuples"`
	BloatPct     float64 `json:"bloat_pct"`
	LastVacuum   string  `json:"last_vacuum,omitempty"`
	LastAnalyze  string  `json:"last_analyze,omitempty"`
	VacuumCount  int64   `json:"vacuum_count"`
	AnalyzeCount int64   `json:"analyze_count"`
}

type IndexUsage struct {
	Schema    string `json:"schema"`
	Table     string `json:"table"`
	Index     string `json:"index"`
	Scans     int64  `json:"scans"`
	SizeBytes int64  `json:"size_bytes"`
	IsUnique  bool   `json:"is_unique"`
}

type SlowQuery struct {
	Query       string  `json:"query"`
	Calls       int64   `json:"calls"`
	TotalMs     float64 `json:"total_ms"`
	MeanMs      float64 `json:"mean_ms"`
	MaxMs       float64 `json:"max_ms"`
	Rows        int64   `json:"rows"`
	CacheHitPct float64 `json:"cache_hit_pct"`
}

type RedisLiveInfo struct {
	FragRatio      float64         `json:"frag_ratio"`
	EvictedKeys    int64           `json:"evicted_keys"`
	ExpiredKeys    int64           `json:"expired_keys"`
	BlockedClients int             `json:"blocked_clients"`
	UptimeSeconds  int64           `json:"uptime_seconds"`
	Role           string          `json:"role"`
	Keyspace       []RedisKeyspace `json:"keyspace"`
}

type RedisKeyspace struct {
	DB      string `json:"db"`
	Keys    int64  `json:"keys"`
	Expires int64  `json:"expires"`
}

type RedisSlowlogEntry struct {
	ID            int64  `json:"id"`
	Timestamp     int64  `json:"timestamp"`
	DurationMicro int64  `json:"duration_micro"`
	Command       string `json:"command"`
	ClientAddr    string `json:"client_addr,omitempty"`
	ClientName    string `json:"client_name,omitempty"`
}

type RedisClient struct {
	ID       int64  `json:"id"`
	Addr     string `json:"addr"`
	Name     string `json:"name,omitempty"`
	AgeSec   int64  `json:"age_sec"`
	IdleSec  int64  `json:"idle_sec"`
	DB       int    `json:"db"`
	Cmd      string `json:"cmd,omitempty"`
	Flags    string `json:"flags,omitempty"`
	SubCount int    `json:"sub_count,omitempty"`
}

type RedisMemoryStats struct {
	TotalAllocated   int64             `json:"total_allocated"`
	StartupAllocated int64             `json:"startup_allocated"`
	OverheadTotal    int64             `json:"overhead_total"`
	KeysCount        int64             `json:"keys_count"`
	ClientsTotal     int64             `json:"clients_total"`
	AofBufferTotal   int64             `json:"aof_buffer_total"`
	ReplicaBuf       int64             `json:"replica_buf"`
	FragRatio        float64           `json:"frag_ratio"`
	Extra            map[string]string `json:"extra,omitempty"`
}

type PGReplicaInfo struct {
	AppName     string `json:"app_name"`
	ClientAddr  string `json:"client_addr"`
	State       string `json:"state"`
	SyncState   string `json:"sync_state"`
	ReplayLagMs int64  `json:"replay_lag_ms"`
	SentLagKB   int64  `json:"sent_lag_kb"`
	ApplyLagKB  int64  `json:"apply_lag_kb"`
}

// ── DB Host Agent ────────────────────────────────────────────────────────────
// Agente liviano que corre en el mismo host que la BD y reporta metricas que el
// polling remoto no puede ver: FS del datadir, OOM kills, tail del log,
// disk I/O del mount del datadir, CPU/RAM del proceso PG.
// Pertenece a un db_target, NO se lista en "Equipos".

type DBHostAgent struct {
	ID             string     `json:"id"`
	DBTargetID     string     `json:"db_target_id"`
	Hostname       string     `json:"hostname"`
	OS             string     `json:"os"`
	Arch           string     `json:"arch"`
	Engine         string     `json:"engine"`
	EngineVersion  string     `json:"engine_version,omitempty"`
	AgentVersion   string     `json:"agent_version"`
	LastSeenAt     *time.Time `json:"last_seen_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	Status         string     `json:"status"` // online|offline (derivado)
}

type DBHostLogEvent struct {
	Timestamp time.Time `json:"ts"`
	Level     string    `json:"level"`   // FATAL, PANIC, WARNING, ERROR, INFO
	Pattern   string    `json:"pattern"` // qué regex matcheó
	Message   string    `json:"message"`
}

type DBHostSample struct {
	ID             int64            `json:"id"`
	DBHostAgentID  string           `json:"db_host_agent_id"`
	CapturedAt     time.Time        `json:"captured_at"`
	OK             bool             `json:"ok"`
	ErrorMessage   string           `json:"error_message,omitempty"`
	FSUsedPct      *float64         `json:"fs_used_pct,omitempty"`
	FSFreeBytes    *int64           `json:"fs_free_bytes,omitempty"`
	FSTotalBytes   *int64           `json:"fs_total_bytes,omitempty"`
	IOReadOps      *int64           `json:"io_read_ops,omitempty"`
	IOWriteOps     *int64           `json:"io_write_ops,omitempty"`
	IOReadBytes    *int64           `json:"io_read_bytes,omitempty"`
	IOWriteBytes   *int64           `json:"io_write_bytes,omitempty"`
	WalLatencyMs   *float64         `json:"wal_latency_ms,omitempty"`
	OOMKillsDelta  *int             `json:"oom_kills_delta,omitempty"`
	PGCPUPct       *float64         `json:"pg_cpu_pct,omitempty"`
	PGRSSBytes     *int64           `json:"pg_rss_bytes,omitempty"`
	PGFDUsed       *int             `json:"pg_fd_used,omitempty"`
	PGFDLimit      *int             `json:"pg_fd_limit,omitempty"`
	PGUptimeSec    *int64           `json:"pg_uptime_seconds,omitempty"`
	LogEvents      []DBHostLogEvent `json:"log_events,omitempty"`
}

type DBHostEnrollmentResult struct {
	Token          string `json:"token"`
	ExpiresAt      string `json:"expires_at"`
	InstallCommand string `json:"install_command"`
}

type DBHostRegisterRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	Engine          string `json:"engine"`
	EngineVersion   string `json:"engine_version,omitempty"`
	AgentVersion    string `json:"agent_version,omitempty"`
}

type DBHostRegisterResponse struct {
	HostAgentID string `json:"host_agent_id"`
	DBTargetID  string `json:"db_target_id"`
	Credential  string `json:"credential"`
	// Modo combinado: el agente también se registra como agente regular en
	// `agents` con el mismo hostname, para que el host mantenga su monitoreo
	// estándar (CPU/RAM/disco/procesos) además del modo db. Estos campos
	// son la identidad del registro regular.
	AgentID         string `json:"agent_id,omitempty"`
	AgentCredential string `json:"agent_credential,omitempty"`
}

type DBHostHeartbeatRequest struct {
	AgentVersion  string         `json:"agent_version,omitempty"`
	EngineVersion string         `json:"engine_version,omitempty"`
	Sample        DBHostSample   `json:"sample"`
	DBSample      *DatabaseSample `json:"db_sample,omitempty"` // metricas BD recolectadas localmente
}
