package collector

import (
	"context"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
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
	SwapTotalBytes    uint64       `json:"swap_total_bytes,omitempty"`
	SwapUsedBytes     uint64       `json:"swap_used_bytes,omitempty"`
	SwapUsedPercent   float64      `json:"swap_used_percent,omitempty"`
	Disks             []DiskMetric `json:"disks"`
	Networks          []NetMetric  `json:"networks,omitempty"`
	Processes         []ProcMetric `json:"processes,omitempty"`
	Services          []SvcMetric  `json:"services,omitempty"`
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

type NetMetric struct {
	Name      string `json:"name"`
	BytesSent uint64 `json:"bytes_sent"`
	BytesRecv uint64 `json:"bytes_recv"`
	Up        bool   `json:"up"`
}

type ProcMetric struct {
	PID           int32   `json:"pid"`
	Name          string  `json:"name"`
	CPUPercent    float64 `json:"cpu_percent"`
	MemoryPercent float32 `json:"memory_percent"`
}

type SvcMetric struct {
	Name   string `json:"name"`
	Status string `json:"status"`
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

func Collect(ctx context.Context, profile string, serviceChecks []string) (Metrics, error) {
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
	swap, _ := mem.SwapMemoryWithContext(ctx)
	var swapTotal, swapUsed uint64
	var swapPercent float64
	if swap != nil {
		swapTotal = swap.Total
		swapUsed = swap.Used
		swapPercent = swap.UsedPercent
	}

	cpuPercent := 0.0
	if len(cpuValues) > 0 {
		cpuPercent = cpuValues[0]
	}
	metrics := Metrics{
		CPUPercent:        cpuPercent,
		MemoryTotalBytes:  memory.Total,
		MemoryUsedBytes:   memory.Used,
		MemoryUsedPercent: memory.UsedPercent,
		SwapTotalBytes:    swapTotal,
		SwapUsedBytes:     swapUsed,
		SwapUsedPercent:   swapPercent,
		Disks:             disks,
	}
	if profile == "" || profile == "balanced" {
		metrics.Networks = collectNetworks(ctx)
		metrics.Processes = collectTopProcesses(ctx, 5)
		metrics.Services = collectServices(ctx, serviceChecks)
	}
	return metrics, nil
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

func collectNetworks(ctx context.Context) []NetMetric {
	counters, err := gnet.IOCountersWithContext(ctx, true)
	if err != nil {
		return nil
	}
	interfaces, _ := gnet.InterfacesWithContext(ctx)
	up := map[string]bool{}
	for _, iface := range interfaces {
		for _, flag := range iface.Flags {
			if flag == "up" {
				up[iface.Name] = true
				break
			}
		}
	}
	result := []NetMetric{}
	for _, counter := range counters {
		if strings.HasPrefix(counter.Name, "lo") {
			continue
		}
		result = append(result, NetMetric{
			Name:      counter.Name,
			BytesSent: counter.BytesSent,
			BytesRecv: counter.BytesRecv,
			Up:        up[counter.Name],
		})
	}
	return result
}

func collectTopProcesses(ctx context.Context, limit int) []ProcMetric {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil
	}
	result := []ProcMetric{}
	for _, proc := range procs {
		name, err := proc.NameWithContext(ctx)
		if err != nil || name == "" {
			continue
		}
		cpuPercent, _ := proc.CPUPercentWithContext(ctx)
		memPercent, _ := proc.MemoryPercentWithContext(ctx)
		if cpuPercent <= 0 && memPercent <= 0 {
			continue
		}
		result = append(result, ProcMetric{
			PID:           proc.Pid,
			Name:          name,
			CPUPercent:    cpuPercent,
			MemoryPercent: memPercent,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].CPUPercent+float64(result[i].MemoryPercent) > result[j].CPUPercent+float64(result[j].MemoryPercent)
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result
}

func collectServices(ctx context.Context, checks []string) []SvcMetric {
	if len(checks) == 0 {
		return nil
	}
	procs, _ := process.ProcessesWithContext(ctx)
	running := map[string]bool{}
	for _, proc := range procs {
		name, err := proc.NameWithContext(ctx)
		if err == nil {
			running[strings.ToLower(name)] = true
		}
	}
	result := []SvcMetric{}
	for _, check := range checks {
		check = strings.TrimSpace(check)
		if check == "" {
			continue
		}
		status := "stopped"
		if running[strings.ToLower(check)] {
			status = "running"
		}
		result = append(result, SvcMetric{Name: check, Status: status})
	}
	return result
}
