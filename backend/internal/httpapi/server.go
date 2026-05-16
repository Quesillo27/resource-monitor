package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"resource-monitor/backend/internal/config"
	"resource-monitor/backend/internal/models"
	"resource-monitor/backend/internal/store"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// versionFilePath es donde agent-assets escribe la versión activa tras compilar.
// Lo monta el compose como volumen read-only (agent-downloads).
const versionFilePath = "/downloads/version.txt"

// currentLatestVersion devuelve la versión actualmente publicada en /downloads/.
// Lo escribe agent-assets en cada build (formato vX.Y.Z-<sha> derivado de git
// describe). Si no existe el archivo (arranque inicial antes del primer build),
// devuelve "unknown".
func (s *Server) currentLatestVersion() string {
	if data, err := os.ReadFile(versionFilePath); err == nil {
		if v := strings.TrimSpace(string(data)); v != "" {
			return v
		}
	}
	return "unknown"
}

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
	r.Use(middleware.Compress(5))
	r.Use(s.cors)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/api/agent/version", s.agentVersion)

	// Sirve los binarios del agente y checksums.txt desde el volumen
	// agent-downloads (montado en /downloads). Esto permite que los agentes
	// apunten directamente al backend para self-update sin pasar por el
	// frontend nginx.
	downloadsFS := http.FileServer(http.Dir("/downloads"))
	r.Get("/downloads/*", http.StripPrefix("/downloads/", downloadsFS).ServeHTTP)
	// Script de instalacion del agente en modo --mode=db (one-shot via curl|bash).
	r.Get("/install-db-agent.sh", s.installDBAgentScript)

	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/login", s.login)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)
			r.Get("/dashboard/summary", s.dashboardSummary)
			r.Get("/dashboard/overview", s.dashboardOverview)
			r.Get("/agents", s.listAgents)
			r.Get("/tags", s.listTags)
			r.Get("/agents/{id}", s.agentDetail)
			r.Get("/agents/{id}/history", s.agentHistory)
			r.Get("/agents/{id}/networks", s.agentNetworks)
			r.With(s.requireRole("admin", "operator")).Post("/agents/{id}/networks/reconcile", s.reconcileAgentNetworks)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/networks/hide", s.hideAgentNetwork)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/networks/restore", s.restoreAgentNetwork)
			r.Get("/agents/{id}/status", s.agentStatus)
			r.Get("/agents/{id}/alert-rules", s.agentAlertRules)
			r.Get("/alerts", s.listAlerts)
			r.Get("/alerts/stats", s.alertStats)
			r.Post("/alerts/seen-all", s.markAllAlertsSeen)
			r.Post("/alerts/{id}/seen", s.markAlertSeen)
			r.Get("/alert-rules/defaults", s.defaultAlertRules)

			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/alert-rules", s.saveAgentAlertRules)
			r.With(s.requireRole("admin", "operator")).Post("/agents/{id}/alert-rules/reset", s.resetAgentAlertRules)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/custom-rules-enabled", s.setAgentCustomRulesEnabled)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/interval", s.setAgentInterval)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/profile", s.setAgentProfile)
			r.Get("/agents/{id}/services-config", s.getAgentServices)
			r.With(s.requireRole("admin", "operator")).Put("/agents/{id}/services-config", s.setAgentServices)
			r.With(s.requireRole("admin", "operator")).Patch("/agents/{id}", s.updateAgent)
			r.With(s.requireRole("admin", "operator")).Delete("/agents/{id}", s.deleteAgent)
			r.With(s.requireRole("admin", "operator")).Post("/enrollment-tokens", s.createEnrollmentToken)
			r.Get("/agents/{id}/inventory", s.getAgentInventory)
			r.With(s.requireRole("admin", "operator")).Post("/agents/{id}/commands", s.enqueueAgentCommand)
			r.Get("/agents/{id}/commands", s.listAgentCommands)

			r.With(s.requireRole("admin")).Put("/alert-rules/defaults", s.saveDefaultAlertRules)
			r.With(s.requireRole("admin")).Get("/alert-settings/smtp", s.getSMTPSettings)
			r.With(s.requireRole("admin")).Put("/alert-settings/smtp", s.saveSMTPSettings)
			r.With(s.requireRole("admin")).Post("/alert-settings/smtp/test", s.testSMTPSettings)
			r.With(s.requireRole("admin")).Get("/settings/smtp", s.getSMTPSettings)
			r.With(s.requireRole("admin")).Put("/settings/smtp", s.saveSMTPSettings)
			r.With(s.requireRole("admin")).Post("/settings/smtp/test", s.testSMTPSettings)
			r.With(s.requireRole("admin")).Get("/settings/telegram", s.getTelegramSettings)
			r.With(s.requireRole("admin")).Put("/settings/telegram", s.saveTelegramSettings)
			r.With(s.requireRole("admin")).Post("/settings/telegram/test", s.testTelegramSettings)
			r.With(s.requireRole("admin")).Get("/users", s.listUsers)
			r.With(s.requireRole("admin")).Post("/users", s.createUser)
			r.With(s.requireRole("admin")).Patch("/users/{id}", s.updateUser)
			r.With(s.requireRole("admin")).Post("/users/{id}/password", s.updateUserPassword)
			r.With(s.requireRole("admin")).Delete("/users/{id}", s.deleteUser)

			// Self-update del manager: cualquier usuario admin puede consultar el
			// estado, pero solo admin puede disparar el update. El handler escribe
			// un archivo trigger en un volumen compartido con el container
			// manager-updater (que ejecuta git pull + docker compose build/up).
			r.With(s.requireRole("admin")).Get("/manager/version", s.managerVersion)
			r.With(s.requireRole("admin")).Get("/manager/update/status", s.managerUpdateStatus)
			r.With(s.requireRole("admin")).Post("/manager/update", s.managerUpdateTrigger)

			// Database monitoring
			r.Get("/db-targets", s.listDBTargets)
			r.With(s.requireRole("admin", "operator")).Post("/db-targets", s.createDBTarget)
			r.With(s.requireRole("admin", "operator")).Put("/db-targets/{id}", s.updateDBTarget)
			r.With(s.requireRole("admin", "operator")).Delete("/db-targets/{id}", s.deleteDBTarget)
			r.Get("/db-targets/{id}/metrics", s.getDBMetrics)
			r.Get("/db-targets/{id}/info", s.getDBLiveInfo)
			r.Get("/db-targets/{id}/active-queries", s.getDBActiveQueries)
			r.Get("/db-targets/{id}/table-sizes", s.getDBTableSizes)
			r.With(s.requireRole("admin", "operator")).Post("/db-targets/test", s.testDBConnection)
			r.Get("/db-targets/{id}/vacuum-stats", s.getDBVacuumStats)
			r.Get("/db-targets/{id}/index-usage", s.getDBIndexUsage)
			r.Get("/db-targets/{id}/slow-queries", s.getDBSlowQueries)
			r.Get("/db-targets/{id}/redis-live", s.getDBRedisLive)
			r.Get("/db-targets/{id}/redis-slowlog", s.getDBRedisSlowlog)
			r.Get("/db-targets/{id}/redis-clients", s.getDBRedisClients)
			r.Get("/db-targets/{id}/redis-memory", s.getDBRedisMemoryStats)
			r.Get("/db-targets/{id}/insights", s.getDBInsights)
			r.Get("/db-targets/{id}/blocking-locks", s.getDBBlockingLocks)
			r.Get("/db-targets/{id}/table-io", s.getDBTableIO)
			r.Get("/db-targets/{id}/pg-settings", s.getDBSettings)
			r.Get("/db-targets/{id}/autovacuum", s.getDBAutovacuum)
			r.Get("/db-targets/{id}/replication", s.getDBReplication)
			r.With(s.requireRole("admin", "operator")).Post("/db-targets/poll", s.pollDBTarget)

			// Host agent vinculado al db_target (Fase 1).
			r.Get("/db-targets/{id}/host", s.getDBHostAgent)
			r.With(s.requireRole("admin", "operator")).Post("/db-targets/{id}/host-tokens", s.createDBHostToken)
			r.With(s.requireRole("admin", "operator")).Delete("/db-targets/{id}/host", s.deleteDBHostAgent)
		})

		r.Post("/agent/register", s.registerAgent)
		r.Post("/db-host/register", s.registerDBHostAgent)
		r.Group(func(r chi.Router) {
			r.Use(s.requireAgent)
			r.Post("/agent/heartbeat", s.heartbeat)
			r.Post("/agent/metrics", s.metrics)
			r.Post("/agent/inventory", s.agentInventory)
			r.Post("/agent/offline", s.agentOfflineNotice)
			r.Post("/agent/commands/{id}/result", s.agentCommandResult)
		})
		r.Group(func(r chi.Router) {
			r.Use(s.requireDBHostAgent)
			r.Post("/db-host/heartbeat", s.dbHostHeartbeat)
		})
	})

	return r
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var req models.LoginRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.AuthenticateUserV32(r.Context(), req.Username, req.Password)
	if errors.Is(err, store.ErrUnauthorized) {
		writeError(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "login failed")
		return
	}
	role, _ := s.store.UserRole(r.Context(), user.ID)
	token, err := s.issueJWT(user)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "token failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": map[string]string{"id": user.ID, "username": user.Username, "role": role}})
}

