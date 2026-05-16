package store

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"
)

const (
	metricCPU         = "cpu"
	metricRAM         = "ram"
	metricDisk        = "disk_used_percent"
	metricNetworkRecv = "network_recv_mbps"
	metricNetworkSent = "network_sent_mbps"
	metricOffline     = "agent_offline_minutes"
)

// advisoryLockAlertRulesSchema is an arbitrary fixed int64 used as a Postgres
// advisory lock key. It serializes concurrent first-startup migrations so the
// CREATE TABLE / CREATE TYPE statements below cannot race on pg_type and trip
// SQLSTATE 23505 on pg_type_typname_nsp_index.
const advisoryLockAlertRulesSchema int64 = 7591

func (s *Store) ensureAlertRulesSchema(ctx context.Context) error {
	s.onceAlertRules.Do(func() { s.onceAlertRulesErr = s.runAlertRulesSchema(ctx) })
	return s.onceAlertRulesErr
}

func (s *Store) runAlertRulesSchema(ctx context.Context) error {
	statements := []string{
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS rule_id UUID",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS observed_value DOUBLE PRECISION",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS threshold_value DOUBLE PRECISION",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS unit TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS duration_samples INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT false",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN NOT NULL DEFAULT false",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS cooldown_minutes INTEGER NOT NULL DEFAULT 30",
		`CREATE TABLE IF NOT EXISTS alert_rules (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
			metric TEXT NOT NULL,
			resource_key TEXT NOT NULL DEFAULT '',
			severity TEXT NOT NULL,
			enabled BOOLEAN NOT NULL DEFAULT true,
			threshold DOUBLE PRECISION NOT NULL DEFAULT 0,
			duration_samples INTEGER NOT NULL DEFAULT 2,
			notify_email BOOLEAN NOT NULL DEFAULT false,
			notify_telegram BOOLEAN NOT NULL DEFAULT false,
			cooldown_minutes INTEGER NOT NULL DEFAULT 30,
			description TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		"ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN NOT NULL DEFAULT false",
		// Soporte para alertas sobre DB targets (manager-v1.10.x — F2)
		"ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS db_target_id UUID REFERENCES db_targets(id) ON DELETE CASCADE",
		"DROP INDEX IF EXISTS alert_rules_scope_metric_idx",
		`CREATE UNIQUE INDEX IF NOT EXISTS alert_rules_scope_metric_idx
			ON alert_rules (
				(COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)),
				(COALESCE(db_target_id, '00000000-0000-0000-0000-000000000000'::uuid)),
				metric, resource_key, severity
			)`,
		`CREATE TABLE IF NOT EXISTS alert_rule_matches (
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
			resource_key TEXT NOT NULL DEFAULT '',
			consecutive_count INTEGER NOT NULL DEFAULT 0,
			last_value DOUBLE PRECISION NOT NULL DEFAULT 0,
			last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (agent_id, rule_id, resource_key)
		)`,
		`INSERT INTO alert_rules (metric, resource_key, severity, enabled, threshold, duration_samples, notify_email, notify_telegram, cooldown_minutes, description) VALUES
			('cpu', '', 'warning', true, 85, 2, false, false, 30, 'CPU sobre umbral warning'),
			('cpu', '', 'critical', true, 95, 2, true, false, 30, 'CPU sobre umbral critical'),
			('ram', '', 'warning', true, 85, 2, false, false, 30, 'RAM sobre umbral warning'),
			('ram', '', 'critical', true, 95, 2, true, false, 30, 'RAM sobre umbral critical'),
			('disk_used_percent', '', 'warning', true, 80, 2, false, false, 30, 'Disco sobre umbral warning'),
			('disk_used_percent', '', 'critical', true, 90, 2, true, false, 30, 'Disco sobre umbral critical'),
			('network_recv_mbps', '', 'warning', false, 100, 2, false, false, 30, 'Red recibida sobre umbral warning'),
			('network_recv_mbps', '', 'critical', false, 500, 2, true, false, 30, 'Red recibida sobre umbral critical'),
			('network_sent_mbps', '', 'warning', false, 100, 2, false, false, 30, 'Red enviada sobre umbral warning'),
			('network_sent_mbps', '', 'critical', false, 500, 2, true, false, 30, 'Red enviada sobre umbral critical'),
			('agent_offline_minutes', '', 'warning', true, 3, 1, false, false, 30, 'Equipo sin conexion warning'),
			('agent_offline_minutes', '', 'critical', true, 10, 1, true, false, 30, 'Equipo sin conexion critical')
		 ON CONFLICT DO NOTHING`,
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", advisoryLockAlertRulesSchema); err != nil {
		return err
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ListDefaultAlertRules(ctx context.Context) ([]models.AlertRule, error) {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return nil, err
	}
	return s.listAlertRules(ctx, "")
}

func (s *Store) SaveDefaultAlertRules(ctx context.Context, rules []models.AlertRule) ([]models.AlertRule, error) {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return nil, err
	}
	if err := s.replaceAlertRules(ctx, "", rules); err != nil {
		return nil, err
	}
	return s.ListDefaultAlertRules(ctx)
}

func (s *Store) ListAgentAlertRules(ctx context.Context, agentID string) ([]models.AlertRule, error) {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return nil, err
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	defaults, err := s.listAlertRules(ctx, "")
	if err != nil {
		return nil, err
	}
	overrides, err := s.listAlertRules(ctx, agentID)
	if err != nil {
		return nil, err
	}
	merged := map[string]models.AlertRule{}
	for _, rule := range defaults {
		rule.Source = "global"
		merged[ruleKey(rule)] = rule
	}
	for _, rule := range overrides {
		rule.Source = "agent"
		merged[ruleKey(rule)] = rule
	}
	current, _ := s.currentRuleValues(ctx, agentID)
	for key, value := range current {
		if rule, ok := merged[key]; ok {
			v := value
			rule.CurrentValue = &v
			merged[key] = rule
		}
	}
	out := make([]models.AlertRule, 0, len(merged))
	for _, rule := range merged {
		out = append(out, rule)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Metric != out[j].Metric {
			return alertMetricOrder(out[i].Metric) < alertMetricOrder(out[j].Metric)
		}
		if out[i].ResourceKey != out[j].ResourceKey {
			return out[i].ResourceKey < out[j].ResourceKey
		}
		return alertSeverityOrder(out[i].Severity) < alertSeverityOrder(out[j].Severity)
	})
	return out, nil
}

func (s *Store) SaveAgentAlertRules(ctx context.Context, agentID string, rules []models.AlertRule) ([]models.AlertRule, error) {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return nil, err
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	if err := s.replaceAlertRules(ctx, agentID, rules); err != nil {
		return nil, err
	}
	return s.ListAgentAlertRules(ctx, agentID)
}

func (s *Store) ResetAgentAlertRules(ctx context.Context, agentID string) error {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return err
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "DELETE FROM alert_rule_matches WHERE agent_id = $1", agentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM alert_rules WHERE agent_id = $1", agentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "UPDATE agents SET custom_rules_enabled = false WHERE id = $1", agentID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) GetAgentCustomRulesEnabled(ctx context.Context, agentID string) (bool, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return false, err
	}
	var enabled bool
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(custom_rules_enabled, false) FROM agents WHERE id = $1`, agentID).Scan(&enabled)
	return enabled, err
}

