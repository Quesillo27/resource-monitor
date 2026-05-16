package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"resource-monitor/backend/internal/models"
)

// Insight = un hallazgo derivado de métricas históricas o consultas live.
// Severidad: "info" | "warn" | "crit". metric/value son opcionales y sirven para
// que el frontend renderice contexto numérico junto al texto.
type Insight struct {
	Severity string  `json:"severity"`
	Title    string  `json:"title"`
	Detail   string  `json:"detail"`
	Metric   string  `json:"metric,omitempty"`
	Value    float64 `json:"value,omitempty"`
	Hint     string  `json:"hint,omitempty"`
}

// GenerateInsights analiza últimos N samples + (si es PG) consultas live para
// generar hallazgos accionables. No persiste; calcula on-demand.
func (s *Store) GenerateInsights(ctx context.Context, targetID string) ([]Insight, error) {
	t, err := s.GetDatabaseTarget(ctx, targetID)
	if err != nil {
		return nil, err
	}

	// Toma hasta 200 samples (~3.3 horas a 60s o ~16h a 5min)
	samples, err := s.GetDatabaseMetrics(ctx, targetID, 200, nil)
	if err != nil {
		return nil, err
	}
	if len(samples) == 0 {
		return []Insight{}, nil
	}

	insights := []Insight{}
	insights = append(insights, analyzeCacheTrend(samples)...)
	insights = append(insights, analyzeConnPool(samples)...)
	insights = append(insights, analyzeDeadlocks(samples)...)
	insights = append(insights, analyzeDBGrowth(samples)...)
	insights = append(insights, analyzeSlowQueryTrend(samples)...)
	insights = append(insights, analyzeXidWraparound(samples)...)
	insights = append(insights, analyzeRedisFrag(samples, t.Type)...)

	if t.Type == "postgres" {
		// Consultas live PG-specific
		if pgs, err := s.pgInsightsLive(ctx, targetID); err == nil {
			insights = append(insights, pgs...)
		}
	}

	return insights, nil
}

func analyzeCacheTrend(samples []models.DatabaseSample) []Insight {
	// Compara cache hit ratio promedio "reciente" (últimos 5) vs "anterior" (5 previos)
	if len(samples) < 12 {
		return nil
	}
	recent := avgCacheHit(samples[:5])
	prior := avgCacheHit(samples[5:12])
	if recent == 0 || prior == 0 {
		return nil
	}
	delta := recent - prior // negativo = empeoró
	if delta < -0.05 {
		return []Insight{{
			Severity: severityForCacheDrop(recent, delta),
			Title:    fmt.Sprintf("Cache hit cayó %.1f puntos", math.Abs(delta)*100),
			Detail:   fmt.Sprintf("Hit ratio reciente %.1f%% vs %.1f%% en el período anterior. Si el patrón persiste, el working set puede estar excediendo el caché.", recent*100, prior*100),
			Metric:   "cache_hit_ratio",
			Value:    recent,
			Hint:     "Revisar shared_buffers (PG) o maxmemory (Redis); investigar queries con seq scans pesados.",
		}}
	}
	return nil
}

func analyzeConnPool(samples []models.DatabaseSample) []Insight {
	last := samples[0]
	if last.ConnectionsTotal == nil || last.MaxConnections == nil || *last.MaxConnections == 0 {
		return nil
	}
	pct := float64(*last.ConnectionsTotal) / float64(*last.MaxConnections) * 100
	if pct >= 85 {
		return []Insight{{
			Severity: ifThenElse(pct >= 95, "crit", "warn"),
			Title:    fmt.Sprintf("Pool de conexiones al %.0f%%", pct),
			Detail:   fmt.Sprintf("%d de %d conexiones máximas en uso. Conexiones nuevas pueden ser rechazadas si llega al 100%%.", *last.ConnectionsTotal, *last.MaxConnections),
			Metric:   "conn_pct",
			Value:    pct,
			Hint:     "Auditar conexiones idle prolongadas; considerar pgbouncer/proxysql; aumentar max_connections con cuidado (consume RAM).",
		}}
	}
	return nil
}

