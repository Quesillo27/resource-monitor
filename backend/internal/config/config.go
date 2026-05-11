package config

import (
	"log"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabaseURL          string
	JWTSecret            string
	AdminUsername        string
	AdminPassword        string
	ServerAddr           string
	RetentionDays        int
	OfflineAfterSeconds  int
	AllowedOrigins       []string
	AgentReleaseVersion  string
	ManagerVersion       string
	ManagerBuildSHA      string
}

func Load() Config {
	secret := env("JWT_SECRET", "")
	adminPass := env("ADMIN_PASSWORD", "")

	if secret == "" || secret == "dev-secret-change-me" {
		log.Fatal("JWT_SECRET must be set to a secure random value (not empty or default)")
	}
	if len(secret) < 32 {
		log.Fatal("JWT_SECRET must be at least 32 characters")
	}
	if adminPass == "" || adminPass == "admin123" {
		log.Fatal("ADMIN_PASSWORD must be set to a secure value (not empty or default)")
	}

	origins := strings.Split(env("ALLOWED_ORIGINS", ""), ",")
	var filtered []string
	for _, o := range origins {
		if s := strings.TrimSpace(o); s != "" {
			filtered = append(filtered, s)
		}
	}

	return Config{
		DatabaseURL:         env("DATABASE_URL", "postgres://monitor:monitor_pass@localhost:5432/resource_monitor?sslmode=disable"),
		JWTSecret:           secret,
		AdminUsername:       env("ADMIN_USERNAME", "admin"),
		AdminPassword:       adminPass,
		ServerAddr:          env("SERVER_ADDR", ":8080"),
		RetentionDays:       envInt("RETENTION_DAYS", 30),
		OfflineAfterSeconds: envInt("OFFLINE_AFTER_SECONDS", 180),
		AllowedOrigins:      filtered,
		AgentReleaseVersion: env("AGENT_RELEASE_VERSION", "dev"),
		ManagerVersion:      env("MANAGER_VERSION", "dev"),
		ManagerBuildSHA:     env("MANAGER_BUILD_SHA", ""),
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
