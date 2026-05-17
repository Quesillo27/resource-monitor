package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

// ensureDBHostAgentSchema crea las tablas para agentes de host de BD.
// Idempotente. Se llama desde Open() en cadena de migraciones.
func (s *Store) ensureDBHostAgentSchema(ctx context.Context) error {
	s.onceDBHostAgent.Do(func() { s.onceDBHostAgentErr = s.runDBHostAgentSchema(ctx) })
	return s.onceDBHostAgentErr
}

func (s *Store) runDBHostAgentSchema(ctx context.Context) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS db_host_enrollment_tokens (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			db_target_id UUID NOT NULL REFERENCES db_targets(id) ON DELETE CASCADE,
			token_hash TEXT NOT NULL UNIQUE,
			expires_at TIMESTAMPTZ NOT NULL,
			used_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS db_host_enroll_target_idx ON db_host_enrollment_tokens(db_target_id)`,
		`CREATE TABLE IF NOT EXISTS db_host_agents (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			db_target_id UUID NOT NULL REFERENCES db_targets(id) ON DELETE CASCADE,
			hostname TEXT NOT NULL DEFAULT '',
			os TEXT NOT NULL DEFAULT '',
			arch TEXT NOT NULL DEFAULT '',
			engine TEXT NOT NULL DEFAULT '',
			engine_version TEXT NOT NULL DEFAULT '',
			agent_version TEXT NOT NULL DEFAULT '',
			credential_hash TEXT NOT NULL,
			last_seen_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		// Un target solo puede tener un host agent activo. Si llega otro registro,
		// se actualiza el existente en vez de duplicar.
		`CREATE UNIQUE INDEX IF NOT EXISTS db_host_agents_target_uniq ON db_host_agents(db_target_id)`,
		`CREATE TABLE IF NOT EXISTS db_host_samples (
			id BIGSERIAL PRIMARY KEY,
			db_host_agent_id UUID NOT NULL REFERENCES db_host_agents(id) ON DELETE CASCADE,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			ok BOOLEAN NOT NULL DEFAULT true,
			error_message TEXT NOT NULL DEFAULT '',
			fs_used_pct DOUBLE PRECISION,
			fs_free_bytes BIGINT,
			fs_total_bytes BIGINT,
			io_read_ops BIGINT,
			io_write_ops BIGINT,
			io_read_bytes BIGINT,
			io_write_bytes BIGINT,
			wal_latency_ms DOUBLE PRECISION,
			oom_kills_delta INTEGER,
			pg_cpu_pct DOUBLE PRECISION,
			pg_rss_bytes BIGINT,
			pg_fd_used INTEGER,
			pg_fd_limit INTEGER,
			pg_uptime_seconds BIGINT,
			log_events JSONB NOT NULL DEFAULT '[]'::jsonb
		)`,
		`CREATE INDEX IF NOT EXISTS db_host_samples_agent_time_idx ON db_host_samples(db_host_agent_id, captured_at DESC)`,
	}
	for _, stmt := range stmts {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("db_host_agents schema: %w", err)
		}
	}
	return nil
}

// CreateDBHostEnrollmentToken genera un token de 1 uso para que el agente se
// registre contra el target especificado. TTL default 24h.
func (s *Store) CreateDBHostEnrollmentToken(ctx context.Context, dbTargetID string, ttlHours int) (*models.DBHostEnrollmentResult, error) {
	if err := s.ensureDBHostAgentSchema(ctx); err != nil {
		return nil, err
	}
	if _, err := s.GetDatabaseTarget(ctx, dbTargetID); err != nil {
		return nil, err
	}
	if ttlHours <= 0 {
		ttlHours = 24
	}
	token, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	expiresAt := time.Now().Add(time.Duration(ttlHours) * time.Hour)
	_, err = s.pool.Exec(ctx, `
		INSERT INTO db_host_enrollment_tokens (db_target_id, token_hash, expires_at)
		VALUES ($1, $2, $3)
	`, dbTargetID, hashSecret(token), expiresAt)
	if err != nil {
		return nil, err
	}
	return &models.DBHostEnrollmentResult{
		Token:     token,
		ExpiresAt: expiresAt.Format(time.RFC3339),
	}, nil
}

