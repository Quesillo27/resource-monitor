package config

import (
	"log"
	"net/url"
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
	if adminPass == "" || adminPass == "admin123" || adminPass == "admin" {
		log.Fatal("ADMIN_PASSWORD must be set to a secure value (not empty, 'admin', or 'admin123')")
	}

	dbURL := env("DATABASE_URL", "postgres://monitor:monitor_pass@localhost:5432/resource_monitor?sslmode=disable")
	if u, err := url.Parse(dbURL); err != nil {
		log.Fatalf("DATABASE_URL inválida (no parsea): %v — revisa caracteres especiales en password (encode '%%', '@', '/', ':' como %%25, %%40, %%2F, %%3A)", err)
	} else if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		log.Fatalf("DATABASE_URL inválida: scheme '%s' (esperado 'postgres' o 'postgresql')", u.Scheme)
	} else if u.Host == "" {
		log.Fatal("DATABASE_URL inválida: falta host (formato esperado: postgres://user:pass@host:port/db)")
	}

	origins := strings.Split(env("ALLOWED_ORIGINS", ""), ",")
	var filtered []string
	for _, o := range origins {
		if s := strings.TrimSpace(o); s != "" {
			filtered = append(filtered, s)
		}
	}

	return Config{
		DatabaseURL:         dbURL,
		JWTSecret:           secret,
		AdminUsername:       env("ADMIN_USERNAME", "admin"),
		AdminPassword:       adminPass,
		ServerAddr:          env("SERVER_ADDR", ":8080"),
		RetentionDays:       envInt("RETENTION_DAYS", 30),
		OfflineAfterSeconds: envInt("OFFLINE_AFTER_SECONDS", 180),
		AllowedOrigins:      filtered,
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
