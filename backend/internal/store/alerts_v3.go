package store

import (
	"context"

	"resource-monitor/backend/internal/models"
)

func (s *Store) agentAlerts(ctx context.Context, agentID string) ([]models.Alert, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT al.id::text, al.agent_id::text, a.name, al.type, al.severity, al.message,
		       al.active, al.opened_at, al.resolved_at
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
		WHERE al.agent_id = $1 AND al.active = true
		ORDER BY al.severity = 'critical' DESC, al.opened_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	alerts := []models.Alert{}
	for rows.Next() {
		var alert models.Alert
		if err := rows.Scan(&alert.ID, &alert.AgentID, &alert.AgentName, &alert.Type, &alert.Severity, &alert.Message, &alert.Active, &alert.OpenedAt, &alert.ResolvedAt); err != nil {
			return nil, err
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}
