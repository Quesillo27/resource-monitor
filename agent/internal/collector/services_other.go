//go:build !linux && !windows

package collector

import "context"

func detectServiceStatus(_ context.Context, _ string) string { return "" }
