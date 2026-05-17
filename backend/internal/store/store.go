package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

var ErrNotFound = errors.New("not found")
var ErrUnauthorized = errors.New("unauthorized")
var ErrInvalidEnrollmentToken = errors.New("invalid enrollment token")

type Store struct {
	pool *pgxpool.Pool

	// Pools dedicados por DB target: amortiza handshakes en endpoints live.
	dbTargetPools   map[string]*pgxpool.Pool
	dbTargetPoolsMu sync.RWMutex

	// Schema migration once-guards: DDL runs exactly once at startup, never on hot paths.
	onceV3Schema           sync.Once
	onceV3SchemaErr        error
	onceV31Schema          sync.Once
	onceV31SchemaErr       error
	onceV32Schema          sync.Once
	onceV32SchemaErr       error
	onceAlertRules         sync.Once
	onceAlertRulesErr      error
	onceAlertContext       sync.Once
	onceAlertContextErr    error
	onceNetworkIface       sync.Once
	onceNetworkIfaceErr    error
	onceDBMonitor          sync.Once
	onceDBMonitorErr       error
	onceDBHostAgent        sync.Once
	onceDBHostAgentErr     error
}

type User struct {
	ID           string
	Username     string
	PasswordHash string
}

type EnrollmentTokenResult struct {
	ID                    string `json:"id"`
	Token                 string `json:"token"`
	ExpiresAt             string `json:"expires_at"`
	InstallCommand        string `json:"install_command"`
	LinuxInstallCommand   string `json:"linux_install_command"`
	WindowsInstallCommand string `json:"windows_install_command"`
	ReleaseVersion        string `json:"release_version"`
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 4
	config.MinConns = 0
	config.MaxConnIdleTime = 30 * time.Second
	config.MaxConnLifetime = 15 * time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	store := &Store{pool: pool, dbTargetPools: make(map[string]*pgxpool.Pool)}
	// Run all schema migrations sequentially at startup so hot paths never run DDL.
	for _, migrate := range []func(context.Context) error{
		store.ensureRuntimeSchema,
		store.EnsureV3Schema,
		store.EnsureV31Schema,
		store.EnsureV32Schema,
		store.ensureAlertRulesSchema,
		store.ensureAlertContextSchema,
		store.ensureNetworkInterfaceSchema,
		store.ensureDBMonitorSchema,
		store.ensureDBHostAgentSchema,
	} {
		if err := migrate(ctx); err != nil {
			pool.Close()
			return nil, err
		}
	}
	return store, nil
}

func (s *Store) Close() {
	s.closeAllTargetPools()
	s.pool.Close()
}

