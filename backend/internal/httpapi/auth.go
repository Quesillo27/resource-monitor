package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"resource-monitor/backend/internal/store"

	"github.com/golang-jwt/jwt/v5"
)

type userIDKey struct{}
type usernameKey struct{}
type userRoleKey struct{}
type agentIDKey struct{}

type claims struct {
	UserID   string `json:"uid"`
	Username string `json:"username"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

func (s *Server) issueJWT(user *store.User) (string, error) {
	now := time.Now()
	role, err := s.store.UserRole(context.Background(), user.ID)
	if err != nil {
		return "", err
	}
	if role == "" {
		role = "viewer"
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims{
		UserID:   user.ID,
		Username: user.Username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(12 * time.Hour)),
		},
	})
	return token.SignedString([]byte(s.cfg.JWTSecret))
}

func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearerToken(r)
		if raw == "" {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		parsed, err := jwt.ParseWithClaims(raw, &claims{}, func(token *jwt.Token) (any, error) {
			return []byte(s.cfg.JWTSecret), nil
		}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
		if err != nil || !parsed.Valid {
			writeError(w, http.StatusUnauthorized, "invalid bearer token")
			return
		}
		c, ok := parsed.Claims.(*claims)
		if !ok || c.UserID == "" {
			writeError(w, http.StatusUnauthorized, "invalid bearer token")
			return
		}
		// Revalidar contra DB en cada request: si el usuario fue desactivado
		// o eliminado, UserRole devuelve ErrUnauthorized y el token vigente
		// deja de funcionar antes de que expire.
		freshRole, err := s.store.UserRole(r.Context(), c.UserID)
		if errors.Is(err, store.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "user inactive or removed")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "auth lookup failed")
			return
		}
		role := freshRole
		if role == "" {
			role = c.Role
		}
		if role == "" {
			role = "viewer"
		}
		ctx := context.WithValue(r.Context(), userIDKey{}, c.UserID)
		ctx = context.WithValue(ctx, usernameKey{}, c.Username)
		ctx = context.WithValue(ctx, userRoleKey{}, role)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *Server) requireRole(roles ...string) func(http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, role := range roles {
		allowed[strings.ToLower(role)] = true
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			role, _ := r.Context().Value(userRoleKey{}).(string)
			if !allowed[strings.ToLower(role)] {
				writeError(w, http.StatusForbidden, "insufficient permissions")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) requireAgent(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := bearerToken(r)
		if raw == "" {
			writeError(w, http.StatusUnauthorized, "missing agent credential")
			return
		}
		agentID, err := s.store.AuthenticateAgent(r.Context(), raw)
		if errors.Is(err, store.ErrUnauthorized) {
			writeError(w, http.StatusUnauthorized, "invalid agent credential")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "agent auth failed")
			return
		}
		ctx := context.WithValue(r.Context(), agentIDKey{}, agentID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func bearerToken(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(strings.ToLower(value), "bearer ") {
		return ""
	}
	return strings.TrimSpace(value[7:])
}
