package version

// Version is the agent version string. Override at build time with:
//
//	go build -ldflags "-X resource-monitor/agent/internal/version.Version=v1.2.3"
var Version = "dev"
