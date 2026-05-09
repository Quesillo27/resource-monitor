//go:build windows

package collector

import (
	"context"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// detectServiceStatus consulta el Service Control Manager. Si el servicio no
// existe (o el agente no tiene permisos), devuelve "" para fallback por proc.
func detectServiceStatus(_ context.Context, name string) string {
	m, err := mgr.Connect()
	if err != nil {
		return ""
	}
	defer m.Disconnect()
	s, err := m.OpenService(name)
	if err != nil {
		return ""
	}
	defer s.Close()
	status, err := s.Query()
	if err != nil {
		return ""
	}
	switch status.State {
	case svc.Running, svc.StartPending:
		return "running"
	case svc.Stopped, svc.StopPending:
		return "stopped"
	case svc.Paused, svc.PausePending, svc.ContinuePending:
		return "stopped"
	}
	return ""
}
