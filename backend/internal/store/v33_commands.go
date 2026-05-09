package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// EnsureV33Schema agrega la cola de comandos manager→agente y la columna
// agent_version para tracking de versión.
func (s *Store) EnsureV33Schema(ctx context.Context) error {
	stmts := []string{
		`ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_version TEXT DEFAULT ''`,
		`CREATE TABLE IF NOT EXISTS agent_commands (
			id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			command      TEXT NOT NULL,
			params       JSONB DEFAULT '{}'::jsonb,
			status       TEXT NOT NULL DEFAULT 'pending',
			created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
			delivered_at TIMESTAMPTZ,
			completed_at TIMESTAMPTZ,
			result       JSONB,
			error        TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_status
			ON agent_commands(agent_id, status, created_at)`,
	}
	for _, stmt := range stmts {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

// AgentCommand es la representación de un comando para enviar al agente.
type AgentCommand struct {
	ID      string         `json:"id"`
	Command string         `json:"command"`
	Params  map[string]any `json:"params,omitempty"`
}

// AgentCommandRow es la fila completa para mostrar en el UI.
type AgentCommandRow struct {
	ID          string          `json:"id"`
	AgentID     string          `json:"agent_id"`
	Command     string          `json:"command"`
	Params      json.RawMessage `json:"params"`
	Status      string          `json:"status"`
	CreatedAt   time.Time       `json:"created_at"`
	DeliveredAt *time.Time      `json:"delivered_at,omitempty"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// EnqueueAgentCommand encola un comando para el agente. Si ya hay uno
// pendiente del mismo tipo para el mismo agente, no duplica.
func (s *Store) EnqueueAgentCommand(ctx context.Context, agentID, command string, params map[string]any) (AgentCommandRow, error) {
	if err := s.EnsureV33Schema(ctx); err != nil {
		return AgentCommandRow{}, err
	}
	command = strings.TrimSpace(command)
	if command == "" {
		return AgentCommandRow{}, errors.New("command is required")
	}
	rawParams, err := json.Marshal(params)
	if err != nil {
		return AgentCommandRow{}, err
	}
	var existingID string
	err = s.pool.QueryRow(ctx, `
		SELECT id::text FROM agent_commands
		WHERE agent_id = $1 AND command = $2 AND status IN ('pending','delivered')
		ORDER BY created_at DESC LIMIT 1
	`, agentID, command).Scan(&existingID)
	if err == nil {
		return s.GetAgentCommand(ctx, existingID)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return AgentCommandRow{}, err
	}

	var id string
	err = s.pool.QueryRow(ctx, `
		INSERT INTO agent_commands (agent_id, command, params)
		VALUES ($1, $2, $3)
		RETURNING id::text
	`, agentID, command, rawParams).Scan(&id)
	if err != nil {
		return AgentCommandRow{}, err
	}
	return s.GetAgentCommand(ctx, id)
}

// PendingCommandsForAgent devuelve los comandos pendientes para un agente y
// los marca como 'delivered' (cambia status), permitiendo al agente
// procesarlos sin que se reentreguen en el siguiente heartbeat.
func (s *Store) PendingCommandsForAgent(ctx context.Context, agentID string) ([]AgentCommand, error) {
	if err := s.EnsureV33Schema(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		UPDATE agent_commands
		SET status = 'delivered', delivered_at = now()
		WHERE id IN (
			SELECT id FROM agent_commands
			WHERE agent_id = $1 AND status = 'pending'
			ORDER BY created_at
			LIMIT 5
		)
		RETURNING id::text, command, params
	`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentCommand{}
	for rows.Next() {
		var cmd AgentCommand
		var paramsRaw []byte
		if err := rows.Scan(&cmd.ID, &cmd.Command, &paramsRaw); err != nil {
			return nil, err
		}
		if len(paramsRaw) > 0 {
			_ = json.Unmarshal(paramsRaw, &cmd.Params)
		}
		out = append(out, cmd)
	}
	return out, nil
}

// CompleteAgentCommand registra el resultado del agente (éxito o fallo).
func (s *Store) CompleteAgentCommand(ctx context.Context, agentID, commandID string, ok bool, result map[string]any, errMsg string) error {
	if err := s.EnsureV33Schema(ctx); err != nil {
		return err
	}
	status := "completed"
	if !ok {
		status = "failed"
	}
	rawResult, _ := json.Marshal(result)
	_, err := s.pool.Exec(ctx, `
		UPDATE agent_commands
		SET status = $3, completed_at = now(), result = $4, error = $5
		WHERE id = $1 AND agent_id = $2
	`, commandID, agentID, status, rawResult, errMsg)
	return err
}

// GetAgentCommand devuelve la fila completa.
func (s *Store) GetAgentCommand(ctx context.Context, id string) (AgentCommandRow, error) {
	var row AgentCommandRow
	var params, result []byte
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, agent_id::text, command, params, status,
		       created_at, delivered_at, completed_at, COALESCE(result, '{}'::jsonb), COALESCE(error, '')
		FROM agent_commands
		WHERE id = $1
	`, id).Scan(&row.ID, &row.AgentID, &row.Command, &params, &row.Status,
		&row.CreatedAt, &row.DeliveredAt, &row.CompletedAt, &result, &row.Error)
	if err != nil {
		return row, err
	}
	row.Params = params
	row.Result = result
	return row, nil
}

// ListAgentCommands devuelve los últimos N comandos del agente para mostrar
// en el UI.
func (s *Store) ListAgentCommands(ctx context.Context, agentID string, limit int) ([]AgentCommandRow, error) {
	if err := s.EnsureV33Schema(ctx); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, agent_id::text, command, params, status,
		       created_at, delivered_at, completed_at, COALESCE(result, '{}'::jsonb), COALESCE(error, '')
		FROM agent_commands
		WHERE agent_id = $1
		ORDER BY created_at DESC
		LIMIT $2
	`, agentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AgentCommandRow{}
	for rows.Next() {
		var row AgentCommandRow
		var params, result []byte
		if err := rows.Scan(&row.ID, &row.AgentID, &row.Command, &params, &row.Status,
			&row.CreatedAt, &row.DeliveredAt, &row.CompletedAt, &result, &row.Error); err != nil {
			return nil, err
		}
		row.Params = params
		row.Result = result
		out = append(out, row)
	}
	return out, nil
}

func stringValue(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func timeValue(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}

// UpdateAgentVersion guarda la versión reportada por el agente en heartbeat.
func (s *Store) UpdateAgentVersion(ctx context.Context, agentID, version string) error {
	if err := s.EnsureV33Schema(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(version) == "" {
		return nil
	}
	_, err := s.pool.Exec(ctx, `UPDATE agents SET agent_version = $2, updated_at = now() WHERE id = $1`, agentID, version)
	return err
}
