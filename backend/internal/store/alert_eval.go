package store

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) evaluateRuleAlerts(ctx context.Context, tx pgx.Tx, agentID string, sampleID int64, sampleAt time.Time, req models.MetricsRequest) (string, map[string]bool, error) {
	values, err := s.sampleAlertValues(ctx, tx, agentID, sampleID, sampleAt, req)
	if err != nil {
		return "", nil, err
	}
	rules, err := s.effectiveAlertRules(ctx, tx, agentID)
	if err != nil {
		return "", nil, err
	}
	activeKeys := map[string]bool{}
	status := models.StatusOnline
	for _, value := range values {
		rule := matchRuleForValue(rules, value)
		if rule == nil {
			if err := resetRuleMatches(ctx, tx, agentID, rules, value); err != nil {
				return "", nil, err
			}
			continue
		}
		if err := resetOtherRuleMatches(ctx, tx, agentID, rules, *rule, value); err != nil {
			return "", nil, err
		}
		count, err := bumpRuleMatch(ctx, tx, agentID, *rule, value.ResourceKey, value.Value)
		if err != nil {
			return "", nil, err
		}
		if count < rule.DurationSamples {
			continue
		}
		activeKeys[value.Metric+":"+value.ResourceKey] = true
		status = maxStatus(status, severityStatus(rule.Severity))
		message := fmt.Sprintf("%s %.2f%s supero umbral %.2f%s durante %d muestras", value.Label, value.Value, value.Unit, rule.Threshold, value.Unit, count)
		if err := upsertRuleAlert(ctx, tx, agentID, *rule, value, count, message); err != nil {
			return "", nil, err
		}
	}
	return status, activeKeys, nil
}

func (s *Store) effectiveAlertRules(ctx context.Context, tx pgx.Tx, agentID string) ([]models.AlertRule, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text, COALESCE(agent_id::text, ''), metric, resource_key, severity, enabled, threshold,
		       duration_samples, notify_email, cooldown_minutes, description
		FROM alert_rules
		WHERE agent_id IS NULL OR agent_id = $1
		ORDER BY agent_id NULLS FIRST, metric, resource_key, severity
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	rules := []models.AlertRule{}
	for rows.Next() {
		var rule models.AlertRule
		var scannedAgentID string
		if err := rows.Scan(&rule.ID, &scannedAgentID, &rule.Metric, &rule.ResourceKey, &rule.Severity, &rule.Enabled, &rule.Threshold, &rule.DurationSamples, &rule.NotifyEmail, &rule.CooldownMinutes, &rule.Description); err != nil {
			return nil, err
		}
		if scannedAgentID != "" {
			rule.AgentID = &scannedAgentID
		}
		rules = append(rules, normalizeAlertRule(rule))
	}
	return rules, rows.Err()
}

func (s *Store) sampleAlertValues(ctx context.Context, tx pgx.Tx, agentID string, sampleID int64, sampleAt time.Time, req models.MetricsRequest) ([]alertValue, error) {
	values := []alertValue{
		{Metric: metricCPU, Value: req.CPUPercent, Unit: "%", Label: "CPU"},
		{Metric: metricRAM, Value: req.MemoryUsedPercent, Unit: "%", Label: "RAM"},
	}
	netRates, err := networkMbpsFromPrevious(ctx, tx, agentID, sampleID, sampleAt, req.Networks)
	if err != nil {
		return nil, err
	}
	if len(req.Networks) > 0 {
		values = append(values,
			alertValue{Metric: metricNetworkRecv, Value: netRates[metricNetworkRecv], Unit: " Mbps", Label: "Red recibida"},
			alertValue{Metric: metricNetworkSent, Value: netRates[metricNetworkSent], Unit: " Mbps", Label: "Red enviada"},
		)
	}
	for _, disk := range req.Disks {
		key := diskResourceKey(disk)
		values = append(values, alertValue{Metric: metricDisk, ResourceKey: key, Value: disk.UsedPercent, Unit: "%", Label: "Disco " + key})
	}
	return values, nil
}

