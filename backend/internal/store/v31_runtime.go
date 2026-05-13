package store

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) InsertMetricsV31(ctx context.Context, agentID string, req models.MetricsRequest) error {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
		return err
	}
	if err := s.ensureNetworkInterfaceSchema(ctx); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var sampleID int64
	var sampleAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO metric_samples
			(agent_id, cpu_percent, memory_total_bytes, memory_used_bytes, memory_used_percent, swap_total_bytes, swap_used_bytes, swap_used_percent, gateway_latency_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING id, captured_at
	`, agentID, req.CPUPercent, int64(req.MemoryTotalBytes), int64(req.MemoryUsedBytes), req.MemoryUsedPercent, int64(req.SwapTotalBytes), int64(req.SwapUsedBytes), req.SwapUsedPercent, req.GatewayLatencyMs).Scan(&sampleID, &sampleAt)
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
	if err := trackAgentNetworksTx(ctx, tx, agentID, req.Networks); err != nil {
		return err
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
	for _, temp := range req.Temperatures {
		_, err = tx.Exec(ctx, `
			INSERT INTO temperature_samples
				(agent_id, captured_at, sensor_key, temperature_c)
			VALUES ($1, $2, $3, $4)
		`, agentID, sampleAt, temp.SensorKey, temp.TemperatureC)
		if err != nil {
			return err
		}
	}

	status, activeKeys, err := s.evaluateRuleAlerts(ctx, tx, agentID, sampleID, sampleAt, req)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE agents SET status = $2, last_seen_at = now(), updated_at = now() WHERE id = $1", agentID, status); err != nil {
		return err
	}
	if err := resolveRecoveredAlerts(ctx, tx, agentID, activeKeys); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) AgentDetailV31(ctx context.Context, id string, offlineAfterSeconds int) (map[string]any, error) {
	detail, err := s.AgentDetailV3(ctx, id, offlineAfterSeconds)
	if err != nil {
		return nil, err
	}
	alerts, err := s.AgentAlertsV31(ctx, id)
	if err == nil {
		detail["alerts"] = alerts
	}
	return detail, nil
}

func (s *Store) ListAlertsV31(ctx context.Context, activeOnly bool) ([]models.Alert, error) {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, alertSelectV31()+" WHERE ($1 = false OR al.active = true) ORDER BY al.active DESC, al.opened_at DESC", activeOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	alerts, err := scanAlertsV31(rows)
	if err != nil {
		return nil, err
	}
	return s.withAlertProcessSnapshots(ctx, alerts)
}

func (s *Store) AgentAlertsV31(ctx context.Context, agentID string) ([]models.Alert, error) {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, alertSelectV31()+" WHERE al.agent_id = $1 AND al.active = true ORDER BY al.severity = 'critical' DESC, al.opened_at DESC", agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	alerts, err := scanAlertsV31(rows)
	if err != nil {
		return nil, err
	}
	return s.withAlertProcessSnapshots(ctx, alerts)
}

func alertSelectV31() string {
	return `
		SELECT al.id::text, al.agent_id::text, a.name, al.type, al.severity, al.message,
		       al.resource_key, COALESCE(al.rule_id::text, ''), al.observed_value, al.threshold_value, al.unit,
		       al.duration_samples, al.notify_email, al.notify_telegram, al.notification_count, al.telegram_notification_count,
		       al.active, al.opened_at, al.resolved_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
	`
}

func scanAlertsV31(rows pgx.Rows) ([]models.Alert, error) {
	alerts := []models.Alert{}
	for rows.Next() {
		var alert models.Alert
		var ruleID string
		if err := rows.Scan(&alert.ID, &alert.AgentID, &alert.AgentName, &alert.Type, &alert.Severity, &alert.Message, &alert.ResourceKey, &ruleID, &alert.ObservedValue, &alert.ThresholdValue, &alert.Unit, &alert.DurationSamples, &alert.NotifyEmail, &alert.NotifyTelegram, &alert.NotificationCount, &alert.TelegramNotificationCount, &alert.Active, &alert.OpenedAt, &alert.ResolvedAt); err != nil {
			return nil, err
		}
		if ruleID != "" {
			alert.RuleID = &ruleID
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}

func (s *Store) NotifyDueAlertsV31(ctx context.Context) error {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
		return err
	}
	smtpCfg, smtpErr := s.GetSMTPSettings(ctx)
	telegramCfg, telegramErr := s.GetTelegramSettings(ctx)
	if smtpErr != nil && telegramErr != nil {
		return smtpErr
	}
	if smtpErr != nil {
		smtpCfg = models.SMTPSettings{}
	}
	if telegramErr != nil {
		telegramCfg = models.TelegramSettings{}
	}
	if strings.TrimSpace(smtpCfg.FromAddress) == "" {
		smtpCfg.FromAddress = strings.TrimSpace(smtpCfg.Username)
	}
	if smtpCfg.CooldownMinutes <= 0 {
		smtpCfg.CooldownMinutes = 30
	}
	if telegramCfg.CooldownMinutes <= 0 {
		telegramCfg.CooldownMinutes = 30
	}
	// Tx + SELECT ... FOR UPDATE SKIP LOCKED garantiza que dos goroutines
	// (runAlertDispatcher cada 30s y EvaluateOfflineAlerts cada 60s) nunca
	// procesen la misma alerta en paralelo: la segunda salta las filas que
	// la primera ya tiene tomadas y las verá ya marcadas como notificadas.
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT al.id::text, a.name, al.severity, al.message, al.resource_key,
		       al.observed_value, al.threshold_value, al.unit, al.duration_samples,
		       al.notify_email, al.notify_telegram, al.notification_count, al.telegram_notification_count,
		       al.cooldown_minutes, al.opened_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		WHERE al.active = true
		  AND (
		    (al.notify_email = true AND (al.last_notified_at IS NULL OR al.last_notified_at < now() - (COALESCE(NULLIF(al.cooldown_minutes, 0), $1)::int * interval '1 minute')))
		    OR
		    (al.notify_telegram = true AND (al.telegram_notified_at IS NULL OR al.telegram_notified_at < now() - (COALESCE(NULLIF(al.cooldown_minutes, 0), $2)::int * interval '1 minute')))
		  )
		ORDER BY al.severity = 'critical' DESC, al.opened_at DESC
		LIMIT 10
		FOR UPDATE OF al SKIP LOCKED
	`, smtpCfg.CooldownMinutes, telegramCfg.CooldownMinutes)
	if err != nil {
		return err
	}
	pending := []pendingAlertV32{}
	for rows.Next() {
		var alert pendingAlertV32
		if err := rows.Scan(&alert.ID, &alert.Agent, &alert.Severity, &alert.Message, &alert.ResourceKey, &alert.ObservedValue, &alert.ThresholdValue, &alert.Unit, &alert.DurationSamples, &alert.NotifyEmail, &alert.NotifyTelegram, &alert.NotificationCount, &alert.TelegramNotificationCount, &alert.CooldownMinutes, &alert.OpenedAt); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, alert)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, alert := range pending {
		processes, err := s.alertProcessSnapshot(ctx, alert.ID)
		if err != nil {
			return err
		}
		if alert.NotifyEmail && smtpCfg.Enabled && strings.TrimSpace(smtpCfg.Host) != "" && strings.TrimSpace(smtpCfg.ToAddresses) != "" && strings.TrimSpace(smtpCfg.FromAddress) != "" {
			if err := sendAlertHTMLMailV32(smtpCfg, alert, processes); err != nil {
				log.Printf("alert email send failed for %s: %v", alert.ID, err)
			} else if _, err := tx.Exec(ctx, "UPDATE alerts SET last_notified_at = now(), notification_count = notification_count + 1 WHERE id = $1", alert.ID); err != nil {
				return err
			}
		}
		if alert.NotifyTelegram && telegramCfg.Enabled && strings.TrimSpace(telegramCfg.BotToken) != "" && strings.TrimSpace(telegramCfg.ChatIDs) != "" {
			if err := sendTelegramV32(telegramCfg, telegramAlertTextV32(alert, processes)); err != nil {
				log.Printf("alert telegram send failed for %s: %v", alert.ID, err)
			} else if _, err := tx.Exec(ctx, "UPDATE alerts SET telegram_notified_at = now(), telegram_notification_count = telegram_notification_count + 1 WHERE id = $1", alert.ID); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) SafeAgentNameV31(ctx context.Context, id string) (string, error) {
	var name string
	err := s.pool.QueryRow(ctx, "SELECT name FROM agents WHERE id = $1", id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return name, err
}

func (s *Store) EnsureV31Schema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS temperature_samples (
			id BIGSERIAL PRIMARY KEY,
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			sensor_key TEXT NOT NULL,
			temperature_c DOUBLE PRECISION NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS temperature_samples_agent_idx ON temperature_samples(agent_id, captured_at DESC)`,
		`ALTER TABLE metric_samples ADD COLUMN IF NOT EXISTS gateway_latency_ms DOUBLE PRECISION`,
		`ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
		`CREATE INDEX IF NOT EXISTS agents_tags_gin ON agents USING gin(tags)`,
	}
	for _, stmt := range statements {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AlertStats(ctx context.Context) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT
			a.name AS agent_name,
			COUNT(*) FILTER (WHERE al.active) AS active_count,
			COUNT(*) FILTER (WHERE al.severity = 'critical') AS critical_total,
			COUNT(*) FILTER (WHERE al.severity = 'warning') AS warning_total,
			MAX(al.opened_at) AS last_alert_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		GROUP BY a.id, a.name
		HAVING COUNT(*) > 0
		ORDER BY active_count DESC, last_alert_at DESC
		LIMIT 20
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []map[string]any
	for rows.Next() {
		var agentName string
		var activeCount, criticalTotal, warningTotal int
		var lastAlertAt time.Time
		if err := rows.Scan(&agentName, &activeCount, &criticalTotal, &warningTotal, &lastAlertAt); err != nil {
			return nil, err
		}
		result = append(result, map[string]any{
			"agent_name":     agentName,
			"active_count":   activeCount,
			"critical_total": criticalTotal,
			"warning_total":  warningTotal,
			"last_alert_at":  lastAlertAt,
		})
	}
	if result == nil {
		result = []map[string]any{}
	}
	return result, nil
}

func (s *Store) ensureAlertRuntimeSchemas(ctx context.Context) error {
	if err := s.EnsureV3Schema(ctx); err != nil {
		return err
	}
	if err := s.EnsureV31Schema(ctx); err != nil {
		return err
	}
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureAlertContextSchema(ctx); err != nil {
		return err
	}
	return s.EnsureV32Schema(ctx)
}