func analyzeDeadlocks(samples []models.DatabaseSample) []Insight {
	// Mira deadlocks acumulados en los últimos 30 samples vs anteriores 30
	if len(samples) < 30 {
		return nil
	}
	first, last := samples[len(samples)-1], samples[0]
	if first.Deadlocks == nil || last.Deadlocks == nil {
		return nil
	}
	delta := *last.Deadlocks - *first.Deadlocks
	if delta <= 0 {
		return nil
	}
	dur := last.CapturedAt.Sub(first.CapturedAt)
	rate := float64(delta) / dur.Hours()
	if rate >= 1 {
		return []Insight{{
			Severity: ifThenElse(rate >= 10, "crit", "warn"),
			Title:    fmt.Sprintf("%.0f deadlocks/hora detectados", rate),
			Detail:   fmt.Sprintf("%d deadlocks acumulados en las últimas %s. Indica contención de locks entre transacciones concurrentes.", delta, dur.Round(time.Minute)),
			Metric:   "deadlocks_per_hour",
			Value:    rate,
			Hint:     "Revisar pg_stat_database.deadlocks; activar log_lock_waits=on y deadlock_timeout=1s para capturar trazas.",
		}}
	}
	return nil
}

func analyzeDBGrowth(samples []models.DatabaseSample) []Insight {
	// Tasa de crecimiento de DB size: regresión lineal simple sobre últimos N
	pts := make([][2]float64, 0, len(samples))
	t0 := samples[len(samples)-1].CapturedAt
	for i := len(samples) - 1; i >= 0; i-- {
		s := samples[i]
		if s.DBSizeBytes == nil {
			continue
		}
		x := s.CapturedAt.Sub(t0).Hours()
		y := float64(*s.DBSizeBytes)
		pts = append(pts, [2]float64{x, y})
	}
	if len(pts) < 5 {
		return nil
	}
	slope := linRegSlope(pts) // bytes por hora
	if slope <= 0 {
		return nil
	}
	mbPerDay := slope * 24 / (1024 * 1024)
	if mbPerDay < 50 {
		return nil
	}
	return []Insight{{
		Severity: ifThenElse(mbPerDay > 1024, "warn", "info"),
		Title:    fmt.Sprintf("Base crece ~%s/día", humanMB(mbPerDay)),
		Detail:   fmt.Sprintf("Tasa estimada por regresión sobre %d samples. A este ritmo, en 30 días sumará ~%s.", len(pts), humanMB(mbPerDay*30)),
		Metric:   "db_growth_mb_per_day",
		Value:    mbPerDay,
		Hint:     "Auditar tablas con mayor crecimiento (pg_stat_user_tables.n_live_tup); revisar políticas de retención y si hay datos auto-purgables.",
	}}
}

func analyzeSlowQueryTrend(samples []models.DatabaseSample) []Insight {
	if len(samples) < 6 {
		return nil
	}
	// Promedio de slow_queries activas en los últimos 5 vs 5 previos
	recent := avgSlowQueries(samples[:5])
	prior := avgSlowQueries(samples[5:10])
	if recent <= 0 {
		return nil
	}
	if recent >= 3 && recent > prior*2 {
		return []Insight{{
			Severity: ifThenElse(recent >= 10, "crit", "warn"),
			Title:    fmt.Sprintf("Queries lentas activas: ~%.0f promedio", recent),
			Detail:   fmt.Sprintf("Promedio reciente %.1f vs %.1f en el período anterior. Indica congestión de queries de larga duración.", recent, prior),
			Metric:   "slow_queries_active",
			Value:    recent,
			Hint:     "Revisar 'En vivo' para ver consultas activas y considerar terminar las que llevan más tiempo. Auditar índices faltantes con pg_stat_statements.",
		}}
	}
	return nil
}

func analyzeXidWraparound(samples []models.DatabaseSample) []Insight {
	last := samples[0]
	if last.XidAge == nil {
		return nil
	}
	age := *last.XidAge
	const wraparoundLimit = 2_000_000_000
	pct := float64(age) / float64(wraparoundLimit) * 100
	if pct < 50 {
		return nil
	}
	return []Insight{{
		Severity: ifThenElse(pct >= 80, "crit", "warn"),
		Title:    fmt.Sprintf("XID age al %.0f%% del wraparound", pct),
		Detail:   fmt.Sprintf("Edad de transacción más vieja: %s. PostgreSQL detiene escrituras al alcanzar el límite (~2.1B). Forzar VACUUM si llega al 90%%.", formatXidAge(age)),
		Metric:   "xid_age_pct",
		Value:    pct,
		Hint:     "Ejecutar VACUUM (FREEZE) en tablas con autovacuum atrasado. Revisar pg_stat_progress_vacuum y autovacuum_freeze_max_age.",
	}}
}

