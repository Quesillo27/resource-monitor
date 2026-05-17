package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"resource-monitor/backend/internal/models"
	"resource-monitor/backend/internal/store"

	"github.com/go-chi/chi/v5"
)

// createDBHostToken genera un token de enrollment para que un agente se vincule
// al db_target. El frontend devuelve el comando one-shot al admin.
func (s *Server) createDBHostToken(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	ttlHours, _ := strconv.Atoi(r.URL.Query().Get("ttl_hours"))
	result, err := s.store.CreateDBHostEnrollmentToken(r.Context(), id, ttlHours)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "db target not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Comando de instalación se arma con el host de la request (lo que ve el cliente).
	// El instalador real lee server URL del token de enrollment; por ahora el
	// frontend solo lo muestra como referencia.
	scheme := "https"
	if r.TLS == nil && r.Header.Get("X-Forwarded-Proto") != "https" {
		scheme = "http"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	result.InstallCommand = fmt.Sprintf(
		"curl -fsSL %s://%s/install-db-agent.sh | sudo bash -s -- --token=%s --server=%s://%s",
		scheme, host, result.Token, scheme, host,
	)
	writeJSON(w, http.StatusOK, result)
}

// getDBHostAgent devuelve el agente de host vinculado al target (si existe),
// junto con las últimas muestras.
func (s *Server) getDBHostAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	var since *time.Time
	if mins, _ := strconv.Atoi(q.Get("minutes")); mins > 0 {
		t := time.Now().Add(-time.Duration(mins) * time.Minute)
		since = &t
	}
	agent, err := s.store.GetDBHostAgentByTarget(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"agent": nil, "samples": []any{}})
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	samples, err := s.store.ListDBHostSamples(r.Context(), id, limit, since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": agent, "samples": samples})
}

// deleteDBHostAgent desvincula el agente del target (borra agente + samples).
func (s *Server) deleteDBHostAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	err := s.store.DeleteDBHostAgent(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "no host agent linked", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// registerDBHostAgent — endpoint público que canjea el enrollment token por una
// credencial permanente. Lo llama el agente al arrancar la primera vez.
func (s *Server) registerDBHostAgent(w http.ResponseWriter, r *http.Request) {
	var req models.DBHostRegisterRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.EnrollmentToken == "" {
		http.Error(w, "enrollment_token required", http.StatusBadRequest)
		return
	}
	resp, err := s.store.RegisterDBHostAgent(r.Context(), req)
	if errors.Is(err, store.ErrInvalidEnrollmentToken) {
		http.Error(w, "invalid or expired enrollment token", http.StatusUnauthorized)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// dbHostHeartbeat recibe una muestra del agente y opcionalmente una muestra
// directa de la BD (cuando el agente pollea la BD localmente).
func (s *Server) dbHostHeartbeat(w http.ResponseWriter, r *http.Request) {
	hostAgentID, _ := r.Context().Value(dbHostAgentIDKey{}).(string)
	if hostAgentID == "" {
		writeError(w, http.StatusUnauthorized, "host agent id missing in context")
		return
	}
	var req models.DBHostHeartbeatRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.store.InsertDBHostSample(r.Context(), hostAgentID, req.Sample, req.AgentVersion, req.EngineVersion); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// F6: si el agente envía sample de BD recolectado localmente, lo persistimos
	// como sample del db_target (mismo flujo que el polling remoto). El manager
	// hace skip del polling cuando hay host agent activo, asi que sin esto no
	// llegarian samples DB al historial.
	if req.DBSample != nil {
		targetID, err := s.store.GetTargetIDForHostAgent(r.Context(), hostAgentID)
		if err == nil {
			req.DBSample.TargetID = targetID
			if req.DBSample.CapturedAt.IsZero() {
				req.DBSample.CapturedAt = time.Now()
			}
			if err := s.store.InsertDatabaseSampleFromAgent(r.Context(), *req.DBSample); err != nil {
				// No fallar el heartbeat por esto — solo loguear.
				_ = err
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
