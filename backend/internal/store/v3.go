package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/smtp"
	"sort"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) EnsureV3Schema(ctx context.Context) error {
	statements := []string{
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notification_count INTEGER NOT NULL DEFAULT 0",
		`CREATE TABLE IF NOT EXISTS smtp_settings (
			id INTEGER PRIMARY KEY DEFAULT 1,
			enabled BOOLEAN NOT NULL DEFAULT false,
			host TEXT NOT NULL DEFAULT '',
			port INTEGER NOT NULL DEFAULT 587,
			username TEXT NOT NULL DEFAULT '',
			password TEXT NOT NULL DEFAULT '',
			from_address TEXT NOT NULL DEFAULT '',
			to_addresses TEXT NOT NULL DEFAULT '',
			use_tls BOOLEAN NOT NULL DEFAULT false,
			use_starttls BOOLEAN NOT NULL DEFAULT true,
			cooldown_minutes INTEGER NOT NULL DEFAULT 30,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			CONSTRAINT smtp_settings_singleton CHECK (id = 1)
		)`,
		"INSERT INTO smtp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
	}
	for _, stmt := range statements {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) CreateEnrollmentTokenAdvanced(ctx context.Context, userID, name string, ttlHours int, serverURL, downloadURL, agentName, installStyle, releaseVersion, profile, services string, interval int) (*EnrollmentTokenResult, error) {
	if ttlHours <= 0 {
		ttlHours = 24
	}
	if name == "" {
		name = "Agent enrollment"
	}
	if releaseVersion == "" {
		releaseVersion = "latest"
	}
	token, err := randomTokenV3(32)
	if err != nil {
		return nil, err
	}
	expiresAt := time.Now().UTC().Add(time.Duration(ttlHours) * time.Hour)
	var id string
	if err := s.pool.QueryRow(ctx, `
		INSERT INTO enrollment_tokens (token_hash, name, expires_at, created_by)
		VALUES ($1, $2, $3, NULLIF($4, '')::uuid)
		RETURNING id::text
	`, hashSecretV3(token), name, expiresAt, userID).Scan(&id); err != nil {
		return nil, err
	}
	linux := installCommandV3(serverURL, downloadURL, token, agentName, "linux", releaseVersion, profile, services, interval)
	windows := installCommandV3(serverURL, downloadURL, token, agentName, "windows", releaseVersion, profile, services, interval)
	selected := linux
	if strings.EqualFold(installStyle, "windows") {
		selected = windows
	}
	return &EnrollmentTokenResult{
		ID:                    id,
		Token:                 token,
		ExpiresAt:             expiresAt.Format(time.RFC3339),
		InstallCommand:        selected,
		LinuxInstallCommand:   linux,
		WindowsInstallCommand: windows,
		ReleaseVersion:        releaseVersion,
	}, nil
}

func (s *Store) DashboardOverview(ctx context.Context, offlineAfterSeconds int) (map[string]any, error) {
	summary, err := s.DashboardSummary(ctx, offlineAfterSeconds)
	if err != nil {
		return nil, err
	}
	agents, err := s.ListAgents(ctx, offlineAfterSeconds, "")
	if err != nil {
		return nil, err
	}
	alerts, err := s.ListAlerts(ctx, true)
	if err != nil {
		return nil, err
	}
	distribution := map[string]int{"online": 0, "warning": 0, "critical": 0, "offline": 0}
	stale := []models.Agent{}
	now := time.Now()
	for _, agent := range agents {
		distribution[agent.Status]++
		if agent.LastMetricAt == nil || now.Sub(*agent.LastMetricAt) > 10*time.Minute {
			stale = append(stale, agent)
		}
	}
	summary["status_distribution"] = distribution
	summary["top_cpu"] = topAgentsV3(agents, func(a models.Agent) float64 { return ptrFloatV3(a.CPUPercent) })
	summary["top_memory"] = topAgentsV3(agents, func(a models.Agent) float64 { return ptrFloatV3(a.MemoryPercent) })
	summary["stale_agents"] = limitAgentsV3(stale, 8)
	if len(alerts) > 8 {
		alerts = alerts[:8]
	}
	summary["recent_alerts"] = alerts
	return summary, nil
}

func (s *Store) AgentDetailV3(ctx context.Context, id string, offlineAfterSeconds int) (map[string]any, error) {
	detail, err := s.AgentDetail(ctx, id, offlineAfterSeconds)
	if err != nil {
		return nil, err
	}
	status, err := s.AgentStatus(ctx, id, offlineAfterSeconds)
	if err == nil {
		detail["status_reason"] = statusReasonV3(status)
		detail["operational_status"] = status
	}
	alerts, err := s.agentAlerts(ctx, id)
	if err == nil {
		detail["alerts"] = alerts
	}
	detail["diagnostics"] = map[string]any{
		"linux": []string{
			"resource-monitor-agent status --config /etc/resource-monitor-agent/config.json",
			"resource-monitor-agent doctor --config /etc/resource-monitor-agent/config.json",
			"journalctl -u resource-monitor-agent -f",
		},
		"windows": []string{
			"& 'C:\\Program Files\\ResourceMonitorAgent\\resource-monitor-agent.exe' status",
			"& 'C:\\Program Files\\ResourceMonitorAgent\\resource-monitor-agent.exe' doctor",
			"Get-Service resource-monitor-agent",
		},
	}
	return detail, nil
}

func (s *Store) AgentHistory(ctx context.Context, agentID, rangeName string) (map[string]any, error) {
	window, bucket := historyWindowV3(rangeName)
	metrics, err := s.historyMetricsV3(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	networks, err := s.historyNetworksV3(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	disks, err := s.historyDisksV3(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"range":        rangeName,
		"window":       window,
		"bucket":       bucket,
		"metrics":      metrics,
		"networks":     networks,
		"disks":        disks,
		"compatibility": "older agents may only include cpu, memory and disk metrics",
	}, nil
}

func (s *Store) GetSMTPSettings(ctx context.Context) (models.SMTPSettings, error) {
	if err := s.EnsureV3Schema(ctx); err != nil {
		return models.SMTPSettings{}, err
	}
	var settings models.SMTPSettings
	err := s.pool.QueryRow(ctx, `
		SELECT enabled, host, port, username, password, from_address, to_addresses, use_tls, use_starttls, cooldown_minutes
		FROM smtp_settings WHERE id = 1
	`).Scan(&settings.Enabled, &settings.Host, &settings.Port, &settings.Username, &settings.Password, &settings.FromAddress, &settings.ToAddresses, &settings.UseTLS, &settings.UseStartTLS, &settings.CooldownMinutes)
	return settings, err
}

func (s *Store) SaveSMTPSettings(ctx context.Context, settings models.SMTPSettings) (models.SMTPSettings, error) {
	if err := s.EnsureV3Schema(ctx); err != nil {
		return models.SMTPSettings{}, err
	}
	if settings.Port == 0 {
		settings.Port = 587
	}
	if settings.CooldownMinutes <= 0 {
		settings.CooldownMinutes = 30
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO smtp_settings (id, enabled, host, port, username, password, from_address, to_addresses, use_tls, use_starttls, cooldown_minutes, updated_at)
		VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
		ON CONFLICT (id) DO UPDATE SET
		  enabled = EXCLUDED.enabled,
		  host = EXCLUDED.host,
		  port = EXCLUDED.port,
		  username = EXCLUDED.username,
		  password = EXCLUDED.password,
		  from_address = EXCLUDED.from_address,
		  to_addresses = EXCLUDED.to_addresses,
		  use_tls = EXCLUDED.use_tls,
		  use_starttls = EXCLUDED.use_starttls,
		  cooldown_minutes = EXCLUDED.cooldown_minutes,
		  updated_at = now()
	`, settings.Enabled, settings.Host, settings.Port, settings.Username, settings.Password, settings.FromAddress, settings.ToAddresses, settings.UseTLS, settings.UseStartTLS, settings.CooldownMinutes)
	return settings, err
}

func (s *Store) TestSMTPSettings(ctx context.Context, settings models.SMTPSettings) error {
	if settings.Password == "" {
		current, err := s.GetSMTPSettings(ctx)
		if err == nil {
			settings.Password = current.Password
		}
	}
	if strings.TrimSpace(settings.ToAddresses) == "" {
		return fmt.Errorf("missing recipients")
	}
	return sendMailV3(settings, "Resource Monitor SMTP test", "SMTP configuration test from Resource Monitor.")
}

func (s *Store) NotifyDueAlerts(ctx context.Context) error {
	if err := s.EnsureV3Schema(ctx); err != nil {
		return err
	}
	settings, err := s.GetSMTPSettings(ctx)
	if err != nil || !settings.Enabled || settings.Host == "" || settings.FromAddress == "" || settings.ToAddresses == "" {
		return err
	}
	cooldown := settings.CooldownMinutes
	if cooldown <= 0 {
		cooldown = 30
	}
	rows, err := s.pool.Query(ctx, `
		SELECT al.id::text, a.name, al.severity, al.message, al.opened_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		WHERE al.active = true
		  AND (al.last_notified_at IS NULL OR al.last_notified_at < now() - ($1::int * interval '1 minute'))
		ORDER BY al.severity = 'critical' DESC, al.opened_at DESC
		LIMIT 10
	`, cooldown)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, agentName, severity, message string
		var openedAt time.Time
		if err := rows.Scan(&id, &agentName, &severity, &message, &openedAt); err != nil {
			return err
		}
		subject := fmt.Sprintf("[%s] Resource Monitor - %s", strings.ToUpper(severity), agentName)
		body := fmt.Sprintf("Equipo: %s\nSeveridad: %s\nAlerta: %s\nAbierta: %s\n", agentName, severity, message, openedAt.Format(time.RFC3339))
		if err := sendMailV3(settings, subject, body); err != nil {
			return err
		}
		_, err := s.pool.Exec(ctx, "UPDATE alerts SET last_notified_at = now(), notification_count = notification_count + 1 WHERE id = $1", id)
		if err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *Store) historyMetricsV3(ctx context.Context, agentID, window, bucket string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT date_bin($3::interval, captured_at, timestamptz '2000-01-01') AS bucket,
		       avg(cpu_percent), avg(memory_used_percent), avg(swap_used_percent), max(captured_at),
		       avg(gateway_latency_ms)
		FROM metric_samples
		WHERE agent_id = $1 AND captured_at >= now() - $2::interval
		GROUP BY bucket
		ORDER BY bucket
	`, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var capturedAt, lastSeen time.Time
		var cpu, memory, swap float64
		var gatewayLatency *float64
		if err := rows.Scan(&capturedAt, &cpu, &memory, &swap, &lastSeen, &gatewayLatency); err != nil {
			return nil, err
		}
		row := map[string]any{
			"captured_at":         capturedAt,
			"last_sample_at":      lastSeen,
			"cpu_percent":         cpu,
			"memory_used_percent": memory,
			"swap_used_percent":   swap,
		}
		if gatewayLatency != nil {
			row["gateway_latency_ms"] = *gatewayLatency
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Store) historyNetworksV3(ctx context.Context, agentID, window, bucket string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT date_bin($3::interval, captured_at, timestamptz '2000-01-01') AS bucket,
		       name, max(bytes_sent), max(bytes_recv), bool_or(up)
		FROM network_samples
		WHERE agent_id = $1 AND captured_at >= now() - $2::interval
		GROUP BY bucket, name
		ORDER BY bucket, name
	`, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var capturedAt time.Time
		var name string
		var sent, recv int64
		var up bool
		if err := rows.Scan(&capturedAt, &name, &sent, &recv, &up); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"captured_at": capturedAt, "name": name, "bytes_sent": sent, "bytes_recv": recv, "up": up})
	}
	return out, rows.Err()
}

func (s *Store) historyDisksV3(ctx context.Context, agentID, window, bucket string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT date_bin($3::interval, captured_at, timestamptz '2000-01-01') AS bucket,
		       mountpoint, max(used_percent)
		FROM disk_samples
		WHERE agent_id = $1 AND captured_at >= now() - $2::interval
		GROUP BY bucket, mountpoint
		ORDER BY bucket, mountpoint
	`, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var capturedAt time.Time
		var mountpoint string
		var used float64
		if err := rows.Scan(&capturedAt, &mountpoint, &used); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"captured_at": capturedAt, "mountpoint": mountpoint, "used_percent": used})
	}
	return out, rows.Err()
}

func sendMailV3(settings models.SMTPSettings, subject, body string) error {
	if settings.Port == 0 {
		settings.Port = 587
	}
	to := splitRecipientsV3(settings.ToAddresses)
	if len(to) == 0 {
		return fmt.Errorf("missing recipients")
	}
	from := settings.FromAddress
	if from == "" {
		from = settings.Username
	}
	addr := net.JoinHostPort(settings.Host, fmt.Sprint(settings.Port))
	message := bytes.Buffer{}
	message.WriteString("From: " + from + "\r\n")
	message.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	message.WriteString("Subject: " + subject + "\r\n")
	message.WriteString("MIME-Version: 1.0\r\n")
	message.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
	message.WriteString(body)
	auth := smtp.Auth(nil)
	if settings.Username != "" {
		auth = smtp.PlainAuth("", settings.Username, settings.Password, settings.Host)
	}
	if settings.UseTLS {
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: settings.Host, MinVersion: tls.VersionTLS12})
		if err != nil {
			return err
		}
		client, err := smtp.NewClient(conn, settings.Host)
		if err != nil {
			return err
		}
		defer client.Close()
		return sendWithClientV3(client, auth, from, to, message.Bytes())
	}
	client, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer client.Close()
	if settings.UseStartTLS {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: settings.Host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		}
	}
	return sendWithClientV3(client, auth, from, to, message.Bytes())
}