func (s *Store) ensureRuntimeSchema(ctx context.Context) error {
	statements := []string{
		"ALTER TABLE metric_samples ADD COLUMN IF NOT EXISTS swap_total_bytes BIGINT NOT NULL DEFAULT 0",
		"ALTER TABLE metric_samples ADD COLUMN IF NOT EXISTS swap_used_bytes BIGINT NOT NULL DEFAULT 0",
		"ALTER TABLE metric_samples ADD COLUMN IF NOT EXISTS swap_used_percent DOUBLE PRECISION NOT NULL DEFAULT 0",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_version TEXT DEFAULT ''",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS primary_ip TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS custom_rules_enabled BOOLEAN NOT NULL DEFAULT false",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS interval_seconds INTEGER NOT NULL DEFAULT 60",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS service_checks TEXT[] NOT NULL DEFAULT '{}'",
		"ALTER TABLE agents ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT 'balanced'",
		`CREATE TABLE IF NOT EXISTS agent_commands (
			id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			command      TEXT NOT NULL,
			params       JSONB DEFAULT '{}'::jsonb,
			status       TEXT NOT NULL DEFAULT 'pending',
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			delivered_at TIMESTAMPTZ,
			completed_at TIMESTAMPTZ,
			result       JSONB,
			error        TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_status ON agent_commands(agent_id, status, created_at)",
		`CREATE TABLE IF NOT EXISTS network_samples (
			id BIGSERIAL PRIMARY KEY,
			metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			name TEXT NOT NULL,
			bytes_sent BIGINT NOT NULL,
			bytes_recv BIGINT NOT NULL,
			up BOOLEAN NOT NULL DEFAULT false
		)`,
		"CREATE INDEX IF NOT EXISTS network_samples_agent_time_idx ON network_samples(agent_id, captured_at DESC)",
		`CREATE TABLE IF NOT EXISTS process_samples (
			id BIGSERIAL PRIMARY KEY,
			metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			pid INTEGER NOT NULL,
			name TEXT NOT NULL,
			cpu_percent DOUBLE PRECISION NOT NULL,
			memory_percent DOUBLE PRECISION NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS process_samples_agent_time_idx ON process_samples(agent_id, captured_at DESC)",
		`CREATE TABLE IF NOT EXISTS service_samples (
			id BIGSERIAL PRIMARY KEY,
			metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			name TEXT NOT NULL,
			status TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS service_samples_agent_time_idx ON service_samples(agent_id, captured_at DESC)",
	}
	for _, statement := range statements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) EnsureAdmin(ctx context.Context, username, password string) error {
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, "INSERT INTO users (username, password_hash) VALUES ($1, $2)", username, string(hash))
	return err
}

func (s *Store) AuthenticateUser(ctx context.Context, username, password string) (*User, error) {
	var user User
	err := s.pool.QueryRow(ctx, "SELECT id::text, username, password_hash FROM users WHERE username = $1", username).
		Scan(&user.ID, &user.Username, &user.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return nil, ErrUnauthorized
	}
	return &user, nil
}

func (s *Store) RegisterAgent(ctx context.Context, req models.AgentRegisterRequest) (*models.AgentAuthResponse, error) {
	credential, err := randomToken(32)
	if err != nil {
		return nil, err
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var tokenID string
	err = tx.QueryRow(ctx, `
		SELECT id::text
		FROM enrollment_tokens
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		FOR UPDATE
	`, hashSecret(req.EnrollmentToken)).Scan(&tokenID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidEnrollmentToken
	}
	if err != nil {
		return nil, err
	}

	name := req.Name
	if name == "" {
		name = req.Hostname
	}

	// Reuse existing agent if same hostname (reinstall/update scenario)
	var agentID string
	existErr := tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE hostname = $1`, req.Hostname).Scan(&agentID)
	if existErr == nil {
		// Agent exists — rotate credential only, preserve history
		if _, err = tx.Exec(ctx, `
			UPDATE agents SET credential_hash=$1, os=$2, arch=$3,
			    primary_ip=COALESCE(NULLIF($5, ''), primary_ip),
			    status='online', last_seen_at=now(), updated_at=now()
			WHERE id=$4
		`, hashSecret(credential), req.OS, req.Arch, agentID, req.PrimaryIP); err != nil {
			return nil, err
		}
	} else {
		err = tx.QueryRow(ctx, `
			INSERT INTO agents (name, hostname, os, arch, uptime_seconds, credential_hash, status, last_seen_at, primary_ip)
			VALUES ($1, $2, $3, $4, $5, $6, 'online', now(), COALESCE($7, ''))
			RETURNING id::text
		`, name, req.Hostname, req.OS, req.Arch, int64(req.UptimeSeconds), hashSecret(credential), req.PrimaryIP).Scan(&agentID)
		if err != nil {
			return nil, err
		}
	}

	if _, err := tx.Exec(ctx, "UPDATE enrollment_tokens SET used_at = now() WHERE id = $1", tokenID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &models.AgentAuthResponse{AgentID: agentID, Credential: credential}, nil
}

func (s *Store) AuthenticateAgent(ctx context.Context, credential string) (string, error) {
	var agentID string
	err := s.pool.QueryRow(ctx, "SELECT id::text FROM agents WHERE credential_hash = $1", hashSecret(credential)).Scan(&agentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnauthorized
	}
	return agentID, err
}

func (s *Store) Heartbeat(ctx context.Context, agentID string, req models.HeartbeatRequest) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE agents
		SET name = COALESCE(NULLIF($2, ''), name),
		    hostname = COALESCE(NULLIF($3, ''), hostname),
		    os = COALESCE(NULLIF($4, ''), os),
		    arch = COALESCE(NULLIF($5, ''), arch),
		    uptime_seconds = $6,
		    primary_ip = COALESCE(NULLIF($7, ''), primary_ip),
		    last_seen_at = now(),
		    updated_at = now()
		WHERE id = $1
	`, agentID, req.Name, req.Hostname, req.OS, req.Arch, int64(req.UptimeSeconds), req.PrimaryIP)
	return err
}

// MarkAgentOffline fuerza el estado del agente a offline tras una notificación
// de shutdown. Mueve last_seen_at hacia atrás para que el cálculo dinámico de
// status (basado en OFFLINE_AFTER_SECONDS) lo reporte offline inmediatamente.
// El siguiente heartbeat lo restaura a online de forma natural.
func (s *Store) MarkAgentOffline(ctx context.Context, agentID, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE agents
		SET status = 'offline',
		    last_seen_at = now() - interval '24 hours',
		    updated_at = now()
		WHERE id = $1
	`, agentID)
	return err
}

