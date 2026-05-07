package store

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
)

func (s *Store) ensureAlertContextSchema(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS alert_process_snapshots (
			alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
			rank INTEGER NOT NULL,
			pid INTEGER NOT NULL,
			name TEXT NOT NULL,
			cpu_percent DOUBLE PRECISION NOT NULL,
			memory_percent DOUBLE PRECISION NOT NULL,
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (alert_id, rank)
		)
	`)
	return err
}

func attachAlertProcessSnapshot(ctx context.Context, tx pgx.Tx, alertID string, processes []models.ProcMetric) error {
	if _, err := tx.Exec(ctx, "DELETE FROM alert_process_snapshots WHERE alert_id = $1", alertID); err != nil {
		return err
	}
	if len(processes) == 0 {
		return nil
	}
	top := append([]models.ProcMetric(nil), processes...)
	sort.Slice(top, func(i, j int) bool {
		left := top[i].CPUPercent + float64(top[i].MemoryPercent)
		right := top[j].CPUPercent + float64(top[j].MemoryPercent)
		return left > right
	})
	if len(top) > 8 {
		top = top[:8]
	}
	for index, proc := range top {
		name := strings.TrimSpace(proc.Name)
		if name == "" {
			name = "unknown"
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO alert_process_snapshots (alert_id, rank, pid, name, cpu_percent, memory_percent)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, alertID, index+1, proc.PID, name, proc.CPUPercent, float64(proc.MemoryPercent)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) alertProcessSnapshot(ctx context.Context, alertID string) ([]models.ProcMetric, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pid, name, cpu_percent, memory_percent
		FROM alert_process_snapshots
		WHERE alert_id = $1
		ORDER BY rank ASC
	`, alertID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanProcessSnapshot(rows)
}

func scanProcessSnapshot(rows pgx.Rows) ([]models.ProcMetric, error) {
	out := []models.ProcMetric{}
	for rows.Next() {
		var proc models.ProcMetric
		var memory float64
		if err := rows.Scan(&proc.PID, &proc.Name, &proc.CPUPercent, &memory); err != nil {
			return nil, err
		}
		proc.MemoryPercent = float32(memory)
		out = append(out, proc)
	}
	return out, rows.Err()
}

func (s *Store) withAlertProcessSnapshots(ctx context.Context, alerts []models.Alert) ([]models.Alert, error) {
	for index := range alerts {
		processes, err := s.alertProcessSnapshot(ctx, alerts[index].ID)
		if err != nil {
			return nil, err
		}
		alerts[index].ProcessSnapshot = processes
	}
	return alerts, nil
}

func processSnapshotText(processes []models.ProcMetric) string {
	if len(processes) == 0 {
		return "Top procesos: sin datos capturados en esa muestra.\n"
	}
	var b strings.Builder
	b.WriteString("\nTop procesos al momento de la alerta:\n")
	b.WriteString("Proceso                         PID        CPU      RAM\n")
	b.WriteString("--------------------------------------------------------\n")
	for _, proc := range processes {
		name := proc.Name
		if len(name) > 28 {
			name = name[:28]
		}
		b.WriteString(fmt.Sprintf("%-30s %-8d %6.1f%% %6.1f%%\n", name, proc.PID, proc.CPUPercent, proc.MemoryPercent))
	}
	return b.String()
}