func sendWithClientV3(client *smtp.Client, auth smtp.Auth, from string, to []string, msg []byte) error {
	if auth != nil {
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return err
			}
		}
	}
	if err := client.Mail(from); err != nil {
		return err
	}
	for _, recipient := range to {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(msg); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func historyWindowV3(rangeName string) (string, string) {
	switch strings.ToLower(rangeName) {
	case "7d":
		return "7 days", "1 hour"
	case "30d":
		return "30 days", "6 hours"
	default:
		return "24 hours", "5 minutes"
	}
}

func statusReasonV3(status map[string]any) string {
	if status["offline"] == true || status["status"] == models.StatusOffline {
		return "Sin conexion reciente dentro del umbral offline"
	}
	if count, ok := status["active_alerts"].(int); ok && count > 0 {
		return "Tiene alertas activas que afectan el estado operativo"
	}
	return "Equipo reportando heartbeat y metricas dentro del umbral"
}

func topAgentsV3(agents []models.Agent, score func(models.Agent) float64) []models.Agent {
	copyAgents := append([]models.Agent(nil), agents...)
	sort.Slice(copyAgents, func(i, j int) bool { return score(copyAgents[i]) > score(copyAgents[j]) })
	return limitAgentsV3(copyAgents, 8)
}

func limitAgentsV3(agents []models.Agent, limit int) []models.Agent {
	if len(agents) > limit {
		return agents[:limit]
	}
	return agents
}

func ptrFloatV3(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

func splitRecipientsV3(raw string) []string {
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ',' || r == ';' || r == '\n' })
	out := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func installCommandV3(serverURL, downloadURL, token, agentName, style, releaseVersion, profile, services string, interval int) string {
	if serverURL == "" {
		serverURL = "https://monitor.example.com"
	}
	if releaseVersion == "" {
		releaseVersion = "latest"
	}
	if profile == "" {
		profile = "balanced"
	}
	if interval <= 0 {
		interval = 60
	}
	downloadBase := deriveDownloadBaseV3(serverURL, downloadURL)
	nameArg := ""
	if strings.TrimSpace(agentName) != "" {
		nameArg = " --name " + shellQuoteV3(agentName)
	}
	optional := fmt.Sprintf(" --profile %s --interval %d", shellQuoteV3(profile), interval)
	if strings.TrimSpace(services) != "" {
		optional += " --services " + shellQuoteV3(services)
	}
	if strings.EqualFold(style, "windows") {
		psNameArg := strings.ReplaceAll(nameArg, " --name ", " -Name ")
		return fmt.Sprintf("try { iwr %s/install-agent.ps1 -OutFile install-agent.ps1 -UseBasicParsing -ErrorAction Stop } catch { Write-Error $_.Exception.Message; exit 1 }; powershell -ExecutionPolicy Bypass -File .\\install-agent.ps1 -ServerUrl %s -DownloadUrl %s -EnrollmentToken %s%s -Profile %s -Interval %d", downloadBase, serverURL, downloadBase, token, psNameArg, profile, interval)
	}
	return fmt.Sprintf("curl -fsSL %s/install-agent.sh | sudo bash -s -- --server-url %s --download-url %s --enrollment-token %s%s%s", downloadBase, shellQuoteV3(serverURL), shellQuoteV3(downloadBase), shellQuoteV3(token), nameArg, optional)
}

func deriveDownloadBaseV3(serverURL, downloadURL string) string {
	if strings.TrimSpace(downloadURL) != "" {
		return strings.TrimRight(downloadURL, "/")
	}
	parsed := strings.TrimRight(serverURL, "/")
	if parsed == "" {
		return "/downloads"
	}
	return parsed + "/downloads"
}

func shellQuoteV3(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func randomTokenV3(size int) (string, error) {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func hashSecretV3(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

var _ = pgx.ErrNoRows