func (s *Store) InsertMetrics(ctx context.Context, agentID string, req models.MetricsRequest) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var sampleID int64
	err = tx.QueryRow(ctx, `
		INSERT INTO metric_samples
			(agent_id, cpu_percent, memory_total_bytes, memory_used_bytes, memory_used_percent, swap_total_bytes, swap_used_bytes, swap_used_percent)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id
	`, agentID, req.CPUPercent, int64(req.MemoryTotalBytes), int64(req.MemoryUsedBytes), req.MemoryUsedPercent, int64(req.SwapTotalBytes), int64(req.SwapUsedBytes), req.SwapUsedPercent).Scan(&sampleID)
	if err != nil {
		return err
	}

	for _, disk := range req.Disks {
		_, err = tx.Exec(ctx, `
			INSERT INTO disk_samples
				(metric_sample_id, agent_id, name, mountpoint, filesystem, total_bytes, used_bytes, free_bytes, used_percent)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, sampleID, agentID, disk.Name, disk.Mountpoint, disk.Filesystem, int64(disk.TotalBytes), int64(disk.UsedBytes), int64(disk.FreeBytes), disk.UsedPercent)
		if err != nil {
			return err
		}
	}
	for _, network := range req.Networks {
		_, err = tx.Exec(ctx, `
			INSERT INTO network_samples
				(metric_sample_id, agent_id, name, bytes_sent, bytes_recv, up)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, sampleID, agentID, network.Name, int64(network.BytesSent), int64(network.BytesRecv), network.Up)
		if err != nil {
			return err
		}
	}
	for _, proc := range req.Processes {
		_, err = tx.Exec(ctx, `
			INSERT INTO process_samples
				(metric_sample_id, agent_id, pid, name, cpu_percent, memory_percent)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, sampleID, agentID, proc.PID, proc.Name, proc.CPUPercent, float64(proc.MemoryPercent))
		if err != nil {
			return err
		}
	}
	for _, service := range req.Services {
		_, err = tx.Exec(ctx, `
			INSERT INTO service_samples
				(metric_sample_id, agent_id, name, status)
			VALUES ($1, $2, $3, $4)
		`, sampleID, agentID, service.Name, service.Status)
		if err != nil {
			return err
		}
	}

	status, activeKeys, err := evaluateAlerts(ctx, tx, agentID, req)
	if err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE agents SET status = $2, last_seen_at = now(), updated_at = now() WHERE id = $1
	`, agentID, status); err != nil {
		return err
	}
	if err := resolveRecoveredAlerts(ctx, tx, agentID, activeKeys); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) DashboardSummary(ctx context.Context, offlineAfterSeconds int) (map[string]any, error) {
	row := s.pool.QueryRow(ctx, `
		WITH latest AS (
		  SELECT DISTINCT ON (agent_id) agent_id, cpu_percent, memory_used_percent
		  FROM metric_samples
		  ORDER BY agent_id, captured_at DESC
		), agent_state AS (
		  SELECT a.id,
		         CASE WHEN a.last_seen_at IS NULL OR a.last_seen_at < now() - ($1::int * interval '1 second')
		              THEN 'offline' ELSE a.status END AS effective_status,
		         l.cpu_percent,
		         l.memory_used_percent
		  FROM agents a
		  LEFT JOIN latest l ON l.agent_id = a.id
		  WHERE a.status != 'system'
		    AND a.hostname NOT IN (
		      SELECT hostname FROM db_host_agents
		      WHERE last_seen_at IS NOT NULL
		        AND last_seen_at > now() - interval '180 seconds'
		        AND hostname != ''
		    )
		), latest_disks AS (
		  SELECT DISTINCT ON (agent_id, mountpoint) agent_id, mountpoint, used_percent
		  FROM disk_samples
		  ORDER BY agent_id, mountpoint, captured_at DESC
		), latest_network AS (
		  SELECT DISTINCT ON (agent_id, name) agent_id, name, bytes_sent, bytes_recv
		  FROM network_samples
		  ORDER BY agent_id, name, captured_at DESC
		), latest_services AS (
		  SELECT DISTINCT ON (agent_id, name) agent_id, name, status
		  FROM service_samples
		  ORDER BY agent_id, name, captured_at DESC
		)
		SELECT
		  count(*)::int,
		  count(*) FILTER (WHERE effective_status = 'online')::int,
		  count(*) FILTER (WHERE effective_status = 'warning')::int,
		  count(*) FILTER (WHERE effective_status = 'critical')::int,
		  count(*) FILTER (WHERE effective_status = 'offline')::int,
		  COALESCE(avg(cpu_percent), 0)::float8,
		  COALESCE(avg(memory_used_percent), 0)::float8,
		  (SELECT count(*)::int FROM alerts WHERE active = true),
		  (SELECT count(*)::int FROM latest_disks WHERE used_percent >= 90),
		  COALESCE((SELECT sum(bytes_sent + bytes_recv)::bigint FROM latest_network), 0),
		  (SELECT count(*)::int FROM latest_services WHERE status <> 'running')
		FROM agent_state
	`, offlineAfterSeconds)

	var total, online, warning, critical, offline, activeAlerts, criticalDisks, servicesDown int
	var networkBytes int64
	var avgCPU, avgRAM float64
	if err := row.Scan(&total, &online, &warning, &critical, &offline, &avgCPU, &avgRAM, &activeAlerts, &criticalDisks, &networkBytes, &servicesDown); err != nil {
		return nil, err
	}
	return map[string]any{
		"total_agents":        total,
		"online_agents":       online,
		"warning_agents":      warning,
		"critical_agents":     critical,
		"offline_agents":      offline,
		"active_alerts":       activeAlerts,
		"avg_cpu_percent":     avgCPU,
		"avg_memory_percent":  avgRAM,
		"critical_disks":      criticalDisks,
		"network_total_bytes": networkBytes,
		"services_down":       servicesDown,
	}, nil
}

