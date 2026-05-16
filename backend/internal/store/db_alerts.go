package store

import (
	"context"
	"fmt"
	"log"
	"strings"

	"resource-monitor/backend/internal/models"
)

// Métricas que pueden tener reglas con scope de DB target.
const (
	dbMetricPoolPct           = "db_pool_pct"           // % de connections_total / max_connections
	dbMetricCacheHitPct       = "db_cache_hit_pct"      // % de cache hit (alerta si POR DEBAJO de threshold)
	dbMetricSlowQueries       = "db_slow_queries"       // queries activas >5s
	dbMetricDeadlocksPerHour  = "db_deadlocks_per_hour" // tasa derivada entre samples
	dbMetricIdleInTxMin       = "db_idle_in_tx_min"     // duracion en min de la tx idle mas vieja (PG live)
	dbMetricRedisMemPct       = "db_redis_mem_pct"      // % memoria usada / maxmemory (Redis)
	dbMetricSampleErr         = "db_sample_error"       // 1 si el ultimo sample fallo (sin valor numerico)
)

// dbAlertMetric describe metadata de cada metrica DB para construir descripciones.
type dbAlertMetric struct {
	Label     string
	Unit      string
	Inverted  bool // true = alerta si POR DEBAJO del threshold (cache hit)
}

var dbAlertMetricMeta = map[string]dbAlertMetric{
	dbMetricPoolPct:          {Label: "Pool de conexiones", Unit: "%"},
	dbMetricCacheHitPct:      {Label: "Cache hit", Unit: "%", Inverted: true},
	dbMetricSlowQueries:      {Label: "Queries lentas activas", Unit: ""},
	dbMetricDeadlocksPerHour: {Label: "Deadlocks por hora", Unit: "/h"},
	dbMetricIdleInTxMin:      {Label: "Idle in transaction", Unit: " min"},
	dbMetricRedisMemPct:      {Label: "Memoria Redis", Unit: "%"},
	dbMetricSampleErr:        {Label: "Sample con error", Unit: ""},
}

// EvaluateDBTargetAlerts corre tras cada poll exitoso de un DB target. Calcula
// los valores observados de las metricas DB y delega a evaluateDBRule.
func (s *Store) EvaluateDBTargetAlerts(ctx context.Context, target models.DatabaseTarget, sample models.DatabaseSample, prevSample *models.DatabaseSample) {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		log.Printf("db alerts schema: %v", err)
		return
	}

	// Build map metric -> observed value
	values := map[string]*float64{}

	if !sample.OK {
		v := 1.0
		values[dbMetricSampleErr] = &v
	}

	if sample.ConnectionsTotal != nil && sample.MaxConnections != nil && *sample.MaxConnections > 0 {
		v := float64(*sample.ConnectionsTotal) / float64(*sample.MaxConnections) * 100
		values[dbMetricPoolPct] = &v
	}

	if sample.CacheHitRatio != nil {
		v := *sample.CacheHitRatio * 100
		values[dbMetricCacheHitPct] = &v
	}

	if sample.SlowQueries != nil {
		v := float64(*sample.SlowQueries)
		values[dbMetricSlowQueries] = &v
	}

	// Deadlocks/hora derivado entre samples consecutivos
	if prevSample != nil && sample.Deadlocks != nil && prevSample.Deadlocks != nil {
		dt := sample.CapturedAt.Sub(prevSample.CapturedAt).Hours()
		if dt > 0 {
			delta := float64(*sample.Deadlocks - *prevSample.Deadlocks)
			if delta >= 0 {
				v := delta / dt
				values[dbMetricDeadlocksPerHour] = &v
			}
		}
	}

	// Redis: memoria usada / maxmemory
	if target.Type == "redis" && sample.MemoryUsedBytes != nil && sample.MemoryMaxBytes != nil && *sample.MemoryMaxBytes > 0 {
		v := float64(*sample.MemoryUsedBytes) / float64(*sample.MemoryMaxBytes) * 100
		values[dbMetricRedisMemPct] = &v
	}

	// Para idle_in_tx (PG live): consultar al vuelo solo si el target es PG y hay alguna regla activa
	if target.Type == "postgres" && s.hasIdleInTxRule(ctx, target.ID) {
		if maxIdle := s.computeMaxIdleInTxMinutes(ctx, target.ID); maxIdle > 0 {
			v := maxIdle
			values[dbMetricIdleInTxMin] = &v
		}
	}

	rules, err := s.listDBTargetRules(ctx, target.ID)
	if err != nil {
		log.Printf("db alerts list rules (%s): %v", target.Name, err)
		return
	}

	for _, rule := range rules {
		val, ok := values[rule.Metric]
		if !ok || val == nil {
			continue
		}
		s.evaluateDBRule(ctx, target, rule, *val)
	}
}

