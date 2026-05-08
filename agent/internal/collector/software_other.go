//go:build !linux && !windows && !darwin

package collector

func CollectSoftware() []SoftwareItem { return nil }