func (s *Store) SetAgentCustomRulesEnabled(ctx context.Context, agentID string, enabled bool) error {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE agents SET custom_rules_enabled = $2 WHERE id = $1`, agentID, enabled)
	return err
}

func (s *Store) GetAgentIntervalSeconds(ctx context.Context, agentID string) (int, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return 0, err
	}
	var seconds int
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(interval_seconds, 60) FROM agents WHERE id = $1`, agentID).Scan(&seconds)
	if err != nil {
		return 0, err
	}
	if seconds <= 0 {
		seconds = 60
	}
	return seconds, nil
}

func (s *Store) SetAgentIntervalSeconds(ctx context.Context, agentID string, seconds int) error {
	if seconds != 15 && seconds != 30 && seconds != 60 {
		return fmt.Errorf("interval must be 15, 30 or 60 seconds")
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE agents SET interval_seconds = $2 WHERE id = $1`, agentID, seconds)
	return err
}

func (s *Store) GetAgentProfile(ctx context.Context, agentID string) (string, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return "", err
	}
	var profile string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(profile, 'balanced') FROM agents WHERE id = $1`, agentID).Scan(&profile)
	return profile, err
}

func (s *Store) SetAgentProfile(ctx context.Context, agentID, profile string) error {
	if profile != "minimal" && profile != "balanced" && profile != "full" {
		return fmt.Errorf("profile must be minimal, balanced or full")
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `UPDATE agents SET profile = $2 WHERE id = $1`, agentID, profile)
	return err
}

