package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"resource-monitor/backend/internal/config"
	"resource-monitor/backend/internal/httpapi"
	"resource-monitor/backend/internal/store"
)

func main() {
	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer db.Close()

	if err := db.EnsureAdmin(ctx, cfg.AdminUsername, cfg.AdminPassword); err != nil {
		log.Fatalf("ensure admin: %v", err)
	}

	api := httpapi.NewServer(cfg, db)
	go runRetention(ctx, db, cfg.RetentionDays)
	go runOfflineAlerts(ctx, db, cfg.OfflineAfterSeconds)
	go runAlertDispatcher(ctx, db)
	go runDBMonitor(ctx, db)

	srv := &http.Server{
		Addr:              cfg.ServerAddr,
		Handler:           api.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("resource monitor backend listening on %s", cfg.ServerAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func runRetention(ctx context.Context, db *store.Store, days int) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		if err := db.DeleteOldMetrics(ctx, days); err != nil {
			log.Printf("retention cleanup: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runOfflineAlerts(ctx context.Context, db *store.Store, offlineAfterSeconds int) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		if err := db.EvaluateOfflineAlerts(ctx, offlineAfterSeconds); err != nil {
			log.Printf("offline alert evaluation: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runAlertDispatcher(ctx context.Context, db *store.Store) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		if err := db.NotifyDueAlertsV31(ctx); err != nil {
			log.Printf("alert dispatch: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runDBMonitor(ctx context.Context, db *store.Store) {
	// Espera breve para que el pool de pgx se caliente antes del primer poll.
	select {
	case <-ctx.Done():
		return
	case <-time.After(10 * time.Second):
	}
	db.PollAllDatabaseTargets(ctx)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			db.PollAllDatabaseTargets(ctx)
		}
	}
}