func (s *Server) dashboardSummary(w http.ResponseWriter, r *http.Request) {
	summary, err := s.store.DashboardSummary(r.Context(), s.cfg.OfflineAfterSeconds)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "summary failed")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) dashboardOverview(w http.ResponseWriter, r *http.Request) {
	overview, err := s.store.DashboardOverview(r.Context(), s.cfg.OfflineAfterSeconds)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "overview failed")
		return
	}
	if alerts, err := s.store.ListAlertNotifications(r.Context(), "false", "all"); err == nil {
		if len(alerts) > 8 {
			alerts = alerts[:8]
		}
		overview["recent_alerts"] = alerts
		overview["alert_center"] = alerts
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *Server) listAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListAgents(r.Context(), s.cfg.OfflineAfterSeconds, r.URL.Query().Get("q"), r.URL.Query().Get("tag"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agents failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents})
}

func (s *Server) listTags(w http.ResponseWriter, r *http.Request) {
	tags, err := s.store.ListAllTags(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "tags failed")
		return
	}
	if tags == nil {
		tags = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags})
}

func (s *Server) agentDetail(w http.ResponseWriter, r *http.Request) {
	detail, err := s.store.AgentDetailNotifications(r.Context(), chi.URLParam(r, "id"), s.cfg.OfflineAfterSeconds)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent detail failed")
		return
	}
	writeJSONWithETag(w, r, http.StatusOK, detail)
}