// RegisterDBHostAgent canjea un token de enrollment por una credencial
// permanente. Si ya existe un host agent para el target, rota su credencial
// (caso reinstall) en vez de duplicar.
func (s *Store) RegisterDBHostAgent(ctx context.Context, req models.DBHostRegisterRequest) (*models.DBHostRegisterResponse, error) {
	if err := s.ensureDBHostAgentSchema(ctx); err != nil {
		return nil, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var tokenID, dbTargetID string
	err = tx.QueryRow(ctx, `
		SELECT id::text, db_target_id::text
		FROM db_host_enrollment_tokens
		WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		FOR UPDATE
	`, hashSecret(req.EnrollmentToken)).Scan(&tokenID, &dbTargetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidEnrollmentToken
	}
	if err != nil {
		return nil, err
	}

	credential, err := randomToken(32)
	if err != nil {
		return nil, err
	}

	var hostAgentID string
	existErr := tx.QueryRow(ctx, `SELECT id::text FROM db_host_agents WHERE db_target_id = $1`, dbTargetID).Scan(&hostAgentID)
	if existErr == nil {
		// Rotar credencial + actualizar metadata, preservar historial de samples
		if _, err = tx.Exec(ctx, `
			UPDATE db_host_agents
			SET credential_hash=$1, hostname=$2, os=$3, arch=$4,
			    engine=$5, engine_version=$6, agent_version=$7,
			    last_seen_at=now(), updated_at=now()
			WHERE id=$8
		`, hashSecret(credential), req.Hostname, req.OS, req.Arch,
			req.Engine, req.EngineVersion, req.AgentVersion, hostAgentID); err != nil {
			return nil, err
		}
	} else if errors.Is(existErr, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO db_host_agents
			    (db_target_id, hostname, os, arch, engine, engine_version, agent_version, credential_hash, last_seen_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
			RETURNING id::text
		`, dbTargetID, req.Hostname, req.OS, req.Arch, req.Engine, req.EngineVersion,
			req.AgentVersion, hashSecret(credential)).Scan(&hostAgentID)
		if err != nil {
			return nil, err
		}
	} else {
		return nil, existErr
	}

	if _, err := tx.Exec(ctx, `UPDATE db_host_enrollment_tokens SET used_at = now() WHERE id = $1`, tokenID); err != nil {
		return nil, err
	}

	// Modo combinado: el mismo host también se registra como agente regular
	// para que mantenga el monitoreo estándar (CPU/RAM/disco/procesos).
	// Si ya existe un agent con el mismo hostname, rotamos su credencial
	// (no es recuperable porque está hasheada); si no, lo creamos nuevo.
	agentCredential, err := randomToken(32)
	if err != nil {
		return nil, err
	}
	var agentID string
	agentErr := tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE hostname = $1 LIMIT 1`, req.Hostname).Scan(&agentID)
	if agentErr == nil {
		if _, err = tx.Exec(ctx, `
			UPDATE agents
			SET credential_hash=$1, os=$2, arch=$3, agent_version=$4,
			    last_seen_at=now(), updated_at=now(), status='online'
			WHERE id=$5
		`, hashSecret(agentCredential), req.OS, req.Arch, req.AgentVersion, agentID); err != nil {
			return nil, err
		}
	} else if errors.Is(agentErr, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `
			INSERT INTO agents (name, hostname, os, arch, credential_hash, agent_version, status, primary_ip, last_seen_at)
			VALUES ($1, $2, $3, $4, $5, $6, 'online', '', now())
			RETURNING id::text
		`, req.Hostname, req.Hostname, req.OS, req.Arch, hashSecret(agentCredential), req.AgentVersion).Scan(&agentID)
		if err != nil {
			return nil, err
		}
	} else {
		return nil, agentErr
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &models.DBHostRegisterResponse{
		HostAgentID:     hostAgentID,
		DBTargetID:      dbTargetID,
		Credential:      credential,
		AgentID:         agentID,
		AgentCredential: agentCredential,
	}, nil
}

// AuthenticateDBHostAgent valida el credential de un host agent y retorna su ID.
func (s *Store) AuthenticateDBHostAgent(ctx context.Context, credential string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM db_host_agents WHERE credential_hash = $1`,
		hashSecret(credential)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnauthorized
	}
	return id, err
}

// InsertDBHostSample persiste un sample del agente y actualiza last_seen_at.
func (s *Store) InsertDBHostSample(ctx context.Context, hostAgentID string, sample models.DBHostSample, agentVersion, engineVersion string) error {
	logEvents, _ := json.Marshal(sample.LogEvents)
	if len(logEvents) == 0 {
		logEvents = []byte(`[]`)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO db_host_samples (
			db_host_agent_id, captured_at, ok, error_message,
			fs_used_pct, fs_free_bytes, fs_total_bytes,
			io_read_ops, io_write_ops, io_read_bytes, io_write_bytes,
			wal_latency_ms, oom_kills_delta,
			pg_cpu_pct, pg_rss_bytes, pg_fd_used, pg_fd_limit, pg_uptime_seconds,
			log_events
		) VALUES ($1, COALESCE($2, now()), $3, $4,
		          $5, $6, $7,
		          $8, $9, $10, $11,
		          $12, $13,
		          $14, $15, $16, $17, $18,
		          $19::jsonb)
	`, hostAgentID, nullableTime(sample.CapturedAt), sample.OK, sample.ErrorMessage,
		sample.FSUsedPct, sample.FSFreeBytes, sample.FSTotalBytes,
		sample.IOReadOps, sample.IOWriteOps, sample.IOReadBytes, sample.IOWriteBytes,
		sample.WalLatencyMs, sample.OOMKillsDelta,
		sample.PGCPUPct, sample.PGRSSBytes, sample.PGFDUsed, sample.PGFDLimit, sample.PGUptimeSec,
		string(logEvents)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE db_host_agents
		SET last_seen_at = now(), updated_at = now(),
		    agent_version = COALESCE(NULLIF($2, ''), agent_version),
		    engine_version = COALESCE(NULLIF($3, ''), engine_version)
		WHERE id = $1
	`, hostAgentID, agentVersion, engineVersion); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetDBHostAgentByTarget retorna el host agent vinculado al target, si existe.
// status se deriva: online si last_seen < 3*60s, offline en otro caso.
func (s *Store) GetDBHostAgentByTarget(ctx context.Context, dbTargetID string) (*models.DBHostAgent, error) {
	if err := s.ensureDBHostAgentSchema(ctx); err != nil {
		return nil, err
	}
	var a models.DBHostAgent
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, db_target_id::text, hostname, os, arch,
		       engine, engine_version, agent_version, last_seen_at, created_at,
		       CASE WHEN last_seen_at IS NULL OR last_seen_at < now() - interval '180 seconds'
		            THEN 'offline' ELSE 'online' END AS status
		FROM db_host_agents WHERE db_target_id = $1
	`, dbTargetID).Scan(&a.ID, &a.DBTargetID, &a.Hostname, &a.OS, &a.Arch,
		&a.Engine, &a.EngineVersion, &a.AgentVersion, &a.LastSeenAt, &a.CreatedAt, &a.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// ListDBHostSamples retorna los últimos N samples del host agent del target.
func (s *Store) ListDBHostSamples(ctx context.Context, dbTargetID string, limit int, since *time.Time) ([]models.DBHostSample, error) {
	if limit <= 0 {
		limit = 60
	}
	if limit > 2000 {
		limit = 2000
	}
	agent, err := s.GetDBHostAgentByTarget(ctx, dbTargetID)
	if err != nil {
		return nil, err
	}
	query := `
		SELECT id, db_host_agent_id::text, captured_at, ok, error_message,
		       fs_used_pct, fs_free_bytes, fs_total_bytes,
		       io_read_ops, io_write_ops, io_read_bytes, io_write_bytes,
		       wal_latency_ms, oom_kills_delta,
		       pg_cpu_pct, pg_rss_bytes, pg_fd_used, pg_fd_limit, pg_uptime_seconds,
		       log_events
		FROM db_host_samples WHERE db_host_agent_id = $1`
	args := []any{agent.ID}
	if since != nil {
		query += ` AND captured_at >= $2 ORDER BY captured_at DESC LIMIT $3`
		args = append(args, *since, limit)
	} else {
		query += ` ORDER BY captured_at DESC LIMIT $2`
		args = append(args, limit)
	}
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	samples := []models.DBHostSample{}
	for rows.Next() {
		var sm models.DBHostSample
		var logsRaw []byte
		if err := rows.Scan(&sm.ID, &sm.DBHostAgentID, &sm.CapturedAt, &sm.OK, &sm.ErrorMessage,
			&sm.FSUsedPct, &sm.FSFreeBytes, &sm.FSTotalBytes,
			&sm.IOReadOps, &sm.IOWriteOps, &sm.IOReadBytes, &sm.IOWriteBytes,
			&sm.WalLatencyMs, &sm.OOMKillsDelta,
			&sm.PGCPUPct, &sm.PGRSSBytes, &sm.PGFDUsed, &sm.PGFDLimit, &sm.PGUptimeSec,
			&logsRaw); err != nil {
			return nil, err
		}
		if len(logsRaw) > 0 {
			_ = json.Unmarshal(logsRaw, &sm.LogEvents)
		}
		samples = append(samples, sm)
	}
	return samples, rows.Err()
}

// DeleteDBHostAgent borra el agente y todos sus samples (CASCADE).
func (s *Store) DeleteDBHostAgent(ctx context.Context, dbTargetID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM db_host_agents WHERE db_target_id = $1`, dbTargetID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetTargetIDForHostAgent resuelve el db_target_id de un host agent dado su ID.
// Se usa en el handler de heartbeat para persistir db_sample bajo el target
// correcto sin que el agente tenga que mandarlo.
func (s *Store) GetTargetIDForHostAgent(ctx context.Context, hostAgentID string) (string, error) {
	var targetID string
	err := s.pool.QueryRow(ctx,
		`SELECT db_target_id::text FROM db_host_agents WHERE id = $1`,
		hostAgentID).Scan(&targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return targetID, err
}

// InsertDatabaseSampleFromAgent persiste un sample de BD enviado por un host
// agent que pollea la BD localmente. Reusa el mismo insert que el polling remoto.
func (s *Store) InsertDatabaseSampleFromAgent(ctx context.Context, sample models.DatabaseSample) error {
	return s.insertDBSample(ctx, sample)
}

// HasActiveDBHostAgent retorna true si el target tiene un host agent que reportó
// recientemente (< 180s). Se usa para que el polling remoto del manager skip targets
// monitoreados localmente.
func (s *Store) HasActiveDBHostAgent(ctx context.Context, dbTargetID string) (bool, error) {
	var count int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*)::int FROM db_host_agents
		WHERE db_target_id = $1
		  AND last_seen_at IS NOT NULL
		  AND last_seen_at > now() - interval '180 seconds'
	`, dbTargetID).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
