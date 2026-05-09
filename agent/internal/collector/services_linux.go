//go:build linux

package collector

import (
	"context"
	"os/exec"
	"strings"
)

// detectServiceStatus consulta systemctl para Linux. Si no hay systemd o el
// servicio no existe, devuelve "" para que el caller use el fallback por
// nombre de proceso.
func detectServiceStatus(ctx context.Context, name string) string {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return ""
	}
	out, _ := exec.CommandContext(ctx, "systemctl", "is-active", name).Output()
	state := strings.TrimSpace(string(out))
	switch state {
	case "active":
		return "running"
	case "activating", "reloading":
		return "running"
	case "failed":
		return "failed"
	case "inactive", "deactivating":
		return "stopped"
	}
	return ""
}