func (s *Server) agentHistory(w http.ResponseWriter, r *http.Request) {
	rangeName := r.URL.Query().Get("range")
	if rangeName == "" {
		rangeName = "24h"
	}
	history, err := s.store.AgentHistoryRates(r.Context(), chi.URLParam(r, "id"), rangeName)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent history failed")
		return
	}
	writeJSONWithETag(w, r, http.StatusOK, history)
}

func (s *Server) agentNetworks(w http.ResponseWriter, r *http.Request) {
	includeInactive := strings.EqualFold(r.URL.Query().Get("include_inactive"), "true")
	networks, err := s.store.AgentNetworks(r.Context(), chi.URLParam(r, "id"), includeInactive)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent networks failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"networks": networks})
}

func (s *Server) reconcileAgentNetworks(w http.ResponseWriter, r *http.Request) {
	result, err := s.store.ReconcileAgentNetworks(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "network reconcile failed")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getAgentServices(w http.ResponseWriter, r *http.Request) {
	checks, err := s.store.GetAgentServiceChecks(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get services failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"services": checks})
}

func (s *Server) setAgentServices(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Services []string `json:"services"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	cleaned, err := s.store.SetAgentServiceChecks(r.Context(), chi.URLParam(r, "id"), req.Services)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "save services failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"services": cleaned})
}

func (s *Server) hideAgentNetwork(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := s.store.HideAgentNetwork(r.Context(), chi.URLParam(r, "id"), req.Name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "hide network failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) restoreAgentNetwork(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if err := s.store.RestoreAgentNetwork(r.Context(), chi.URLParam(r, "id"), req.Name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "restore network failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (s *Server) updateAgent(w http.ResponseWriter, r *http.Request) {
	var req models.AgentUpdateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID := chi.URLParam(r, "id")
	if req.Name != "" {
		err := s.store.UpdateAgentName(r.Context(), agentID, req.Name)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if req.Tags != nil {
		if err := s.store.UpdateAgentTags(r.Context(), agentID, *req.Tags); err != nil {
			writeError(w, http.StatusInternalServerError, "tags update failed")
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) deleteAgent(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteAgent(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "delete agent failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) createEnrollmentToken(w http.ResponseWriter, r *http.Request) {
	var req models.EnrollmentTokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	userID, _ := r.Context().Value(userIDKey{}).(string)
	result, err := s.store.CreateEnrollmentTokenAdvanced(r.Context(), userID, req.Name, req.TTLHours, req.ServerURL, req.DownloadURL, req.AgentName, req.InstallStyle, req.ReleaseVersion, req.Profile, req.Services, req.Interval)
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
	writeJSONWithETag(w, r, http.StatusOK, status)
}

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	seen := strings.ToLower(r.URL.Query().Get("seen"))
	if seen == "" {
		seen = "false"
	}
	active := strings.ToLower(r.URL.Query().Get("active"))
	if active == "" {
		active = "all"
	}
	alerts, err := s.store.ListAlertNotifications(r.Context(), seen, active)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "alerts failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"alerts": alerts})
}

func (s *Server) alertStats(w http.ResponseWriter, r *http.Request) {
	stats, err := s.store.AlertStats(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "alert stats failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stats": stats})
}

func (s *Server) markAlertSeen(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(userIDKey{}).(string)
	username, _ := r.Context().Value(usernameKey{}).(string)
	if err := s.store.MarkAlertSeen(r.Context(), chi.URLParam(r, "id"), userID, username); errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "alert not found")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, "mark alert seen failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) markAllAlertsSeen(w http.ResponseWriter, r *http.Request) {
	userID, _ := r.Context().Value(userIDKey{}).(string)
	username, _ := r.Context().Value(usernameKey{}).(string)
	count, err := s.store.MarkAllAlertsSeen(r.Context(), userID, username)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "mark all alerts seen failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "updated": count})
}

func (s *Server) defaultAlertRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.store.ListDefaultAlertRules(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "alert rules failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

func (s *Server) saveDefaultAlertRules(w http.ResponseWriter, r *http.Request) {
	var req models.AlertRulesRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	rules, err := s.store.SaveDefaultAlertRules(r.Context(), req.Rules)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

func (s *Server) agentAlertRules(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	rules, err := s.store.ListAgentAlertRules(r.Context(), agentID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent rules failed")
		return
	}
	customEnabled, _ := s.store.GetAgentCustomRulesEnabled(r.Context(), agentID)
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules, "custom_rules_enabled": customEnabled})
}

func (s *Server) setAgentCustomRulesEnabled(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Enabled bool `json:"enabled"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID := chi.URLParam(r, "id")
	if err := s.store.SetAgentCustomRulesEnabled(r.Context(), agentID, req.Enabled); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "toggle failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"custom_rules_enabled": req.Enabled})
}

