CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  uptime_seconds BIGINT NOT NULL DEFAULT 0,
  credential_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_last_seen_idx ON agents(last_seen_at);

CREATE TABLE IF NOT EXISTS metric_samples (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_percent DOUBLE PRECISION NOT NULL,
  memory_total_bytes BIGINT NOT NULL,
  memory_used_bytes BIGINT NOT NULL,
  memory_used_percent DOUBLE PRECISION NOT NULL,
  swap_total_bytes BIGINT NOT NULL DEFAULT 0,
  swap_used_bytes BIGINT NOT NULL DEFAULT 0,
  swap_used_percent DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS metric_samples_agent_time_idx ON metric_samples(agent_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS metric_samples_captured_idx ON metric_samples(captured_at);

CREATE TABLE IF NOT EXISTS disk_samples (
  id BIGSERIAL PRIMARY KEY,
  metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  mountpoint TEXT NOT NULL,
  filesystem TEXT NOT NULL,
  total_bytes BIGINT NOT NULL,
  used_bytes BIGINT NOT NULL,
  free_bytes BIGINT NOT NULL,
  used_percent DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS disk_samples_agent_time_idx ON disk_samples(agent_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS network_samples (
  id BIGSERIAL PRIMARY KEY,
  metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  bytes_sent BIGINT NOT NULL,
  bytes_recv BIGINT NOT NULL,
  up BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS network_samples_agent_time_idx ON network_samples(agent_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS process_samples (
  id BIGSERIAL PRIMARY KEY,
  metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pid INTEGER NOT NULL,
  name TEXT NOT NULL,
  cpu_percent DOUBLE PRECISION NOT NULL,
  memory_percent DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS process_samples_agent_time_idx ON process_samples(agent_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS service_samples (
  id BIGSERIAL PRIMARY KEY,
  metric_sample_id BIGINT NOT NULL REFERENCES metric_samples(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS service_samples_agent_time_idx ON service_samples(agent_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  resource_key TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_active_idx ON alerts(active, severity);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_active_resource_idx
  ON alerts(agent_id, type, resource_key)
  WHERE active = true;
