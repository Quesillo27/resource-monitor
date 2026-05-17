//go:build !linux

package dbhost

import (
	"context"

	"resource-monitor/agent/internal/client"
)

func collectPostgresLocal(_ context.Context, _ string) *client.DatabaseSample {
	return nil
}
