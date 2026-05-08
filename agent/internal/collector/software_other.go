//go:build !linux && !windows

package collector

func CollectSoftware() []SoftwareItem { return nil }