// listDBTargetRules: globales (db_target_id IS NULL) + especificas del target.
func (s *Store) listDBTargetRules(ctx context.Context, targetID string) ([]models.AlertRule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, COALESCE(db_target_id::text, ''), metric, severity, enabled, threshold,
		       duration_samples, notify_email, notify_telegram, cooldown_minutes, description
		FROM alert_rules
		WHERE agent_id IS NULL
		  AND (db_target_id IS NULL OR db_target_id = $1)
		  AND metric LIKE 'db\_%' ESCAPE '\'
		ORDER BY db_target_id NULLS LAST, severity DESC
	`, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.AlertRule
	for rows.Next() {
		var r models.AlertRule
		var tid string
		if err := rows.Scan(&r.ID, &tid, &r.Metric, &r.Severity, &r.Enabled, &r.Threshold,
			&r.DurationSamples, &r.NotifyEmail, &r.NotifyTelegram, &r.CooldownMinutes, &r.Description); err != nil {
			return nil, err
		}
		if tid != "" {
			r.DBTargetID = &tid
		}
		if r.Enabled {
			out = append(out, r)
		}
	}
	return out, rows.Err()
}

func (s *Store) evaluateDBRule(ctx context.Context, target models.DatabaseTarget, rule models.AlertRule, value float64) {
	meta := dbAlertMetricMeta[rule.Metric]
	tripped := value >= rule.Threshold
	if meta.Inverted {
		tripped = value <= rule.Threshold
	}

	if !tripped {
		// Limpia match
		_, _ = s.pool.Exec(ctx, `
			DELETE FROM alert_rule_matches
			WHERE rule_id = $1 AND resource_key = $2
		`, rule.ID, target.ID)
		// Resuelve alerta activa
		_, _ = s.pool.Exec(ctx, `
			UPDATE alerts SET active = false, resolved_at = now()
			WHERE rule_id = $1 AND type = $2 AND resource_key = $3 AND active = true
		`, rule.ID, rule.Metric, target.ID)
		return
	}

	// Tripped — contador de matches consecutivos
	var consecutive int
	err := s.pool.QueryRow(ctx, `
		INSERT INTO alert_rule_matches (agent_id, rule_id, resource_key, consecutive_count, last_value, last_seen_at)
		VALUES ($1::uuid, $2, $3, 1, $4, now())
		ON CONFLICT (agent_id, rule_id, resource_key) DO UPDATE SET
			consecutive_count = alert_rule_matches.consecutive_count + 1,
			last_value = EXCLUDED.last_value,
			last_seen_at = now()
		RETURNING consecutive_count
	`, dbAlertSentinelAgentID, rule.ID, target.ID, value).Scan(&consecutive)
	if err != nil {
		log.Printf("db alert match upsert: %v", err)
		return
	}

	if consecutive < rule.DurationSamples {
		return
	}

	_, message := buildDBAlertText(target, rule, value, meta)

	// Upsert sobre el indice unico parcial (agent_id, type, resource_key) WHERE active = true.
	// Usa el sentinel agent para satisfacer el NOT NULL.
	_, err = s.pool.Exec(ctx, `
		INSERT INTO alerts (
			agent_id, type, resource_key, severity, message,
			rule_id, observed_value, threshold_value, unit, duration_samples,
			notify_email, notify_telegram, cooldown_minutes
		) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (agent_id, type, resource_key) WHERE active = true
		DO UPDATE SET severity = EXCLUDED.severity,
		              message = EXCLUDED.message,
		              observed_value = EXCLUDED.observed_value,
		              threshold_value = EXCLUDED.threshold_value,
		              last_seen_at = now()
	`,
		dbAlertSentinelAgentID,
		rule.Metric,
		target.ID,
		rule.Severity,
		message,
		rule.ID,
		value,
		rule.Threshold,
		meta.Unit,
		rule.DurationSamples,
		rule.NotifyEmail,
		rule.NotifyTelegram,
		rule.CooldownMinutes,
	)
	if err != nil {
		log.Printf("db alert upsert (%s/%s): %v", target.Name, rule.Metric, err)
		return
	}
	log.Printf("db alert [%s] %s · %s = %.2f (thr %.2f)", rule.Severity, target.Name, rule.Metric, value, rule.Threshold)
}

func buildDBAlertText(target models.DatabaseTarget, rule models.AlertRule, value float64, meta dbAlertMetric) (string, string) {
	op := "≥"
	if meta.Inverted {
		op = "≤"
	}
	title := fmt.Sprintf("[%s] %s — %s", strings.ToUpper(rule.Severity), target.Name, meta.Label)
	desc := rule.Description
	if desc == "" {
		desc = meta.Label
	}
	message := fmt.Sprintf("%s: %.2f%s %s %.2f%s (BD %s, %s)",
		desc, value, meta.Unit, op, rule.Threshold, meta.Unit, target.Name, target.Type)
	return title, message
}

// dbAlertSentinelAgentID: alert_rule_matches tiene FK a agents. Para alertas DB
// (sin agent) usamos un UUID centinela. Si no existe ese agente, creamos un
// pseudo-agent una sola vez. Alternativa mas limpia seria nullable agent_id pero
// requiere migracion mas grande.
const dbAlertSentinelAgentID = "00000000-0000-0000-0000-000000000001"

// hasIdleInTxRule: bool si hay alguna regla activa para idle_in_tx en este target o global.
func (s *Store) hasIdleInTxRule(ctx context.Context, targetID string) bool {
	var n int
	_ = s.pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM alert_rules
		WHERE enabled = true AND metric = $1
		  AND agent_id IS NULL
		  AND (db_target_id IS NULL OR db_target_id = $2)
	`, dbMetricIdleInTxMin, targetID).Scan(&n)
	return n > 0
}

