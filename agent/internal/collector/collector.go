package collector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os/exec"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
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
	Name           string `json:"name"`
	Hostname       string `json:"hostname"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	UptimeSeconds  uint64 `json:"uptime_seconds"`
	AgentUptimeSec uint64 `json:"agent_uptime_seconds,omitempty"`
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
	Name      string  `json:"name"`
	BytesSent uint64  `json:"bytes_sent"`
	BytesRecv uint64  `json:"bytes_recv"`
	Up        bool    `json:"up"`
	SentMbps  float64 `json:"sent_mbps,omitempty"`
	RecvMbps  float64 `json:"recv_mbps,omitempty"`
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
	SensorKey    string  `json:"sensor_key"`
	TemperatureC float64 `json:"temperature_c"`
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

// agentStartedAt registra el inicio del proceso para reportar uptime del
// agente (separado del uptime del host).
var agentStartedAt = time.Now()

func HostInfo() (Host, error) {
	info, err := host.Info()
	if err != nil {
		return Host{}, err
	}
	return Host{
		Name:           info.Hostname,
		Hostname:       info.Hostname,
		OS:             info.Platform + " " + info.PlatformVersion,
		Arch:           runtime.GOARCH,
		UptimeSeconds:  info.Uptime,
		AgentUptimeSec: uint64(time.Since(agentStartedAt).Seconds()),
	}, nil
}

// Collect recolecta todas las métricas del sistema. Tiene un timeout interno
// de 45 s para evitar que un syscall colgado en gopsutil (sensors, WMI,
// disk) trabe el ciclo del agente.
func Collect(ctx context.Context, profile string, serviceChecks []string) (Metrics, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

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
	switch profile {
	case "minimal":
		// solo CPU/RAM/disk
	case "full":
		metrics.Networks = collectNetworks(ctx)
		metrics.Processes = collectTopProcesses(ctx, 20)
		metrics.Services = collectServices(ctx, serviceChecks)
		metrics.Temperatures = collectTemperatures(ctx)
	default: // balanced
		metrics.Networks = collectNetworks(ctx)
		metrics.Processes = collectTopProcesses(ctx, 10)
		metrics.Services = collectServices(ctx, serviceChecks)
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

// pseudoFilesystems agrupa filesystems virtuales que no aportan info útil
// (snaps, tmpfs, cgroup, overlay) y solo inflan el reporte de discos.
var pseudoFilesystems = map[string]bool{
	"tmpfs":       true,
	"devtmpfs":    true,
	"proc":        true,
	"sysfs":       true,
	"cgroup":      true,
	"cgroup2":     true,
	"squashfs":    true,
	"overlay":     true,
	"overlay2":    true,
	"mqueue":      true,
	"pstore":      true,
	"bpf":         true,
	"tracefs":     true,
	"debugfs":     true,
	"securityfs":  true,
	"hugetlbfs":   true,
	"binfmt_misc": true,
	"autofs":      true,
	"fusectl":     true,
	"efivarfs":    true,
	"ramfs":       true,
	"devpts":      true,
	"configfs":    true,
	"selinuxfs":   true,
	"nsfs":        true,
	"none":        true,
}

func collectDisks(ctx context.Context) ([]DiskMetric, error) {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return nil, err
	}
	result := []DiskMetric{}
	seen := map[string]bool{}
	for _, partition := range partitions {
		fstype := strings.ToLower(partition.Fstype)
		if pseudoFilesystems[fstype] {
			continue
		}
		// snap loops, contenedores docker overlay, esnaps en /var/lib/snapd
		if strings.HasPrefix(partition.Mountpoint, "/snap/") ||
			strings.HasPrefix(partition.Mountpoint, "/var/lib/docker/") ||
			strings.HasPrefix(partition.Mountpoint, "/var/lib/containers/") ||
			strings.HasPrefix(partition.Mountpoint, "/run/") {
			continue
		}
		if seen[partition.Mountpoint] {
			continue
		}
		seen[partition.Mountpoint] = true
		usage, err := disk.UsageWithContext(ctx, partition.Mountpoint)
		if err != nil {
			continue
		}
		// descartar discos sin capacidad (montajes vacíos)
		if usage.Total == 0 {
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

// netSnapshot guarda el último snapshot de contadores por interfaz para
// calcular Mbps entre ciclos.
type netSnapshot struct {
	at        time.Time
	bytesSent uint64
	bytesRecv uint64
}

var (
	netSnapshotMu sync.Mutex
	netSnapshots  = map[string]netSnapshot{}
)

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

	now := time.Now()
	netSnapshotMu.Lock()
	defer netSnapshotMu.Unlock()

	result := []NetMetric{}
	for _, counter := range counters {
		if strings.HasPrefix(counter.Name, "lo") {
			continue
		}
		metric := NetMetric{
			Name:      counter.Name,
			BytesSent: counter.BytesSent,
			BytesRecv: counter.BytesRecv,
			Up:        up[counter.Name],
		}
		if prev, ok := netSnapshots[counter.Name]; ok {
			elapsed := now.Sub(prev.at).Seconds()
			if elapsed > 0 && counter.BytesSent >= prev.bytesSent && counter.BytesRecv >= prev.bytesRecv {
				metric.SentMbps = float64(counter.BytesSent-prev.bytesSent) * 8 / 1_000_000 / elapsed
				metric.RecvMbps = float64(counter.BytesRecv-prev.bytesRecv) * 8 / 1_000_000 / elapsed
			}
		}
		netSnapshots[counter.Name] = netSnapshot{
			at:        now,
			bytesSent: counter.BytesSent,
			bytesRecv: counter.BytesRecv,
		}
		result = append(result, metric)
	}
	return result
}

// procCache guarda objetos *process.Process entre ciclos. gopsutil calcula
// CPUPercent como delta entre llamadas al MISMO Process; sin caché, cada
// ciclo crea procs nuevos y CPUPercent siempre es 0 o irreal.
var (
	procCacheMu sync.Mutex
	procCache   = map[int32]*process.Process{}
)

func collectTopProcesses(ctx context.Context, limit int) []ProcMetric {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil
	}

	procCacheMu.Lock()
	defer procCacheMu.Unlock()

	live := map[int32]bool{}
	result := []ProcMetric{}
	numCPU := float64(runtime.NumCPU())

	for _, proc := range procs {
		live[proc.Pid] = true
		// usar el cacheado si existe (para que gopsutil tenga muestra previa)
		cached, hit := procCache[proc.Pid]
		if !hit {
			procCache[proc.Pid] = proc
			cached = proc
		}

		name, err := cached.NameWithContext(ctx)
		if err != nil || name == "" {
			continue
		}
		cpuPercent, _ := cached.CPUPercentWithContext(ctx)
		memPercent, _ := cached.MemoryPercentWithContext(ctx)

		// gopsutil en Linux devuelve CPU% como suma de cores (puede pasar 100%);
		// en Windows ya viene normalizado por core. Solo dividir en Linux.
		if runtime.GOOS == "linux" && numCPU > 1 {
			cpuPercent = cpuPercent / numCPU
		}

		// si NO había caché previo, esta primera muestra es 0 — se descarta
		// pero queda guardado el Process para que el próximo ciclo sí mida.
		if !hit && cpuPercent == 0 && memPercent == 0 {
			continue
		}
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

	// purgar procesos muertos del cache para no crecer indefinidamente
	for pid := range procCache {
		if !live[pid] {
			delete(procCache, pid)
		}
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
	// fallback: tabla de procesos en ejecución por nombre
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
		// 1) intentar SCM (Windows) o systemctl (Linux)
		status := detectServiceStatus(ctx, check)
		// 2) fallback por nombre de proceso si el OS no respondió
		if status == "" {
			if running[strings.ToLower(check)] {
				status = "running"
			} else {
				status = "stopped"
			}
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

// InventoryFingerprint genera un hash estable del inventario actual, para
// detectar cambios y triggear envío fuera del ciclo de 24h.
func InventoryFingerprint(inv Inventory) string {
	payload, err := json.Marshal(inv)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}
