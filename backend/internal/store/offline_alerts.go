package store

import (
	"context"
	"fmt"
	"log"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) EvaluateOfflineAlerts(ctx context.Context, offlineAfterSeconds int) error {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureOfflineAlertDefaults(ctx); err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, name, last_seen_at
		FROM agents
	`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type offlineAgent struct {
		id, name   string
		lastSeenAt *time.Time
	}
	agents := []offlineAgent{}
	for rows.Next() {
		var agent offlineAgent
		if err := rows.Scan(&agent.id, &agent.name, &agent.lastSeenAt); err != nil {
			return err
		}
		agents = append(agents, agent)
	}
	if rows.Err() != nil {
		return rows.Err()
	}

	for _, agent := range agents {
		if err := s.evaluateAgentOfflineAlert(ctx, agent.id, agent.name, agent.lastSeenAt, offlineAfterSeconds); err != nil {
			return err
		}
	}
	if err := s.NotifyDueAlertsV31(ctx); err != nil {
		log.Printf("notify due alerts: %v", err)
	}
	return nil
}

func (s *Store) ensureOfflineAlertDefaults(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO alert_rules (metric, resource_key, severity, enabled, threshold, duration_samples, notify_email, notify_telegram, cooldown_minutes, description) VALUES
			('agent_offline_minutes', '', 'warning', true, 3, 1, false, false, 30, 'Equipo sin conexion warning'),
			('agent_offline_minutes', '', 'critical', true, 10, 1, true, false, 30, 'Equipo sin conexion critical')
		ON CONFLICT DO NOTHING
	`)
	return err
}

func (s *Store) evaluateAgentOfflineAlert(ctx context.Context, agentID, agentName string, lastSeenAt *time.Time, offlineAfterSeconds int) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	rules, err := s.effectiveAlertRules(ctx, tx, agentID)
	if err != nil {
		return err
	}
	minutes := 0.0
	if lastSeenAt != nil {
		minutes = time.Since(*lastSeenAt).Minutes()
	}
	value := alertValue{
		Metric: metricOffline,
		Value:  minutes,
		Unit:   " min",
		Label:  "Conexion perdida",
	}
	active := lastSeenAt == nil || time.Since(*lastSeenAt) > time.Duration(offlineAfterSeconds)*time.Second
	if !active {
		if err := resetRuleMatches(ctx, tx, agentID, rules, value); err != nil {
			return err
		}
		if err := resolveAlertType(ctx, tx, agentID, metricOffline); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}

	rule := matchRuleForValue(rules, value)
	if rule == nil {
		if err := resetRuleMatches(ctx, tx, agentID, rules, value); err != nil {
			return err
		}
		if err := resolveAlertType(ctx, tx, agentID, metricOffline); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err := resetOtherRuleMatches(ctx, tx, agentID, rules, *rule, value); err != nil {
		return err
	}
	count, err := bumpRuleMatch(ctx, tx, agentID, *rule, value.ResourceKey, value.Value)
	if err != nil {
		return err
	}
	if count >= rule.DurationSamples {
		message := fmt.Sprintf("%s %s supero umbral %s durante %d muestras", value.Label, humanizeMinutes(value.Value), humanizeMinutes(rule.Threshold), count)
		if agentName != "" {
			message = agentName + ": " + message
		}
		if err := upsertRuleAlert(ctx, tx, agentID, *rule, value, count, message, nil); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "UPDATE agents SET status = $2, updated_at = now() WHERE id = $1", agentID, severityStatus(rule.Severity)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func resolveAlertType(ctx context.Context, tx pgx.Tx, agentID, alertType string) error {
	_, err := tx.Exec(ctx, "UPDATE alerts SET active = false, resolved_at = COALESCE(resolved_at, now()) WHERE agent_id = $1 AND type = $2 AND active = true", agentID, alertType)
	return err
}

func humanizeMinutes(mins float64) string {
	if mins < 0 {
		mins = 0
	}
	if mins < 1 {
		secs := int(mins * 60)
		return fmt.Sprintf("%ds", secs)
	}
	if mins < 60 {
		return fmt.Sprintf("%.1f min", mins)
	}
	if mins < 1440 {
		h := int(mins) / 60
		m := int(mins) - h*60
		if m == 0 {
			return fmt.Sprintf("%dh", h)
		}
		return fmt.Sprintf("%dh %dmin", h, m)
	}
	d := int(mins) / 1440
	h := (int(mins) - d*1440) / 60
	if h == 0 {
		return fmt.Sprintf("%dd", d)
	}
	return fmt.Sprintf("%dd %dh", d, h)
}

func OfflineStatusZero(agent *models.Agent) {
	if agent == nil || agent.Status != models.StatusOffline {
		return
	}
	zero := 0.0
	agent.CPUPercent = &zero
	agent.MemoryPercent = &zero
}
