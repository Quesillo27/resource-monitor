package config

import (
	"os"
	"strconv"
)

type Config struct {
	DatabaseURL         string
	JWTSecret           string
	AdminUsername       string
	AdminPassword       string
	ServerAddr          string
	RetentionDays       int
	OfflineAfterSeconds int
}

func Load() Config {
	return Config{
		DatabaseURL:         env("DATABASE_URL", "postgres://monitor:monitor_pass@localhost:5432/resource_monitor?sslmode=disable"),
		JWTSecret:           env("JWT_SECRET", "dev-secret-change-me"),
		AdminUsername:       env("ADMIN_USERNAME", "admin"),
		AdminPassword:       env("ADMIN_PASSWORD", "admin123"),
		ServerAddr:          env("SERVER_ADDR", ":8080"),
		RetentionDays:       envInt("RETENTION_DAYS", 30),
		OfflineAfterSeconds: envInt("OFFLINE_AFTER_SECONDS", 180),
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