func (s *Server) setAgentInterval(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Seconds int `json:"seconds"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID := chi.URLParam(r, "id")
	if err := s.store.SetAgentIntervalSeconds(r.Context(), agentID, req.Seconds); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"interval_seconds": req.Seconds})
}

func (s *Server) setAgentProfile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Profile string `json:"profile"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID := chi.URLParam(r, "id")
	if err := s.store.SetAgentProfile(r.Context(), agentID, req.Profile); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "agent not found")
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profile": req.Profile})
}

func (s *Server) saveAgentAlertRules(w http.ResponseWriter, r *http.Request) {
	var req models.AlertRulesRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	rules, err := s.store.SaveAgentAlertRules(r.Context(), chi.URLParam(r, "id"), req.Rules)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rules": rules})
}

func (s *Server) resetAgentAlertRules(w http.ResponseWriter, r *http.Request) {
	err := s.store.ResetAgentAlertRules(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "reset rules failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
}

func (s *Server) getSMTPSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetSMTPSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "smtp settings failed")
		return
	}
	settings.Password = ""
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) saveSMTPSettings(w http.ResponseWriter, r *http.Request) {
	var req models.SMTPSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Password == "" {
		current, err := s.store.GetSMTPSettings(r.Context())
		if err == nil {
			req.Password = current.Password
		}
	}
	settings, err := s.store.SaveSMTPSettings(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "smtp save failed")
		return
	}
	settings.Password = ""
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) testSMTPSettings(w http.ResponseWriter, r *http.Request) {
	var req models.SMTPSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.TestSMTPSettings(r.Context(), req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Server) getTelegramSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.store.GetTelegramSettings(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "telegram settings failed")
		return
	}
	settings.BotToken = ""
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) saveTelegramSettings(w http.ResponseWriter, r *http.Request) {
	var req models.TelegramSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.BotToken == "" {
		current, err := s.store.GetTelegramSettings(r.Context())
		if err == nil {
			req.BotToken = current.BotToken
		}
	}
	settings, err := s.store.SaveTelegramSettings(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "telegram save failed")
		return
	}
	settings.BotToken = ""
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) testTelegramSettings(w http.ResponseWriter, r *http.Request) {
	var req models.TelegramSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.store.TestTelegramSettings(r.Context(), req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "users failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var req models.UserCreateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.CreateUser(r.Context(), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	var req models.UserUpdateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.store.UpdateUser(r.Context(), chi.URLParam(r, "id"), req)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) updateUserPassword(w http.ResponseWriter, r *http.Request) {
	var req models.UserPasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	err := s.store.UpdateUserPassword(r.Context(), chi.URLParam(r, "id"), req.Password)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	err := s.store.DeleteUser(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
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
	if req.AgentVersion != "" {
		_ = s.store.UpdateAgentVersion(r.Context(), agentID, req.AgentVersion)
	}
	commands, _ := s.store.PendingCommandsForAgent(r.Context(), agentID)
	intervalSeconds, _ := s.store.GetAgentIntervalSeconds(r.Context(), agentID)
	serviceChecks, _ := s.store.GetAgentServiceChecks(r.Context(), agentID)
	profile, _ := s.store.GetAgentProfile(r.Context(), agentID)
	// Si la DB no tiene servicios configurados pero el agente reporta los
	// suyos locales (instalo con --services), hacer seed para que aparezcan
	// en la UI y puedan editarse despues.
	if len(serviceChecks) == 0 && len(req.LocalServiceNames) > 0 {
		if cleaned, err := s.store.SetAgentServiceChecks(r.Context(), agentID, req.LocalServiceNames); err == nil {
			serviceChecks = cleaned
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":           "ok",
		"commands":         commands,
		"interval_seconds": intervalSeconds,
		"service_checks":   serviceChecks,
		"profile":          profile,
	})
}

func (s *Server) agentCommandResult(w http.ResponseWriter, r *http.Request) {
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	commandID := chi.URLParam(r, "id")
	var req struct {
		OK     bool           `json:"ok"`
		Result map[string]any `json:"result"`
		Error  string         `json:"error"`
	}
	_ = decodeJSON(w, r, &req)
	if err := s.store.CompleteAgentCommand(r.Context(), agentID, commandID, req.OK, req.Result, req.Error); err != nil {
		writeError(w, http.StatusInternalServerError, "result save failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
}

// enqueueAgentCommand permite al admin disparar un comando remoto a un agente
// (update, restart, reload-config, etc).
func (s *Server) enqueueAgentCommand(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	var req struct {
		Command string         `json:"command"`
		Params  map[string]any `json:"params"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	row, err := s.store.EnqueueAgentCommand(r.Context(), agentID, req.Command, req.Params)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, row)
}

func (s *Server) listAgentCommands(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "id")
	rows, err := s.store.ListAgentCommands(r.Context(), agentID, 30)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list commands failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"commands": rows})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	var req models.MetricsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	if err := s.store.InsertMetricsV31(r.Context(), agentID, req); err != nil {
		writeError(w, http.StatusInternalServerError, "metrics failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "accepted"})
}

func (s *Server) agentInventory(w http.ResponseWriter, r *http.Request) {
	var req models.InventoryRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	if err := s.store.SaveInventory(r.Context(), agentID, req); err != nil {
		writeError(w, http.StatusInternalServerError, "inventory save failed")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "accepted"})
}

// agentOfflineNotice marca un agente como offline inmediatamente cuando
// avisa shutdown limpio (en lugar de esperar OFFLINE_AFTER_SECONDS).
func (s *Server) agentOfflineNotice(w http.ResponseWriter, r *http.Request) {
	agentID, _ := r.Context().Value(agentIDKey{}).(string)
	var req struct {
		Reason string `json:"reason"`
	}
	_ = decodeJSON(w, r, &req)
	if err := s.store.MarkAgentOffline(r.Context(), agentID, req.Reason); err != nil {
		writeError(w, http.StatusInternalServerError, "offline notice failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "offline"})
}

func (s *Server) getAgentInventory(w http.ResponseWriter, r *http.Request) {
	inv, err := s.store.GetInventory(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "inventory fetch failed")
		return
	}
	writeJSONWithETag(w, r, http.StatusOK, inv)
}

func (s *Server) agentVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"version": s.currentLatestVersion(),
	})
}

// Volumen compartido con el container manager-updater. El backend escribe el
// trigger y lee el status; el updater procesa el trigger fuera del proceso.
const (
	managerTriggerPath     = "/triggers/update.requested"
	managerStatusPath      = "/triggers/status.json"
	managerVersionInfoPath = "/triggers/version-info.json"
)

func (s *Server) managerVersion(w http.ResponseWriter, r *http.Request) {
	// "current" = sha del binario que está corriendo (inyectado en build).
	// "latest" = sha del HEAD del repo remoto (lo escribe el manager-updater).
	// Si el binario no fue buildeado con MANAGER_BUILD_SHA (legacy), reporta
	// "unknown"; el frontend tratará eso como "puede haber update".
	current := s.cfg.ManagerBuildSHA
	if current == "" {
		current = "unknown"
	}
	// "version" (vX.Y.Z-<sha>) lo escribe manager-updater en version-info.json
	// derivado de git describe --tags. Si el archivo no existe todavía (primer
	// arranque), reporta "unknown".
	out := map[string]any{
		"version":          "unknown",
		"current":          current,
		"latest":           "unknown",
		"update_available": false,
	}
	if data, err := os.ReadFile(managerVersionInfoPath); err == nil {
		var info map[string]any
		if json.Unmarshal(data, &info) == nil {
			if v, ok := info["version"].(string); ok && v != "" {
				out["version"] = v
			}
			if v, ok := info["latest"].(string); ok {
				out["latest"] = v
			}
			if v, ok := info["behind"]; ok {
				out["behind"] = v
			}
			if v, ok := info["checked_at"]; ok {
				out["checked_at"] = v
			}
			// update_available real: comparar el sha buildeado del backend
			// contra el HEAD remoto. Si current==unknown, asumir que sí hay
			// update (forza a mostrar el botón para romper deadlocks).
			if latest, ok := info["latest"].(string); ok && latest != "unknown" {
				out["update_available"] = current == "unknown" || current != latest
			}
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) managerUpdateStatus(w http.ResponseWriter, r *http.Request) {
	data, err := os.ReadFile(managerStatusPath)
	if err != nil {
		// Si no existe aún, devolver estado idle por defecto en vez de 500.
		writeJSON(w, http.StatusOK, map[string]any{"state": "idle"})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) managerUpdateTrigger(w http.ResponseWriter, r *http.Request) {
	// Si ya hay un update activo, no duplicar.
	if data, err := os.ReadFile(managerStatusPath); err == nil {
		var st struct {
			State string `json:"state"`
		}
		if json.Unmarshal(data, &st) == nil {
			switch st.State {
			case "pulling", "building_backend", "building_frontend", "restarting":
				writeError(w, http.StatusConflict, "update already in progress")
				return
			}
		}
	}
	if err := os.WriteFile(managerTriggerPath, []byte("requested"), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write trigger: "+err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued"})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB
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

// writeJSONWithETag serializa el payload, calcula un ETag (sha256[:8] hex) y
// devuelve 304 si el cliente envía If-None-Match coincidente. Útil en endpoints
// de polling que devuelven datos frecuentemente sin cambios.
func writeJSONWithETag(w http.ResponseWriter, r *http.Request, status int, payload any) {
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(payload); err != nil {
		writeError(w, http.StatusInternalServerError, "encode failed")
		return
	}
	sum := sha256.Sum256(buf.Bytes())
	etag := `"` + hex.EncodeToString(sum[:8]) + `"`
	w.Header().Set("ETag", etag)
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		allowed := false
		if len(s.cfg.AllowedOrigins) == 0 {
			allowed = true
		} else {
			for _, o := range s.cfg.AllowedOrigins {
				if strings.EqualFold(o, origin) {
					allowed = true
					break
				}
			}
		}
		if allowed && origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache, private")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
