package store

import (
	"context"
	"time"
)

func (s *Store) AgentHistoryRates(ctx context.Context, agentID, rangeName string) (map[string]any, error) {
	window, bucket := historyWindowV3(rangeName)
	metrics, err := s.historyMetricsV3(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	networks, err := s.historyNetworkRates(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	disks, err := s.historyDisksV3(ctx, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"range":         rangeName,
		"window":        window,
		"bucket":        bucket,
		"metrics":       metrics,
		"network":       networks,
		"networks":      networks,
		"disks":         disks,
		"compatibility": "older agents may only include cpu, memory and disk metrics",
		"generated_at":  time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func (s *Store) historyNetworkRates(ctx context.Context, agentID, window, bucket string) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		WITH ordered AS (
			SELECT name,
			       captured_at,
			       bytes_sent,
			       bytes_recv,
			       lag(captured_at) OVER (PARTITION BY name ORDER BY captured_at) AS previous_at,
			       lag(bytes_sent) OVER (PARTITION BY name ORDER BY captured_at) AS previous_sent,
			       lag(bytes_recv) OVER (PARTITION BY name ORDER BY captured_at) AS previous_recv
			FROM network_samples
			WHERE agent_id = $1
			  AND captured_at >= now() - $2::interval - $3::interval
		), rates AS (
			SELECT captured_at,
			       EXTRACT(EPOCH FROM (captured_at - previous_at)) AS seconds,
			       bytes_sent - previous_sent AS delta_sent,
			       bytes_recv - previous_recv AS delta_recv
			FROM ordered
			WHERE previous_at IS NOT NULL
			  AND bytes_sent >= previous_sent
			  AND bytes_recv >= previous_recv
			  AND captured_at >= now() - $2::interval
		), per_sample AS (
			SELECT captured_at,
			       sum(delta_sent::float8 / NULLIF(seconds, 0)) AS sent_bps,
			       sum(delta_recv::float8 / NULLIF(seconds, 0)) AS recv_bps,
			       sum(delta_sent) AS sent_delta,
			       sum(delta_recv) AS recv_delta
			FROM rates
			WHERE seconds > 0
			GROUP BY captured_at
		)
		SELECT date_bin($3::interval, captured_at, timestamptz '2000-01-01') AS bucket,
		       coalesce(avg(sent_bps), 0),
		       coalesce(avg(recv_bps), 0),
		       coalesce(sum(sent_delta), 0),
		       coalesce(sum(recv_delta), 0)
		FROM per_sample
		GROUP BY bucket
		ORDER BY bucket
	`, agentID, window, bucket)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var capturedAt time.Time
		var sentBps, recvBps float64
		var sentDelta, recvDelta int64
		if err := rows.Scan(&capturedAt, &sentBps, &recvBps, &sentDelta, &recvDelta); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"captured_at":        capturedAt,
			"bytes_sent_per_sec": sentBps,
			"bytes_recv_per_sec": recvBps,
			"bytes_sent_delta":   sentDelta,
			"bytes_recv_delta":   recvDelta,
		})
	}
	return out, rows.Err()
}