func (s *Store) GetAgentServiceChecks(ctx context.Context, agentID string) ([]string, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	var checks []string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(service_checks, '{}') FROM agents WHERE id = $1`, agentID).Scan(&checks)
	if err != nil {
		return nil, err
	}
	if checks == nil {
		checks = []string{}
	}
	return checks, nil
}

func (s *Store) SetAgentServiceChecks(ctx context.Context, agentID string, names []string) ([]string, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	cleaned := make([]string, 0, len(names))
	seen := map[string]bool{}
	for _, name := range names {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		cleaned = append(cleaned, trimmed)
	}
	if _, err := s.pool.Exec(ctx, `UPDATE agents SET service_checks = $2 WHERE id = $1`, agentID, cleaned); err != nil {
		return nil, err
	}
	return cleaned, nil
}

func (s *Store) listAlertRules(ctx context.Context, agentID string) ([]models.AlertRule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, COALESCE(agent_id::text, ''), metric, resource_key, severity, enabled, threshold,
		       duration_samples, notify_email, notify_telegram, cooldown_minutes, description
		FROM alert_rules
		WHERE (($1 = '' AND agent_id IS NULL) OR ($1 <> '' AND agent_id = $1::uuid))
		ORDER BY metric, resource_key, severity
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []models.AlertRule{}
	for rows.Next() {
		var rule models.AlertRule
		var scannedAgentID string
		if err := rows.Scan(&rule.ID, &scannedAgentID, &rule.Metric, &rule.ResourceKey, &rule.Severity, &rule.Enabled, &rule.Threshold, &rule.DurationSamples, &rule.NotifyEmail, &rule.NotifyTelegram, &rule.CooldownMinutes, &rule.Description); err != nil {
			return nil, err
		}
		if scannedAgentID != "" {
			rule.AgentID = &scannedAgentID
		}
		rules = append(rules, normalizeAlertRule(rule))
	}
	return rules, rows.Err()
}

func (s *Store) replaceAlertRules(ctx context.Context, agentID string, rules []models.AlertRule) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if agentID == "" {
		if _, err := tx.Exec(ctx, "DELETE FROM alert_rules WHERE agent_id IS NULL"); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, "DELETE FROM alert_rules WHERE agent_id = $1", agentID); err != nil {
		return err
	}
	for _, rule := range rules {
		rule = normalizeAlertRule(rule)
		if !validAlertMetric(rule.Metric) || !validAlertSeverity(rule.Severity) {
			continue
		}
		if agentID == "" {
			_, err = tx.Exec(ctx, `
				INSERT INTO alert_rules (agent_id, metric, resource_key, severity, enabled, threshold, duration_samples, notify_email, notify_telegram, cooldown_minutes, description)
				VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			`, rule.Metric, rule.ResourceKey, rule.Severity, rule.Enabled, rule.Threshold, rule.DurationSamples, rule.NotifyEmail, rule.NotifyTelegram, rule.CooldownMinutes, rule.Description)
		} else {
			_, err = tx.Exec(ctx, `
				INSERT INTO alert_rules (agent_id, metric, resource_key, severity, enabled, threshold, duration_samples, notify_email, notify_telegram, cooldown_minutes, description)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			`, agentID, rule.Metric, rule.ResourceKey, rule.Severity, rule.Enabled, rule.Threshold, rule.DurationSamples, rule.NotifyEmail, rule.NotifyTelegram, rule.CooldownMinutes, rule.Description)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ensureAgentExists(ctx context.Context, agentID string) error {
	var exists bool
	if err := s.pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM agents WHERE id = $1)", agentID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func (s *Store) currentRuleValues(ctx context.Context, agentID string) (map[string]float64, error) {
	values := map[string]float64{}
	var cpu, ram float64
	err := s.pool.QueryRow(ctx, `
		SELECT cpu_percent, memory_used_percent
		FROM metric_samples
		WHERE agent_id = $1
		ORDER BY captured_at DESC
		LIMIT 1
	`, agentID).Scan(&cpu, &ram)
	if err == nil {
		values[metricCPU+"::warning"] = cpu
		values[metricCPU+"::critical"] = cpu
		values[metricRAM+"::warning"] = ram
		values[metricRAM+"::critical"] = ram
	}
	disks, err := s.latestDisks(ctx, agentID)
	if err != nil {
		return values, err
	}
	for _, disk := range disks {
		key := diskResourceKey(disk)
		values[metricDisk+":"+key+":warning"] = disk.UsedPercent
		values[metricDisk+":"+key+":critical"] = disk.UsedPercent
	}
	var lastSeenAt *time.Time
	if err := s.pool.QueryRow(ctx, "SELECT last_seen_at FROM agents WHERE id = $1", agentID).Scan(&lastSeenAt); err == nil {
		minutes := 0.0
		if lastSeenAt != nil {
			minutes = time.Since(*lastSeenAt).Minutes()
		}
		values[metricOffline+"::warning"] = minutes
		values[metricOffline+"::critical"] = minutes
	}
	return values, nil
}

func normalizeAlertRule(rule models.AlertRule) models.AlertRule {
	rule.Metric = strings.TrimSpace(rule.Metric)
	rule.ResourceKey = strings.TrimSpace(rule.ResourceKey)
	rule.Severity = strings.TrimSpace(strings.ToLower(rule.Severity))
	if rule.DurationSamples <= 0 {
		rule.DurationSamples = 2
	}
	if rule.CooldownMinutes <= 0 {
		rule.CooldownMinutes = 30
	}
	if math.IsNaN(rule.Threshold) || math.IsInf(rule.Threshold, 0) {
		rule.Threshold = 0
	}
	return rule
}

func diskResourceKey(disk models.DiskMetric) string {
	if strings.TrimSpace(disk.Mountpoint) != "" {
		return strings.TrimSpace(disk.Mountpoint)
	}
	return strings.TrimSpace(disk.Name)
}

func ruleKey(rule models.AlertRule) string {
	return rule.Metric + ":" + rule.ResourceKey + ":" + rule.Severity
}

func validAlertMetric(metric string) bool {
	switch metric {
	case metricCPU, metricRAM, metricDisk, metricNetworkRecv, metricNetworkSent, metricOffline:
		return true
	default:
		return false
	}
}

func validAlertSeverity(severity string) bool {
	return severity == "warning" || severity == "critical"
}

func alertMetricOrder(metric string) int {
	switch metric {
	case metricCPU:
		return 1
	case metricRAM:
		return 2
	case metricNetworkRecv:
		return 3
	case metricNetworkSent:
		return 4
	case metricDisk:
		return 5
	case metricOffline:
		return 6
	default:
		return 99
	}
}

func alertSeverityOrder(severity string) int {
	if severity == "critical" {
		return 1
	}
	return 2
}
