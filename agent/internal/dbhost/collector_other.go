//go:build !linux

package dbhost

import (
	"context"

	"resource-monitor/agent/internal/client"
)

func collect(_ context.Context, _ Detected, _ *State, _ string) client.DBHostSample {
	return client.DBHostSample{OK: false, ErrorMessage: "modo db host: solo soportado en Linux"}
}