func networkMbpsFromPrevious(ctx context.Context, tx pgx.Tx, agentID string, sampleID int64, sampleAt time.Time, networks []models.NetMetric) (map[string]float64, error) {
	rates := map[string]float64{metricNetworkRecv: 0, metricNetworkSent: 0}
	if len(networks) == 0 {
		return rates, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT ON (name) name, bytes_sent, bytes_recv, captured_at
		FROM network_samples
		WHERE agent_id = $1 AND metric_sample_id <> $2
		ORDER BY name, captured_at DESC
	`, agentID, sampleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type previousNet struct {
		sent int64
		recv int64
		at   time.Time
	}
	previous := map[string]previousNet{}
	for rows.Next() {
		var name string
		var sent, recv int64
		var at time.Time
		if err := rows.Scan(&name, &sent, &recv, &at); err != nil {
			return nil, err
		}
		previous[name] = previousNet{sent: sent, recv: recv, at: at}
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}
	for _, network := range networks {
		prev, ok := previous[network.Name]
		if !ok {
			continue
		}
		seconds := sampleAt.Sub(prev.at).Seconds()
		if seconds <= 0 {
			continue
		}
		sent := float64(int64(network.BytesSent) - prev.sent)
		recv := float64(int64(network.BytesRecv) - prev.recv)
		if sent < 0 || recv < 0 {
			continue
		}
		rates[metricNetworkSent] += sent * 8 / seconds / 1_000_000
		rates[metricNetworkRecv] += recv * 8 / seconds / 1_000_000
	}
	return rates, nil
}

func matchRuleForValue(rules []models.AlertRule, value alertValue) *models.AlertRule {
	for _, severity := range []string{"critical", "warning"} {
		candidates := rulesForValue(rules, value, severity)
		sort.Slice(candidates, func(i, j int) bool { return ruleSpecificity(candidates[i]) > ruleSpecificity(candidates[j]) })
		for i := range candidates {
			rule := candidates[i]
			if !rule.Enabled || value.Value < rule.Threshold {
				continue
			}
			return &rule
		}
	}
	return nil
}

func rulesForValue(rules []models.AlertRule, value alertValue, severity string) []models.AlertRule {
	out := []models.AlertRule{}
	for _, rule := range rules {
		if rule.Metric != value.Metric || rule.Severity != severity {
			continue
		}
		if rule.ResourceKey != "" && rule.ResourceKey != value.ResourceKey {
			continue
		}
		out = append(out, rule)
	}
	return out
}

func resetRuleMatches(ctx context.Context, tx pgx.Tx, agentID string, rules []models.AlertRule, value alertValue) error {
	for _, rule := range rules {
		if rule.Metric != value.Metric {
			continue
		}
		if rule.ResourceKey != "" && rule.ResourceKey != value.ResourceKey {
			continue
		}
		if _, err := tx.Exec(ctx, "DELETE FROM alert_rule_matches WHERE agent_id = $1 AND rule_id = $2 AND resource_key = $3", agentID, rule.ID, value.ResourceKey); err != nil {
			return err
		}
	}
	return nil
}

func resetOtherRuleMatches(ctx context.Context, tx pgx.Tx, agentID string, rules []models.AlertRule, selected models.AlertRule, value alertValue) error {
	for _, rule := range rules {
		if rule.ID == selected.ID || rule.Metric != value.Metric {
			continue
		}
		if rule.ResourceKey != "" && rule.ResourceKey != value.ResourceKey {
			continue
		}
		if _, err := tx.Exec(ctx, "DELETE FROM alert_rule_matches WHERE agent_id = $1 AND rule_id = $2 AND resource_key = $3", agentID, rule.ID, value.ResourceKey); err != nil {
			return err
		}
	}
	return nil
}

func bumpRuleMatch(ctx context.Context, tx pgx.Tx, agentID string, rule models.AlertRule, resourceKey string, value float64) (int, error) {
	if rule.DurationSamples <= 0 {
		rule.DurationSamples = 2
	}
	var count int
	err := tx.QueryRow(ctx, `
		INSERT INTO alert_rule_matches (agent_id, rule_id, resource_key, consecutive_count, last_value, last_seen_at)
		VALUES ($1, $2, $3, 1, $4, now())
		ON CONFLICT (agent_id, rule_id, resource_key)
		DO UPDATE SET consecutive_count = alert_rule_matches.consecutive_count + 1,
		              last_value = EXCLUDED.last_value,
		              last_seen_at = now()
		RETURNING consecutive_count
	`, agentID, rule.ID, resourceKey, value).Scan(&count)
	return count, err
}

func upsertRuleAlert(ctx context.Context, tx pgx.Tx, agentID string, rule models.AlertRule, value alertValue, count int, message string) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO alerts
			(agent_id, type, resource_key, severity, message, rule_id, observed_value, threshold_value, unit, duration_samples, notify_email, cooldown_minutes)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (agent_id, type, resource_key) WHERE active = true
		DO UPDATE SET severity = EXCLUDED.severity,
		              message = EXCLUDED.message,
		              rule_id = EXCLUDED.rule_id,
		              observed_value = EXCLUDED.observed_value,
		              threshold_value = EXCLUDED.threshold_value,
		              unit = EXCLUDED.unit,
		              duration_samples = EXCLUDED.duration_samples,
		              notify_email = EXCLUDED.notify_email,
		              cooldown_minutes = EXCLUDED.cooldown_minutes,
		              last_seen_at = now()
	`, agentID, value.Metric, value.ResourceKey, rule.Severity, message, rule.ID, value.Value, rule.Threshold, strings.TrimSpace(value.Unit), count, rule.NotifyEmail, rule.CooldownMinutes)
	return err
}

func ruleSpecificity(rule models.AlertRule) int {
	score := 0
	if rule.AgentID != nil && *rule.AgentID != "" {
		score += 10
	}
	if rule.ResourceKey != "" {
		score += 5
	}
	return score
}

func severityStatus(severity string) string {
	if severity == "critical" {
		return models.StatusCritical
	}
	return models.StatusWarning
}
