package store

import (
	"context"
	"strings"

	"resource-monitor/backend/internal/models"
)

func (s *Store) ensureAlertNotificationSchema(ctx context.Context) error {
	if err := s.ensureAlertRuntimeSchemas(ctx); err != nil {
		return err
	}
	statements := []string{
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS seen_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS seen_by_username TEXT",
		"CREATE INDEX IF NOT EXISTS alerts_seen_idx ON alerts(seen_at, opened_at DESC)",
		`DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname = 'alerts_seen_by_user_id_fkey'
				  AND confdeltype <> 'n'
			) THEN
				ALTER TABLE alerts DROP CONSTRAINT alerts_seen_by_user_id_fkey;
				ALTER TABLE alerts
					ADD CONSTRAINT alerts_seen_by_user_id_fkey
					FOREIGN KEY (seen_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
			END IF;
		END $$;`,
	}
	for _, statement := range statements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AgentDetailNotifications(ctx context.Context, id string, offlineAfterSeconds int) (map[string]any, error) {
	detail, err := s.AgentDetailV31(ctx, id, offlineAfterSeconds)
	if err != nil {
		return nil, err
	}
	alerts, err := s.AgentAlertNotifications(ctx, id)
	if err != nil {
		return nil, err
	}
	detail["alerts"] = alerts
	if interval, err := s.GetAgentIntervalSeconds(ctx, id); err == nil {
		detail["interval_seconds"] = interval
	}
	return detail, nil
}

func (s *Store) ListAlertNotifications(ctx context.Context, seenFilter, activeFilter string) ([]models.Alert, error) {
	if err := s.ensureAlertNotificationSchema(ctx); err != nil {
		return nil, err
	}
	seenFilter = normalizeAlertNotificationFilter(seenFilter, "false")
	activeFilter = normalizeAlertNotificationFilter(activeFilter, "all")
	rows, err := s.pool.Query(ctx, alertNotificationSelect()+`
		WHERE ($1 = 'all' OR ($1 = 'false' AND al.seen_at IS NULL) OR ($1 = 'true' AND al.seen_at IS NOT NULL))
		  AND ($2 = 'all' OR ($2 = 'false' AND al.active = false) OR ($2 = 'true' AND al.active = true))
		ORDER BY (al.seen_at IS NULL) DESC, al.active DESC, al.opened_at DESC
	`, seenFilter, activeFilter)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	alerts, err := scanAlertNotifications(rows)
	if err != nil {
		return nil, err
	}
	return s.withAlertProcessSnapshots(ctx, alerts)
}

func (s *Store) AgentAlertNotifications(ctx context.Context, agentID string) ([]models.Alert, error) {
	if err := s.ensureAlertNotificationSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, alertNotificationSelect()+`
		WHERE al.agent_id = $1 AND (al.seen_at IS NULL OR al.active = true)
		ORDER BY (al.seen_at IS NULL) DESC, al.active DESC, al.severity = 'critical' DESC, al.opened_at DESC
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	alerts, err := scanAlertNotifications(rows)
	if err != nil {
		return nil, err
	}
	return s.withAlertProcessSnapshots(ctx, alerts)
}

func alertNotificationSelect() string {
	return `
		SELECT al.id::text, al.agent_id::text, a.name, al.type, al.severity, al.message,
		       al.resource_key, COALESCE(al.rule_id::text, ''), al.observed_value, al.threshold_value, al.unit,
		       al.duration_samples, al.notify_email, al.notify_telegram, al.notification_count, al.telegram_notification_count,
		       al.active, al.opened_at, al.resolved_at, al.seen_at,
		       COALESCE(al.seen_by_user_id::text, ''), COALESCE(al.seen_by_username, '')
		FROM alerts al
		JOIN agents a ON a.id = al.agent_id
	`
}

func scanAlertNotifications(rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}) ([]models.Alert, error) {
	alerts := []models.Alert{}
	for rows.Next() {
		var alert models.Alert
		var ruleID, seenByUserID, seenByUsername string
		if err := rows.Scan(&alert.ID, &alert.AgentID, &alert.AgentName, &alert.Type, &alert.Severity, &alert.Message, &alert.ResourceKey, &ruleID, &alert.ObservedValue, &alert.ThresholdValue, &alert.Unit, &alert.DurationSamples, &alert.NotifyEmail, &alert.NotifyTelegram, &alert.NotificationCount, &alert.TelegramNotificationCount, &alert.Active, &alert.OpenedAt, &alert.ResolvedAt, &alert.SeenAt, &seenByUserID, &seenByUsername); err != nil {
			return nil, err
		}
		if ruleID != "" {
			alert.RuleID = &ruleID
		}
		if seenByUserID != "" {
			alert.SeenByUserID = &seenByUserID
		}
		if seenByUsername != "" {
			alert.SeenByUsername = &seenByUsername
		}
		alerts = append(alerts, alert)
	}
	return alerts, rows.Err()
}

func (s *Store) MarkAlertSeen(ctx context.Context, alertID, userID, username string) error {
	if err := s.ensureAlertNotificationSchema(ctx); err != nil {
		return err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE alerts
		SET seen_at = COALESCE(seen_at, now()),
		    seen_by_user_id = COALESCE(seen_by_user_id, NULLIF($2, '')::uuid),
		    seen_by_username = COALESCE(seen_by_username, NULLIF($3, ''))
		WHERE id = $1
	`, alertID, userID, username)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) MarkAllAlertsSeen(ctx context.Context, userID, username string) (int64, error) {
	if err := s.ensureAlertNotificationSchema(ctx); err != nil {
		return 0, err
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE alerts
		SET seen_at = now(),
		    seen_by_user_id = NULLIF($1, '')::uuid,
		    seen_by_username = NULLIF($2, '')
		WHERE seen_at IS NULL
	`, userID, username)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func normalizeAlertNotificationFilter(value, fallback string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "false", "all":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return fallback
	}
}
