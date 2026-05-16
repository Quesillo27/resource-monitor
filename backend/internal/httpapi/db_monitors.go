package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"resource-monitor/backend/internal/models"
	"resource-monitor/backend/internal/store"

	"github.com/go-chi/chi/v5"
)

func (s *Server) listDBTargets(w http.ResponseWriter, r *http.Request) {
	targets, err := s.store.ListDatabaseTargets(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for i := range targets {
		targets[i].DSN = store.MaskDSN(targets[i].DSN)
	}
	writeJSON(w, http.StatusOK, map[string]any{"targets": targets})
}

func (s *Server) createDBTarget(w http.ResponseWriter, r *http.Request) {
	var t models.DatabaseTarget
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if t.Name == "" || t.DSN == "" {
		http.Error(w, "name and dsn are required", http.StatusBadRequest)
		return
	}
	if t.Type != "postgres" && t.Type != "redis" {
		http.Error(w, "type must be postgres or redis", http.StatusBadRequest)
		return
	}
	created, err := s.store.CreateDatabaseTarget(r.Context(), t)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	created.DSN = store.MaskDSN(created.DSN)
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) updateDBTarget(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var t models.DatabaseTarget
	if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if t.Type != "" && t.Type != "postgres" && t.Type != "redis" {
		http.Error(w, "type must be postgres or redis", http.StatusBadRequest)
		return
	}
	// If client returned the masked DSN, preserve the original from DB
	if store.DSNIsMasked(t.DSN) {
		existing, err := s.store.GetDatabaseTarget(r.Context(), id)
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		t.DSN = existing.DSN
	}
	updated, err := s.store.UpdateDatabaseTarget(r.Context(), id, t)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	updated.DSN = store.MaskDSN(updated.DSN)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) deleteDBTarget(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.DeleteDatabaseTarget(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getDBMetrics(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limitStr := r.URL.Query().Get("limit")
	limit, _ := strconv.Atoi(limitStr)
	samples, err := s.store.GetDatabaseMetrics(r.Context(), id, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"samples": samples})
}

func (s *Server) pollDBTarget(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	go func() {
		defer cancel()
		s.store.PollAllDatabaseTargets(ctx)
	}()
	writeJSON(w, http.StatusOK, map[string]string{"status": "polling"})
}

func (s *Server) getDBLiveInfo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.store.GetPGLiveInfo(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) getDBActiveQueries(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	queries, err := s.store.GetActiveQueries(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queries": queries})
}

func (s *Server) getDBTableSizes(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sizes, err := s.store.GetTableSizes(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": sizes})
}

func (s *Server) getDBVacuumStats(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	stats, err := s.store.GetVacuumStats(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": stats})
}

func (s *Server) getDBIndexUsage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	indexes, err := s.store.GetIndexUsage(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"indexes": indexes})
}

func (s *Server) getDBSlowQueries(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	queries, err := s.store.GetSlowQueries(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"queries": queries, "available": true})
}

func (s *Server) testDBConnection(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type   string            `json:"type"`
		DSN    string            `json:"dsn"`
		Params map[string]string `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if req.DSN == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": "DSN vacío"})
		return
	}
	ms, err := store.TestConnection(r.Context(), req.Type, req.DSN, req.Params)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error(), "duration_ms": ms})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "duration_ms": ms})
}

func (s *Server) getDBReplication(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	replicas, err := s.store.GetPGReplication(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"replicas": replicas})
}

func (s *Server) getDBRedisLive(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	info, err := s.store.GetRedisLiveInfo(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) getDBRedisSlowlog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	entries, err := s.store.GetRedisSlowlog(r.Context(), id, limit)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (s *Server) getDBRedisClients(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	clients, err := s.store.GetRedisClients(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"clients": clients})
}

func (s *Server) getDBRedisMemoryStats(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	stats, err := s.store.GetRedisMemoryStats(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