func (s *Store) ListAgents(ctx context.Context, offlineAfterSeconds int, search string, tagFilter ...string) ([]models.Agent, error) {
	tag := ""
	if len(tagFilter) > 0 {
		tag = tagFilter[0]
	}
	rows, err := s.pool.Query(ctx, `
		WITH latest AS (
		  SELECT DISTINCT ON (agent_id) agent_id, captured_at, cpu_percent, memory_used_percent
		  FROM metric_samples
		  ORDER BY agent_id, captured_at DESC
		), latest_disks AS (
		  SELECT DISTINCT ON (agent_id, mountpoint) agent_id, mountpoint
		  FROM disk_samples
		  ORDER BY agent_id, mountpoint, captured_at DESC
		), alert_counts AS (
		  SELECT agent_id, count(*)::int AS active_alerts
		  FROM alerts
		  WHERE active = true
		  GROUP BY agent_id
		), disk_counts AS (
		  SELECT agent_id, count(*)::int AS disk_count
		  FROM latest_disks
		  GROUP BY agent_id
		), last_cmd AS (
		  SELECT DISTINCT ON (agent_id) agent_id, id::text, command, status, created_at, completed_at, COALESCE(error, '') AS error
		  FROM agent_commands
		  WHERE status IN ('pending','delivered')
		     OR (status IN ('completed','failed') AND created_at > now() - interval '5 minutes')
		  ORDER BY agent_id, created_at DESC
		)
		SELECT a.id::text, a.name, a.hostname, a.os, a.arch, a.uptime_seconds,
		       CASE WHEN a.last_seen_at IS NULL OR a.last_seen_at < now() - ($1::int * interval '1 second')
		            THEN 'offline' ELSE a.status END AS effective_status,
		       a.last_seen_at, a.created_at, l.cpu_percent, l.memory_used_percent, l.captured_at,
		       COALESCE(ac.active_alerts, 0), COALESCE(dc.disk_count, 0), COALESCE(a.tags, '{}'),
		       COALESCE(a.agent_version, ''),
		       COALESCE(a.primary_ip, ''),
		       COALESCE(a.profile, 'balanced'),
		       lc.id, lc.command, lc.status, lc.created_at, lc.completed_at, lc.error
		FROM agents a
		LEFT JOIN latest l ON l.agent_id = a.id
		LEFT JOIN alert_counts ac ON ac.agent_id = a.id
		LEFT JOIN disk_counts dc ON dc.agent_id = a.id
		LEFT JOIN last_cmd lc ON lc.agent_id = a.id
		WHERE a.status != 'system'
		  AND a.hostname NOT IN (
		    SELECT hostname FROM db_host_agents
		    WHERE last_seen_at IS NOT NULL
		      AND last_seen_at > now() - interval '180 seconds'
		      AND hostname != ''
		  )
		  AND ($2 = '' OR a.name ILIKE '%' || $2 || '%' OR a.hostname ILIKE '%' || $2 || '%')
		  AND ($3 = '' OR $3 = ANY(a.tags))
		ORDER BY a.last_seen_at DESC NULLS LAST, a.name
	`, offlineAfterSeconds, search, tag)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	agents := []models.Agent{}
	for rows.Next() {
		var agent models.Agent
		var uptime int64
		var cmdID, cmdCommand, cmdStatus, cmdError *string
		var cmdCreated, cmdCompleted *time.Time
		if err := rows.Scan(&agent.ID, &agent.Name, &agent.Hostname, &agent.OS, &agent.Arch, &uptime, &agent.Status, &agent.LastSeenAt, &agent.CreatedAt, &agent.CPUPercent, &agent.MemoryPercent, &agent.LastMetricAt, &agent.ActiveAlerts, &agent.DiskCount, &agent.Tags, &agent.AgentVersion, &agent.PrimaryIP, &agent.Profile,
			&cmdID, &cmdCommand, &cmdStatus, &cmdCreated, &cmdCompleted, &cmdError); err != nil {
			return nil, err
		}
		if cmdID != nil && *cmdID != "" {
			agent.LastCommand = &models.AgentCommandSummary{
				ID:          *cmdID,
				Command:     stringValue(cmdCommand),
				Status:      stringValue(cmdStatus),
				CreatedAt:   timeValue(cmdCreated),
				CompletedAt: cmdCompleted,
				Error:       stringValue(cmdError),
			}
		}
		if agent.Tags == nil {
			agent.Tags = []string{}
		}
		agent.UptimeSeconds = uint64(uptime)
		// Si el equipo esta offline, las metricas del ultimo sample son
		// engañosas (pueden mostrar CPU/RAM altos del momento que se desconecto).
		// OfflineStatusZero pone CPU/RAM a 0 para evitar lecturas "stale".
		OfflineStatusZero(&agent)
		agents = append(agents, agent)
	}
	return agents, rows.Err()
}

