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
			DO UPDATE SET
				last_seen_at = now(),
				active = CASE WHEN network_interfaces.hidden_at IS NULL THEN true ELSE network_interfaces.active END,
				hidden_at = network_interfaces.hidden_at
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
	hidden, err := hideNoisyNetworksTx(ctx, tx, agentID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"status": "ok", "active": len(networks) - hidden, "hidden": hidden}, nil
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
		SELECT ns.name, ns.bytes_sent, ns.bytes_recv, ns.up,
		       COALESCE(ni.active, true), ni.hidden_at IS NOT NULL, ni.last_seen_at, ni.hidden_at
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
		if err := rows.Scan(&network.Name, &sent, &recv, &network.Up, &network.Active, &network.Hidden, &network.LastSeenAt, &network.HiddenAt); err != nil {
			return nil, err
		}
		network.BytesSent = uint64(sent)
		network.BytesRecv = uint64(recv)
		networks = append(networks, network)
	}
	return networks, rows.Err()
}

func (s *Store) HideAgentNetwork(ctx context.Context, agentID, name string) error {
	if name == "" {
		return nil
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	if err := s.ensureNetworkInterfaceSchema(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO network_interfaces (agent_id, name, first_seen_at, last_seen_at, active, hidden_at)
		VALUES ($1, $2, now(), now(), false, now())
		ON CONFLICT (agent_id, name)
		DO UPDATE SET active = false, hidden_at = COALESCE(network_interfaces.hidden_at, now())
	`, agentID, name)
	return err
}

func (s *Store) RestoreAgentNetwork(ctx context.Context, agentID, name string) error {
	if name == "" {
		return nil
	}
	if err := s.ensureAgentExists(ctx, agentID); err != nil {
		return err
	}
	if err := s.ensureNetworkInterfaceSchema(ctx); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE network_interfaces
		SET active = true, hidden_at = NULL
		WHERE agent_id = $1 AND name = $2
	`, agentID, name)
	return err
}

func hideNoisyNetworksTx(ctx context.Context, tx pgx.Tx, agentID string) (int, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE network_interfaces ni
		SET active = false, hidden_at = COALESCE(hidden_at, now())
		FROM network_samples ns
		WHERE ni.agent_id = $1
		  AND ns.agent_id = ni.agent_id
		  AND ns.name = ni.name
		  AND ns.metric_sample_id = (
			SELECT id FROM metric_samples WHERE agent_id = $1 ORDER BY captured_at DESC LIMIT 1
		  )
		  AND (
			lower(ni.name) LIKE 'br-%'
			OR lower(ni.name) LIKE 'veth%'
			OR lower(ni.name) LIKE 'docker%'
			OR lower(ni.name) LIKE 'virbr%'
			OR lower(ni.name) = 'lo'
			OR lower(ni.name) LIKE 'loopback%'
			OR lower(ni.name) LIKE '%loopback%'
			OR (ns.up = false AND ns.bytes_sent = 0 AND ns.bytes_recv = 0)
		  )
	`, agentID)
	return int(tag.RowsAffected()), err
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
