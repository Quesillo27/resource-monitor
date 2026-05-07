package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) InsertMetricsV31(ctx context.Context, agentID string, req models.MetricsRequest) error {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
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
			(agent_id, cpu_percent, memory_total_bytes, memory_used_bytes, memory_used_percent, swap_total_bytes, swap_used_bytes, swap_used_percent)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, captured_at
	`, agentID, req.CPUPercent, int64(req.MemoryTotalBytes), int64(req.MemoryUsedBytes), req.MemoryUsedPercent, int64(req.SwapTotalBytes), int64(req.SwapUsedBytes), req.SwapUsedPercent).Scan(&sampleID, &sampleAt)
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
	return scanAlertsV31(rows)
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
	return scanAlertsV31(rows)
}

func alertSelectV31() string {
	return `
		SELECT al.id::text, al.agent_id::text, a.name, al.type, al.severity, al.message,
		       al.resource_key, COALESCE(al.rule_id::text, ''), al.observed_value, al.threshold_value, al.unit,
		       al.duration_samples, al.notify_email, al.notification_count,
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
		if err := rows.Scan(&alert.ID, &alert.AgentID, &alert.AgentName, &alert.Type, &alert.Severity, &alert.Message, &alert.ResourceKey, &ruleID, &alert.ObservedValue, &alert.ThresholdValue, &alert.Unit, &alert.DurationSamples, &alert.NotifyEmail, &alert.NotificationCount, &alert.Active, &alert.OpenedAt, &alert.ResolvedAt); err != nil {
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
	cfg, err := s.GetSMTPSettings(ctx)
	if err != nil {
		return err
	}
	if !cfg.Enabled || strings.TrimSpace(cfg.Host) == "" || strings.TrimSpace(cfg.ToAddresses) == "" {
		return nil
	}
	if strings.TrimSpace(cfg.FromAddress) == "" {
		cfg.FromAddress = strings.TrimSpace(cfg.Username)
	}
	if strings.TrimSpace(cfg.FromAddress) == "" {
		return nil
	}
	if cfg.CooldownMinutes <= 0 {
		cfg.CooldownMinutes = 30
	}
	rows, err := s.pool.Query(ctx, `
		SELECT al.id::text, a.name, al.severity, al.message, al.opened_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		WHERE al.active = true
		  AND al.notify_email = true
		  AND (al.last_notified_at IS NULL OR al.last_notified_at < now() - (COALESCE(NULLIF(al.cooldown_minutes, 0), $1)::int * interval '1 minute'))
		ORDER BY al.severity = 'critical' DESC, al.opened_at DESC
		LIMIT 10
	`, cfg.CooldownMinutes)
	if err != nil {
		return err
	}
	defer rows.Close()
	type pendingAlert struct {
		id       string
		agent    string
		severity string
		message  string
		openedAt time.Time
	}
	pending := []pendingAlert{}
	for rows.Next() {
		var alert pendingAlert
		if err := rows.Scan(&alert.id, &alert.agent, &alert.severity, &alert.message, &alert.openedAt); err != nil {
			return err
		}
		pending = append(pending, alert)
	}
	if rows.Err() != nil {
		return rows.Err()
	}
	for _, alert := range pending {
		body := fmt.Sprintf("Equipo: %s\nSeveridad: %s\nAlerta: %s\nApertura: %s\n", alert.agent, alert.severity, alert.message, alert.openedAt.Format(time.RFC3339))
		if err := sendMailV3(cfg, "Resource Monitor alerta "+strings.ToUpper(alert.severity), body); err != nil {
			return err
		}
		if _, err := s.pool.Exec(ctx, "UPDATE alerts SET last_notified_at = now(), notification_count = notification_count + 1 WHERE id = $1", alert.id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) SafeAgentNameV31(ctx context.Context, id string) (string, error) {
	var name string
	err := s.pool.QueryRow(ctx, "SELECT name FROM agents WHERE id = $1", id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return name, err
}

func (s *Store) ensureAlertRuntimeSchemas(ctx context.Context) error {
	if err := s.EnsureV3Schema(ctx); err != nil {
		return err
	}
	return s.ensureAlertRulesSchema(ctx)
}
