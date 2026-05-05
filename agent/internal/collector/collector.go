package collector

import (
	"context"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
)

type Host struct {
	Name          string `json:"name"`
	Hostname      string `json:"hostname"`
	OS            string `json:"os"`
	Arch          string `json:"arch"`
	UptimeSeconds uint64 `json:"uptime_seconds"`
}

type Metrics struct {
	CPUPercent        float64      `json:"cpu_percent"`
	MemoryTotalBytes  uint64       `json:"memory_total_bytes"`
	MemoryUsedBytes   uint64       `json:"memory_used_bytes"`
	MemoryUsedPercent float64      `json:"memory_used_percent"`
	Disks             []DiskMetric `json:"disks"`
}

type DiskMetric struct {
	Name        string  `json:"name"`
	Mountpoint  string  `json:"mountpoint"`
	Filesystem  string  `json:"filesystem"`
	TotalBytes  uint64  `json:"total_bytes"`
	UsedBytes   uint64  `json:"used_bytes"`
	FreeBytes   uint64  `json:"free_bytes"`
	UsedPercent float64 `json:"used_percent"`
}

func HostInfo() (Host, error) {
	info, err := host.Info()
	if err != nil {
		return Host{}, err
	}
	return Host{
		Name:          info.Hostname,
		Hostname:      info.Hostname,
		OS:            info.Platform + " " + info.PlatformVersion,
		Arch:          runtime.GOARCH,
		UptimeSeconds: info.Uptime,
	}, nil
}

func Collect(ctx context.Context) (Metrics, error) {
	cpuValues, err := cpu.PercentWithContext(ctx, time.Second, false)
	if err != nil {
		return Metrics{}, err
	}
	memory, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return Metrics{}, err
	}
	disks, err := collectDisks(ctx)
	if err != nil {
		return Metrics{}, err
	}

	cpuPercent := 0.0
	if len(cpuValues) > 0 {
		cpuPercent = cpuValues[0]
	}
	return Metrics{
		CPUPercent:        cpuPercent,
		MemoryTotalBytes:  memory.Total,
		MemoryUsedBytes:   memory.Used,
		MemoryUsedPercent: memory.UsedPercent,
		Disks:             disks,
	}, nil
}

func collectDisks(ctx context.Context) ([]DiskMetric, error) {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil, err
	}
	result := []DiskMetric{}
	seen := map[string]bool{}
	for _, partition := range partitions {
		key := partition.Mountpoint
		if seen[key] {
			continue
		}
		seen[key] = true
		usage, err := disk.UsageWithContext(ctx, partition.Mountpoint)
		if err != nil {
			continue
		}
		result = append(result, DiskMetric{
			Name:        partition.Device,
			Mountpoint:  partition.Mountpoint,
			Filesystem:  partition.Fstype,
			TotalBytes:  usage.Total,
			UsedBytes:   usage.Used,
			FreeBytes:   usage.Free,
			UsedPercent: usage.UsedPercent,
		})
	}
	return result, nil
}
