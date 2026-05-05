package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"resource-monitor/backend/internal/config"
	"resource-monitor/backend/internal/models"
	"resource-monitor/backend/internal/store"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type Server struct {
	cfg   config.Config
	store *store.Store
}

func NewServer(cfg config.Config, store *store.Store) *Server {
	return &Server{cfg: cfg, store: store}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(cors)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/login", s.login)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)
			r.Get("/dashboard/summary", s.dashboardSummary)
			r.Get("/agents", s.listAgents)
			r.Get("/agents/{id}", s.agentDetail)
			r.Get("/agents/{id}/status", s.agentStatus)
			r.Post("/enrollment-tokens", s.createEnrollmentToken)
			r.Get("/alerts", s.listAlerts)
		})

		r.Post("/agent/register", s.registerAgent)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAgent)
			r.Post("/agent/heartbeat", s.heartbeat)
			r.Post("/agent/metrics", s.metrics)
		})
	})

	return r
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req models.LoginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.AuthenticateUser(r.Context(), req.Username, req.Password)
	if errors.Is(err, store.ErrUnauthorized) {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}
	token, err := s.issueJWT(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": map[string]string{"id": user.ID, "username": user.Username}})
}

func (s *Server) dashboardSummary(w http.ResponseWriter, r *http.Request) {
	summary, err := s.store.DashboardSummary(r.Context(), s.cfg.OfflineAfterSeconds)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "summary failed")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListAgents(r.Context(), s.cfg.OfflineAfterSeconds, r.URL.Query().Get("q"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agents failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (s *Server) agentDetail(w http.ResponseWriter, r *http.Request) {
	detail, err := s.store.AgentDetail(r.Context(), chi.URLParam(r, "id"), s.cfg.OfflineAfterSeconds)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent detail failed")
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) createEnrollmentToken(w http.ResponseWriter, r *http.Request) {
	var req models.EnrollmentTokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	userID, _ := r.Context().Value(userIDKey{}).(string)
	result, err := s.store.CreateEnrollmentToken(r.Context(), userID, req.Name, req.TTLHours, req.ServerURL, req.AgentName, req.InstallStyle, req.ReleaseVersion)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token creation failed")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) agentStatus(w http.ResponseWriter, r *http.Request) {
	status, err := s.store.AgentStatus(r.Context(), chi.URLParam(r, "id"), s.cfg.OfflineAfterSeconds)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent status failed")
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	activeOnly := strings.ToLower(r.URL.Query().Get("active")) != "false"
	alerts, err := s.store.ListAlerts(r.Context(), activeOnly)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "alerts failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": alerts})
}

func (s *Server) registerAgent(w http.ResponseWriter, r *http.Request) {
	var req models.AgentRegisterRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	result, err := s.store.RegisterAgent(r.Context(), req)
	if errors.Is(err, store.ErrInvalidEnrollmentToken) {
		writeError(w, http.StatusUnauthorized, "invalid, expired, or used enrollment token")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent registration failed")
		return
	}
	writeJSON(w, http.StatusCreated, result)
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request) {
	var req models.HeartbeatRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	if err := s.store.Heartbeat(r.Context(), agentID, req); err != nil {
		writeError(w, http.StatusInternalServerError, "heartbeat failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	var req models.MetricsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	if err := s.store.InsertMetrics(r.Context(), agentID, req); err != nil {
		writeError(w, http.StatusInternalServerError, "metrics failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "accepted"})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