func analyzeRedisFrag(samples []models.DatabaseSample, dbType string) []Insight {
	if dbType != "redis" {
		return nil
	}
	last := samples[0]
	if last.MemoryUsedBytes == nil || last.MemoryMaxBytes == nil || *last.MemoryMaxBytes == 0 {
		return nil
	}
	pct := float64(*last.MemoryUsedBytes) / float64(*last.MemoryMaxBytes) * 100
	if pct >= 85 {
		return []Insight{{
			Severity: ifThenElse(pct >= 95, "crit", "warn"),
			Title:    fmt.Sprintf("Redis al %.0f%% de maxmemory", pct),
			Detail:   "Cerca del límite de evicción. Si usás política `noeviction`, los SET nuevos van a fallar.",
			Metric:   "redis_mem_pct",
			Value:    pct,
			Hint:     "Revisar política de eviction (CONFIG GET maxmemory-policy); auditar keys con MEMORY USAGE; considerar TTL agresivo.",
		}}
	}
	return nil
}

// pgInsightsLive consulta queries activas para detectar patrones tóxicos.
func (s *Store) pgInsightsLive(ctx context.Context, targetID string) ([]Insight, error) {
	queries, err := s.GetActiveQueries(ctx, targetID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, nil
		}
		return nil, err
	}
	out := []Insight{}

	// Idle in transaction prolongado (>10 min)
	for _, q := range queries {
		if q.State == "idle in transaction" && q.DurationMs >= 10*60*1000 {
			out = append(out, Insight{
				Severity: ifThenElse(q.DurationMs >= 60*60*1000, "crit", "warn"),
				Title:    fmt.Sprintf("PID %d lleva %s en idle in transaction", q.PID, formatDur(q.DurationMs)),
				Detail:   fmt.Sprintf("Aplicación: %s · usuario: %s. Bloquea VACUUM y mantiene snapshots viejos.", q.AppName, q.UserName),
				Metric:   "idle_in_tx_ms",
				Value:    float64(q.DurationMs),
				Hint:     "Identificar el cliente y forzar rollback si la app crasheó. Considerar idle_in_transaction_session_timeout.",
			})
			if len(out) >= 3 {
				break // máximo 3 menciones para no spammear
			}
		}
	}
	return out, nil
}

// ── helpers ────────────────────────────────────────────────────────────────

func avgCacheHit(s []models.DatabaseSample) float64 {
	sum, n := 0.0, 0
	for _, x := range s {
		if x.CacheHitRatio != nil {
			sum += *x.CacheHitRatio
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

func avgSlowQueries(s []models.DatabaseSample) float64 {
	sum, n := 0.0, 0
	for _, x := range s {
		if x.SlowQueries != nil {
			sum += float64(*x.SlowQueries)
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

// linRegSlope: regresión lineal simple, devuelve la pendiente (y por unidad de x).
func linRegSlope(pts [][2]float64) float64 {
	n := float64(len(pts))
	if n < 2 {
		return 0
	}
	var sumX, sumY, sumXY, sumX2 float64
	for _, p := range pts {
		sumX += p[0]
		sumY += p[1]
		sumXY += p[0] * p[1]
		sumX2 += p[0] * p[0]
	}
	denom := n*sumX2 - sumX*sumX
	if denom == 0 {
		return 0
	}
	return (n*sumXY - sumX*sumY) / denom
}

func severityForCacheDrop(recent, delta float64) string {
	if recent < 0.7 || delta < -0.15 {
		return "crit"
	}
	return "warn"
}

func ifThenElse(cond bool, a, b string) string {
	if cond {
		return a
	}
	return b
}

func humanMB(mb float64) string {
	if mb >= 1024 {
		return fmt.Sprintf("%.2f GB", mb/1024)
	}
	return fmt.Sprintf("%.0f MB", mb)
}

func formatXidAge(age int64) string {
	if age >= 1_000_000_000 {
		return fmt.Sprintf("%.2fB", float64(age)/1_000_000_000)
	}
	if age >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(age)/1_000_000)
	}
	return fmt.Sprintf("%d", age)
}

func formatDur(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d >= time.Hour {
		return fmt.Sprintf("%.1fh", d.Hours())
	}
	if d >= time.Minute {
		return fmt.Sprintf("%.0fm", d.Minutes())
	}
	return d.Round(time.Second).String()
}