// computeMaxIdleInTxMinutes consulta pg_stat_activity para encontrar la transaccion
// idle in transaction mas vieja del target. Devuelve 0 si no hay o falla.
func (s *Store) computeMaxIdleInTxMinutes(ctx context.Context, targetID string) float64 {
	queries, err := s.GetActiveQueries(ctx, targetID)
	if err != nil {
		return 0
	}
	maxMin := 0.0
	for _, q := range queries {
		if strings.HasPrefix(q.State, "idle in transaction") {
			min := float64(q.DurationMs) / 60000.0
			if min > maxMin {
				maxMin = min
			}
		}
	}
	return maxMin
}

// SeedDefaultDBAlertRules inserta reglas default globales para todos los DB targets.
// Idempotente — usa ON CONFLICT DO NOTHING contra el indice unico de scope+metric.
func (s *Store) SeedDefaultDBAlertRules(ctx context.Context) error {
	if err := s.ensureAlertRulesSchema(ctx); err != nil {
		return err
	}
	// Asegurar el agent sentinel. La tabla `agents` tiene varios NOT NULL ademas
	// de `id` (name, hostname, os, arch, credential_hash, primary_ip) — todos se
	// rellenan con valores placeholder. El credential_hash es UNIQUE pero usamos
	// uno fijo del sentinel para que ON CONFLICT atrape el caso de re-insert.
	_, err := s.pool.Exec(ctx, `
		INSERT INTO agents (
			id, name, hostname, os, arch,
			credential_hash, status, primary_ip,
			created_at, updated_at
		) VALUES (
			$1::uuid, '__db_alert_sentinel__', '__db_alert_sentinel__', 'sentinel', 'sentinel',
			'sentinel:db-alerts', 'system', '0.0.0.0',
			now(), now()
		)
		ON CONFLICT (id) DO NOTHING
	`, dbAlertSentinelAgentID)
	if err != nil {
		return fmt.Errorf("seed db sentinel agent: %w", err)
	}

	rules := []struct {
		Metric      string
		Severity    string
		Threshold   float64
		Duration    int
		NotifyEmail bool
		Description string
	}{
		{dbMetricPoolPct, "warning", 80, 2, false, "Pool de conexiones alto"},
		{dbMetricPoolPct, "critical", 95, 2, true, "Pool de conexiones casi lleno"},
		{dbMetricCacheHitPct, "warning", 90, 5, false, "Cache hit ratio degradado (umbral inverso)"},
		{dbMetricSlowQueries, "warning", 5, 2, false, "Queries lentas concurrentes"},
		{dbMetricSlowQueries, "critical", 20, 2, true, "Cantidad alta de queries lentas activas"},
		{dbMetricDeadlocksPerHour, "warning", 5, 1, false, "Deadlocks por hora"},
		{dbMetricDeadlocksPerHour, "critical", 30, 1, true, "Deadlocks frecuentes"},
		{dbMetricIdleInTxMin, "warning", 10, 1, false, "Idle in transaction prolongada"},
		{dbMetricIdleInTxMin, "critical", 60, 1, true, "Idle in transaction muy larga"},
		{dbMetricRedisMemPct, "warning", 85, 2, false, "Memoria Redis alta"},
		{dbMetricRedisMemPct, "critical", 95, 2, true, "Memoria Redis casi al limite"},
		{dbMetricSampleErr, "warning", 0.5, 3, true, "DB no responde al polling"},
	}
	for _, r := range rules {
		_, err := s.pool.Exec(ctx, `
			INSERT INTO alert_rules (
				agent_id, db_target_id, metric, resource_key, severity, enabled,
				threshold, duration_samples, notify_email, notify_telegram, cooldown_minutes, description
			) VALUES (NULL, NULL, $1, '', $2, true, $3, $4, $5, false, 30, $6)
			ON CONFLICT DO NOTHING
		`, r.Metric, r.Severity, r.Threshold, r.Duration, r.NotifyEmail, r.Description)
		if err != nil {
			return fmt.Errorf("seed db rule %s/%s: %w", r.Metric, r.Severity, err)
		}
	}
	return nil
}
