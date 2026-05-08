package collector

import (
	"runtime"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

type HardwareInfo struct {
	CPUModel        string  `json:"cpu_model"`
	CPUVendor       string  `json:"cpu_vendor"`
	CPUCoresPhys    int     `json:"cpu_cores_physical"`
	CPUCoresLogical int     `json:"cpu_cores_logical"`
	CPUMhz          float64 `json:"cpu_mhz"`
	MemoryTotalGB   float64 `json:"memory_total_gb"`
	KernelVersion   string  `json:"kernel_version"`
	Virtualization  string  `json:"virtualization"`
	Arch            string  `json:"arch"`
}

func CollectHardware() HardwareInfo {
	info := HardwareInfo{Arch: runtime.GOARCH}

	if cpuInfos, err := cpu.Info(); err == nil && len(cpuInfos) > 0 {
		info.CPUModel = cpuInfos[0].ModelName
		info.CPUVendor = cpuInfos[0].VendorID
		info.CPUMhz = cpuInfos[0].Mhz
	}
	if logical, err := cpu.Counts(true); err == nil {
		info.CPUCoresLogical = logical
	}
	if physical, err := cpu.Counts(false); err == nil {
		info.CPUCoresPhys = physical
	}
	if hostInfo, err := host.Info(); err == nil {
		info.KernelVersion = hostInfo.KernelVersion
		info.Virtualization = hostInfo.VirtualizationSystem
	}
	if vmStat, err := mem.VirtualMemory(); err == nil {
		info.MemoryTotalGB = float64(vmStat.Total) / (1024 * 1024 * 1024)
	}

	return info
}
