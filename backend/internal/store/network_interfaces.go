package store

import (
	"context"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func trackAgentNetworksTx(ctx context.Context, tx pgx.Tx, agentID string, networks []models.NetMetric) error {
	if len(networks) == 0 {
		return nil
	}
	names := make([]string, 0, len(networks))
	for _, network := range networks {
		if network.Name == "" {
			continue
		}
		names = append(names, network.Name)
		if _, err := tx.Exec(ctx, `
			INSERT INTO network_interfaces (agent_id, name, first_seen_at, last_seen_at, active, hidden_at)
			VALUES ($1, $2, now(), now(), true, NULL)
			ON CONFLICT (agent_id, name)
			DO UPDATE SET last_seen_at = now(), active = true, hidden_at = NULL
		`, agentID, network.Name); err != nil {
			return err
		}
	}
	if len(names) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `
		UPDATE network_interfaces
		SET active = false, hidden_at = COALESCE(hidden_at, now())
		WHERE agent_id = $1 AND NOT (name = ANY($2::text[]))
	`, agentID, names)
	return err
}

func (s *Store) ReconcileAgentNetworks(ctx context.Context, agentID string) (map[string]any, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	if err := s.ensureNetworkInterfaceSchema(ctx); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT name, bytes_sent, bytes_recv, up
		FROM network_samples
		WHERE metric_sample_id = (
			SELECT id FROM metric_samples WHERE agent_id = $1 ORDER BY captured_at DESC LIMIT 1
		)
	`, agentID)
	if err != nil {
		return nil, err
	}
	networks := []models.NetMetric{}
	for rows.Next() {
		var network models.NetMetric
		var sent, recv int64
		if err := rows.Scan(&network.Name, &sent, &recv, &network.Up); err != nil {
			rows.Close()
			return nil, err
		}
		network.BytesSent = uint64(sent)
		network.BytesRecv = uint64(recv)
		networks = append(networks, network)
	}
	if rows.Err() != nil {
		rows.Close()
		return nil, rows.Err()
	}
	rows.Close()

	if err := trackAgentNetworksTx(ctx, tx, agentID, networks); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"status": "ok", "active": len(networks)}, nil
}

func (s *Store) AgentNetworks(ctx context.Context, agentID string, includeInactive bool) ([]models.NetMetric, error) {
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return nil, err
	}
	if err := s.ensureNetworkInterfaceSchema(ctx); err != nil {
		return nil, err
	}
	query := `
		WITH latest AS (
			SELECT id
			FROM metric_samples
			WHERE agent_id = $1
			ORDER BY captured_at DESC
			LIMIT 1
		)
		SELECT ns.name, ns.bytes_sent, ns.bytes_recv, ns.up
		FROM network_samples ns
		JOIN latest ON latest.id = ns.metric_sample_id
		LEFT JOIN network_interfaces ni ON ni.agent_id = ns.agent_id AND ni.name = ns.name
		WHERE ($2 = true OR (COALESCE(ni.active, true) = true AND ni.hidden_at IS NULL))
		ORDER BY ns.name
	`
	rows, err := s.pool.Query(ctx, query, agentID, includeInactive)
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

func (s *Store) ensureNetworkInterfaceSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS network_interfaces (
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			active BOOLEAN NOT NULL DEFAULT true,
			hidden_at TIMESTAMPTZ,
			PRIMARY KEY (agent_id, name)
		)`,
		"CREATE INDEX IF NOT EXISTS network_interfaces_agent_active_idx ON network_interfaces(agent_id, active, last_seen_at DESC)",
	}
	for _, statement := range statements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}