func (s *Store) AgentDetail(ctx context.Context, id string, offlineAfterSeconds int) (map[string]any, error) {
	agents, err := s.ListAgents(ctx, offlineAfterSeconds, "")
	if err != nil {
		return nil, err
	}
	var agent *models.Agent
	for i := range agents {
		if agents[i].ID == id {
			agent = &agents[i]
			break
		}
	}
	if agent == nil {
		return nil, ErrNotFound
	}

	disks, err := s.latestDisks(ctx, id)
	if err != nil {
		return nil, err
	}
	networks, err := s.latestNetworks(ctx, id)
	if err != nil {
		return nil, err
	}
	processes, err := s.latestProcesses(ctx, id)
	if err != nil {
		return nil, err
	}
	services, err := s.latestServices(ctx, id)
	if err != nil {
		return nil, err
	}
	temperatures, err := s.latestTemperatures(ctx, id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"agent": agent, "disks": disks, "networks": networks, "processes": processes, "services": services, "temperatures": temperatures}, nil
}

func (s *Store) UpdateAgentName(ctx context.Context, id, name string) error {
	if strings.TrimSpace(name) == "" {
		return fmt.Errorf("agent name is required")
	}
	tag, err := s.pool.Exec(ctx, "UPDATE agents SET name = $2, updated_at = now() WHERE id = $1", id, strings.TrimSpace(name))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteAgent(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, "DELETE FROM agents WHERE id = $1", id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AgentStatus(ctx context.Context, id string, offlineAfterSeconds int) (map[string]any, error) {
	var agentID, name, status string
	var lastSeenAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name,
		       CASE WHEN last_seen_at IS NULL OR last_seen_at < now() - ($2::int * interval '1 second')
		            THEN 'offline' ELSE status END AS effective_status,
		       last_seen_at
		FROM agents
		WHERE id = $1
	`, id, offlineAfterSeconds).Scan(&agentID, &name, &status, &lastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	var capturedAt time.Time
	var cpu, memory float64
	var lastMetricAt *time.Time
	var lastCPU, lastMemory *float64
	err = s.pool.QueryRow(ctx, `
		SELECT captured_at, cpu_percent, memory_used_percent
		FROM metric_samples
		WHERE agent_id = $1
		ORDER BY captured_at DESC
		LIMIT 1
	`, id).Scan(&capturedAt, &cpu, &memory)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err == nil {
		lastMetricAt = &capturedAt
		lastCPU = &cpu
		lastMemory = &memory
	}

	var activeAlerts int
	if err := s.pool.QueryRow(ctx, "SELECT count(*)::int FROM alerts WHERE agent_id = $1 AND active = true", id).Scan(&activeAlerts); err != nil {
		return nil, err
	}
	return map[string]any{
		"agent_id":              agentID,
		"name":                  name,
		"status":                status,
		"is_offline":            status == models.StatusOffline,
		"last_seen_at":          lastSeenAt,
		"last_metric_at":        lastMetricAt,
		"cpu_percent":           lastCPU,
		"memory_used_percent":   lastMemory,
		"active_alerts":         activeAlerts,
		"offline_after_seconds": offlineAfterSeconds,
	}, nil
}

func (s *Store) ListAlerts(ctx context.Context, activeOnly bool) ([]models.Alert, error) {
	query := `
		SELECT al.id::text, al.agent_id::text, a.name, al.type, al.severity, al.message,
		       al.active, al.opened_at, al.resolved_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		WHERE ($1 = false OR al.active = true)
		ORDER BY al.active DESC, al.opened_at DESC
	`
	rows, err := s.pool.Query(ctx, query, activeOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	alerts := []models.Alert{}
	for rows.Next() {
		var alert models.Alert
		if err := rows.Scan(&alert.ID, &alert.AgentID, &alert.AgentName, &alert.Type, &alert.Severity, &alert.Message, &alert.Active, &alert.OpenedAt, &alert.ResolvedAt); err != nil {
			return nil, err
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}

func (s *Store) DeleteOldMetrics(ctx context.Context, days int) error {
	if days <= 0 {
		days = 30
	}
	if _, err := s.pool.Exec(ctx, "DELETE FROM metric_samples WHERE captured_at < now() - ($1::int * interval '1 day')", days); err != nil {
		return err
	}
	// DB samples — same window; table may not exist yet, ignore that error.
	_, dbErr := s.pool.Exec(ctx, "DELETE FROM db_samples WHERE captured_at < now() - ($1::int * interval '1 day')", days)
	if dbErr != nil && !isUndefinedTable(dbErr) {
		log.Printf("db_samples retention: %v", dbErr)
	}
	return nil
}

func isUndefinedTable(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "undefined_table"))
}

func (s *Store) latestDisks(ctx context.Context, agentID string) ([]models.DiskMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (mountpoint)
		       name, mountpoint, filesystem, total_bytes, used_bytes, free_bytes, used_percent
		FROM disk_samples
		WHERE agent_id = $1
		ORDER BY mountpoint, captured_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	disks := []models.DiskMetric{}
	for rows.Next() {
		var disk models.DiskMetric
		var total, used, free int64
		if err := rows.Scan(&disk.Name, &disk.Mountpoint, &disk.Filesystem, &total, &used, &free, &disk.UsedPercent); err != nil {
			return nil, err
		}
		disk.TotalBytes = uint64(total)
		disk.UsedBytes = uint64(used)
		disk.FreeBytes = uint64(free)
		disks = append(disks, disk)
	}
	return disks, rows.Err()
}

func (s *Store) latestNetworks(ctx context.Context, agentID string) ([]models.NetMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (name)
		       name, bytes_sent, bytes_recv, up
		FROM network_samples
		WHERE agent_id = $1
		ORDER BY name, captured_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	networks := []models.NetMetric{}
	for rows.Next() {
		var network models.NetMetric
		var sent, recv int64
		if err := rows.Scan(&network.Name, &sent, &recv, &network.Up); err != nil {
			return nil, err
		}
		network.BytesSent = uint64(sent)
		network.BytesRecv = uint64(recv)
		networks = append(networks, network)
	}
	return networks, rows.Err()
}

func (s *Store) latestProcesses(ctx context.Context, agentID string) ([]models.ProcMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pid, name, cpu_percent, memory_percent
		FROM process_samples
		WHERE metric_sample_id = (
			SELECT id FROM metric_samples
			WHERE agent_id = $1
			  AND captured_at > now() - interval '1 hour'
			ORDER BY captured_at DESC LIMIT 1
		)
		ORDER BY cpu_percent DESC, memory_percent DESC
		LIMIT 50
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	processes := []models.ProcMetric{}
	for rows.Next() {
		var proc models.ProcMetric
		var memory float64
		if err := rows.Scan(&proc.PID, &proc.Name, &proc.CPUPercent, &memory); err != nil {
			return nil, err
		}
		proc.MemoryPercent = float32(memory)
		processes = append(processes, proc)
	}
	return processes, rows.Err()
}

func (s *Store) latestServices(ctx context.Context, agentID string) ([]models.SvcMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (name)
		       name, status
		FROM service_samples
		WHERE agent_id = $1
		ORDER BY name, captured_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	services := []models.SvcMetric{}
	for rows.Next() {
		var service models.SvcMetric
		if err := rows.Scan(&service.Name, &service.Status); err != nil {
			return nil, err
		}
		services = append(services, service)
	}
	return services, rows.Err()
}

func (s *Store) latestTemperatures(ctx context.Context, agentID string) ([]models.TempMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT DISTINCT ON (sensor_key)
		       sensor_key, temperature_c
		FROM temperature_samples
		WHERE agent_id = $1
		  AND captured_at > now() - interval '1 hour'
		ORDER BY sensor_key, captured_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	temps := []models.TempMetric{}
	for rows.Next() {
		var t models.TempMetric
		if err := rows.Scan(&t.SensorKey, &t.TemperatureC); err != nil {
			return nil, err
		}
		temps = append(temps, t)
	}
	return temps, rows.Err()
}

func evaluateAlerts(ctx context.Context, tx pgx.Tx, agentID string, req models.MetricsRequest) (string, map[string]bool, error) {
	status := models.StatusOnline
	activeKeys := map[string]bool{}

	if req.CPUPercent >= 95 {
		status = models.StatusCritical
		activeKeys["cpu:"] = true
		if err := upsertAlert(ctx, tx, agentID, "cpu", "", "critical", fmt.Sprintf("CPU en %.1f%%", req.CPUPercent)); err != nil {
			return "", nil, err
		}
	} else if req.CPUPercent >= 85 {
		status = maxStatus(status, models.StatusWarning)
		activeKeys["cpu:"] = true
		if err := upsertAlert(ctx, tx, agentID, "cpu", "", "warning", fmt.Sprintf("CPU en %.1f%%", req.CPUPercent)); err != nil {
			return "", nil, err
		}
	}

	if req.MemoryUsedPercent >= 95 {
		status = models.StatusCritical
		activeKeys["memory:"] = true
		if err := upsertAlert(ctx, tx, agentID, "memory", "", "critical", fmt.Sprintf("RAM en %.1f%%", req.MemoryUsedPercent)); err != nil {
			return "", nil, err
		}
	} else if req.MemoryUsedPercent >= 85 {
		status = maxStatus(status, models.StatusWarning)
		activeKeys["memory:"] = true
		if err := upsertAlert(ctx, tx, agentID, "memory", "", "warning", fmt.Sprintf("RAM en %.1f%%", req.MemoryUsedPercent)); err != nil {
			return "", nil, err
		}
	}

	for _, disk := range req.Disks {
		key := disk.Mountpoint
		if key == "" {
			key = disk.Name
		}
		if disk.UsedPercent >= 90 {
			status = models.StatusCritical
			activeKeys["disk:"+key] = true
			if err := upsertAlert(ctx, tx, agentID, "disk", key, "critical", fmt.Sprintf("Disco %s en %.1f%%", key, disk.UsedPercent)); err != nil {
				return "", nil, err
			}
		} else if disk.UsedPercent >= 80 {
			status = maxStatus(status, models.StatusWarning)
			activeKeys["disk:"+key] = true
			if err := upsertAlert(ctx, tx, agentID, "disk", key, "warning", fmt.Sprintf("Disco %s en %.1f%%", key, disk.UsedPercent)); err != nil {
				return "", nil, err
			}
		}
	}
	return status, activeKeys, nil
}

func upsertAlert(ctx context.Context, tx pgx.Tx, agentID, alertType, resourceKey, severity, message string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO alerts (agent_id, type, resource_key, severity, message)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (agent_id, type, resource_key) WHERE active = true
		DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, last_seen_at = now()
	`, agentID, alertType, resourceKey, severity, message)
	return err
}

func resolveRecoveredAlerts(ctx context.Context, tx pgx.Tx, agentID string, activeKeys map[string]bool) error {
	// agent_offline_minutes es exclusivo de evaluateAgentOfflineAlert — no tocarlo
	// aquí para evitar contención de locks con esa goroutine.
	// ORDER BY id garantiza orden consistente de adquisición de locks.
	rows, err := tx.Query(ctx, `
		SELECT id::text, type, resource_key
		FROM alerts
		WHERE agent_id = $1 AND active = true AND type != 'agent_offline_minutes'
		ORDER BY id
	`, agentID)
	if err != nil {
		return err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id, alertType, resourceKey string
		if err := rows.Scan(&id, &alertType, &resourceKey); err != nil {
			return err
		}
		if !activeKeys[alertType+":"+resourceKey] {
			ids = append(ids, id)
		}
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, "UPDATE alerts SET active = false, resolved_at = now() WHERE id = $1", id); err != nil {
			return err
		}
	}
	return nil
}

func maxStatus(current, candidate string) string {
	if current == models.StatusCritical || candidate == models.StatusCritical {
		return models.StatusCritical
	}
	if current == models.StatusWarning || candidate == models.StatusWarning {
		return models.StatusWarning
	}
	return models.StatusOnline
}

func randomToken(size int) (string, error) {
	bytes := make([]byte, size)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

