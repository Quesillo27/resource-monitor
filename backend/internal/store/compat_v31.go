package store

import (
	"context"

	"resource-monitor/backend/internal/models"
)

func (s *Store) agentAlerts(ctx context.Context, agentID string) ([]models.Alert, error) {
	return s.AgentAlertsV31(ctx, agentID)
}
