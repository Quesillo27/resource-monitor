package collector

import (
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/shirou/gopsutil/v4/sensors"
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
	Temperatures      []TempMetric `json:"temperatures,omitempty"`
	GatewayLatencyMs  *float64     `json:"gateway_latency_ms,omitempty"`
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

type TempMetric struct {
	SensorKey     string  `json:"sensor_key"`
	TemperatureC  float64 `json:"temperature_c"`
}

type SoftwareItem struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	Publisher string `json:"publisher,omitempty"`
}

type Inventory struct {
	Hardware HardwareInfo   `json:"hardware"`
	Software []SoftwareItem `json:"software"`
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
	if profile == "balanced" || profile == "" {
		metrics.Networks = collectNetworks(ctx)
		metrics.Processes = collectTopProcesses(ctx, 10)
		metrics.Services = collectServices(ctx, serviceChecks)
	} else if profile == "full" {
		metrics.Networks = collectNetworks(ctx)
		metrics.Processes = collectTopProcesses(ctx, 20)
		metrics.Services = collectServices(ctx, serviceChecks)
		metrics.Temperatures = collectTemperatures(ctx)
	}
	metrics.GatewayLatencyMs = measureGatewayLatency(ctx)
	return metrics, nil
}

// detectDefaultGateway returns the IP of the default gateway, or "" if not found.
func detectDefaultGateway() string {
	switch runtime.GOOS {
	case "linux":
		out, err := exec.Command("ip", "route", "show", "default").Output()
		if err != nil {
			return ""
		}
		// "default via 192.168.1.1 dev eth0 ..."
		re := regexp.MustCompile(`default via (\S+)`)
		if m := re.FindSubmatch(out); len(m) >= 2 {
			return string(m[1])
		}
	case "darwin":
		out, err := exec.Command("netstat", "-rn").Output()
		if err != nil {
			return ""
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) >= 2 && fields[0] == "default" {
				return fields[1]
			}
		}
	case "windows":
		out, err := exec.Command("route", "print", "0.0.0.0").Output()
		if err != nil {
			return ""
		}
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			// Destination 0.0.0.0, mask 0.0.0.0, gateway at index 2
			if len(fields) >= 3 && fields[0] == "0.0.0.0" && fields[1] == "0.0.0.0" {
				return fields[2]
			}
		}
	}
	return ""
}

// measureGatewayLatency pings the default gateway and returns avg RTT in ms.
// Returns nil silently on any error — never blocks the collection cycle.
func measureGatewayLatency(ctx context.Context) *float64 {
	gw := detectDefaultGateway()
	if gw == "" {
		return nil
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.CommandContext(pingCtx, "ping", "-n", "3", "-w", "1000", gw)
	default:
		cmd = exec.CommandContext(pingCtx, "ping", "-c", "3", "-W", "1", gw)
	}

	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return nil
	}

	return parsePingAvg(out.String())
}

// parsePingAvg extracts the average RTT in ms from ping output.
func parsePingAvg(output string) *float64 {
	// Linux/macOS: "rtt min/avg/max/mdev = 0.123/0.456/0.789/0.100 ms"
	// macOS older:  "round-trip min/avg/max/stddev = 0.123/0.456/0.789/0.100 ms"
	reRTT := regexp.MustCompile(`(?:rtt|round-trip)[^=]+=\s*[\d.]+/([\d.]+)/`)
	if m := reRTT.FindStringSubmatch(output); len(m) >= 2 {
		v, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			return &v
		}
	}
	// Windows: "Average = 5ms"
	reWin := regexp.MustCompile(`Average\s*=\s*([\d]+)\s*ms`)
	if m := reWin.FindStringSubmatch(output); len(m) >= 2 {
		v, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			return &v
		}
	}
	return nil
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
	numCPU := float64(runtime.NumCPU())
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
		// Normalize CPU to system-relative % (gopsutil returns per-core %)
		if numCPU > 1 {
			cpuPercent = cpuPercent / numCPU
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

func collectTemperatures(ctx context.Context) []TempMetric {
	temps, err := sensors.TemperaturesWithContext(ctx)
	if err != nil || len(temps) == 0 {
		return nil
	}
	result := []TempMetric{}
	for _, t := range temps {
		if t.Temperature > 0 {
			result = append(result, TempMetric{
				SensorKey:    t.SensorKey,
				TemperatureC: t.Temperature,
			})
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
