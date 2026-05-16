package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// getPGTargetPool devuelve un pool pgx dedicado para el target PG dado.
// El pool se crea perezosamente la primera vez y se reutiliza después; permite
// que los endpoints live amorticen el handshake TCP/TLS/auth en lugar de pagar
// 50-500ms (sano) o 10-15s (BD colgada) por request. Si el DSN cambia tras un
// Update se debe llamar a invalidateTargetPool para forzar recreación.
func (s *Store) getPGTargetPool(ctx context.Context, targetID, dsn string) (*pgxpool.Pool, error) {
	s.dbTargetPoolsMu.RLock()
	pool, ok := s.dbTargetPools[targetID]
	s.dbTargetPoolsMu.RUnlock()
	if ok {
		return pool, nil
	}

	s.dbTargetPoolsMu.Lock()
	defer s.dbTargetPoolsMu.Unlock()
	if pool, ok := s.dbTargetPools[targetID]; ok {
		return pool, nil
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 3
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = 1 * time.Minute

	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if s.dbTargetPools == nil {
		s.dbTargetPools = make(map[string]*pgxpool.Pool)
	}
	s.dbTargetPools[targetID] = pool
	return pool, nil
}

// invalidateTargetPool cierra el pool asociado al target y lo elimina del map.
// Llamar tras Update (DSN puede haber cambiado) o Delete.
func (s *Store) invalidateTargetPool(targetID string) {
	s.dbTargetPoolsMu.Lock()
	pool, ok := s.dbTargetPools[targetID]
	if ok {
		delete(s.dbTargetPools, targetID)
	}
	s.dbTargetPoolsMu.Unlock()
	if ok {
		pool.Close()
	}
}

// closeAllTargetPools cierra todos los pools de targets. Llamar desde Store.Close.
func (s *Store) closeAllTargetPools() {
	s.dbTargetPoolsMu.Lock()
	pools := s.dbTargetPools
	s.dbTargetPools = nil
	s.dbTargetPoolsMu.Unlock()
	for _, p := range pools {
		p.Close()
	}
}
