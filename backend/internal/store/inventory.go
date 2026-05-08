package store

import (
	"context"

	"resource-monitor/backend/internal/models"
)

func (s *Store) EnsureInventorySchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS hardware_snapshots (
			agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
			cpu_model TEXT NOT NULL DEFAULT '',
			cpu_vendor TEXT NOT NULL DEFAULT '',
			cpu_cores_physical INTEGER NOT NULL DEFAULT 0,
			cpu_cores_logical INTEGER NOT NULL DEFAULT 0,
			cpu_mhz DOUBLE PRECISION NOT NULL DEFAULT 0,
			memory_total_gb DOUBLE PRECISION NOT NULL DEFAULT 0,
			kernel_version TEXT NOT NULL DEFAULT '',
			virtualization TEXT NOT NULL DEFAULT '',
			arch TEXT NOT NULL DEFAULT '',
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS software_inventory (
			id BIGSERIAL PRIMARY KEY,
			agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			version TEXT NOT NULL DEFAULT '',
			publisher TEXT NOT NULL DEFAULT '',
			captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`,
		`CREATE INDEX IF NOT EXISTS software_inventory_agent_idx ON software_inventory(agent_id)`,
	}
	for _, stmt := range statements {
		if _, err := s.pool.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) SaveInventory(ctx context.Context, agentID string, inv models.InventoryRequest) error {
	if err := s.EnsureInventorySchema(ctx); err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	h := inv.Hardware
	if _, err := tx.Exec(ctx, `
		INSERT INTO hardware_snapshots (agent_id, cpu_model, cpu_vendor, cpu_cores_physical, cpu_cores_logical, cpu_mhz, memory_total_gb, kernel_version, virtualization, arch, captured_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
		ON CONFLICT (agent_id) DO UPDATE SET
			cpu_model=EXCLUDED.cpu_model, cpu_vendor=EXCLUDED.cpu_vendor,
			cpu_cores_physical=EXCLUDED.cpu_cores_physical, cpu_cores_logical=EXCLUDED.cpu_cores_logical,
			cpu_mhz=EXCLUDED.cpu_mhz, memory_total_gb=EXCLUDED.memory_total_gb,
			kernel_version=EXCLUDED.kernel_version, virtualization=EXCLUDED.virtualization,
			arch=EXCLUDED.arch, captured_at=now()
	`, agentID, h.CPUModel, h.CPUVendor, h.CPUCoresPhys, h.CPUCoresLogical, h.CPUMhz, h.MemoryTotalGB, h.KernelVersion, h.Virtualization, h.Arch); err != nil {
		return err
	}

	if len(inv.Software) > 0 {
		if _, err := tx.Exec(ctx, "DELETE FROM software_inventory WHERE agent_id = $1", agentID); err != nil {
			return err
		}
		for _, sw := range inv.Software {
			if sw.Name == "" {
				continue
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO software_inventory (agent_id, name, version, publisher)
				VALUES ($1,$2,$3,$4)
			`, agentID, sw.Name, sw.Version, sw.Publisher); err != nil {
				return err
			}
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) GetInventory(ctx context.Context, agentID string) (models.InventoryResponse, error) {
	if err := s.EnsureInventorySchema(ctx); err != nil {
		return models.InventoryResponse{}, err
	}
	var resp models.InventoryResponse
	var hw models.HardwareSnapshot
	err := s.pool.QueryRow(ctx, `
		SELECT cpu_model, cpu_vendor, cpu_cores_physical, cpu_cores_logical, cpu_mhz,
		       memory_total_gb, kernel_version, virtualization, arch, captured_at
		FROM hardware_snapshots WHERE agent_id = $1
	`, agentID).Scan(&hw.CPUModel, &hw.CPUVendor, &hw.CPUCoresPhys, &hw.CPUCoresLogical,
		&hw.CPUMhz, &hw.MemoryTotalGB, &hw.KernelVersion, &hw.Virtualization, &hw.Arch, &hw.CapturedAt)
	if err == nil {
		resp.Hardware = &hw
	}

	rows, err := s.pool.Query(ctx, `
		SELECT name, version, publisher FROM software_inventory
		WHERE agent_id = $1 ORDER BY name
	`, agentID)
	if err != nil {
		return resp, err
	}
	defer rows.Close()
	for rows.Next() {
		var sw models.SoftwareItem
		if err := rows.Scan(&sw.Name, &sw.Version, &sw.Publisher); err != nil {
			return resp, err
		}
		resp.Software = append(resp.Software, sw)
	}
	return resp, rows.Err()
}
