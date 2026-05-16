//go:build linux

package dbhost

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"resource-monitor/agent/internal/client"
)

// Regex de eventos interesantes en logs de PG (configurable a futuro).
var pgLogRegex = regexp.MustCompile(`(?i)\b(FATAL|PANIC|ERROR|WARNING):.*$`)

func collect(ctx context.Context, det Detected, st *State, logPath string) client.DBHostSample {
	now := time.Now()
	sample := client.DBHostSample{
		CapturedAt: now,
		OK:         true,
	}

	// 1) FS del datadir (statfs)
	if det.DataDir != "" {
		if pct, free, total, err := fsStat(det.DataDir); err == nil {
			sample.FSUsedPct = ptrF(pct)
			sample.FSFreeBytes = ptrI(free)
			sample.FSTotalBytes = ptrI(total)
		}
	}

	// 2) Disk I/O del device del datadir (delta desde prev sample)
	if det.DataDir != "" {
		if dev, err := deviceForPath(det.DataDir); err == nil {
			if rOps, wOps, rBytes, wBytes, err := readDiskstats(dev); err == nil {
				if st.PrevIOReadOps > 0 || st.PrevIOWriteOps > 0 {
					sample.IOReadOps = ptrI(rOps - st.PrevIOReadOps)
					sample.IOWriteOps = ptrI(wOps - st.PrevIOWriteOps)
					sample.IOReadBytes = ptrI(rBytes - st.PrevIOReadBytes)
					sample.IOWriteBytes = ptrI(wBytes - st.PrevIOWriteBytes)
				}
				st.PrevIOReadOps = rOps
				st.PrevIOWriteOps = wOps
				st.PrevIOReadBytes = rBytes
				st.PrevIOWriteBytes = wBytes
			}
		}
	}

	// 3) OOM kills (delta desde /proc/vmstat)
	if cur, err := readOOMKillsCount(); err == nil {
		if st.PrevOOMKills > 0 {
			delta := int(cur - st.PrevOOMKills)
			if delta < 0 {
				delta = 0
			}
			sample.OOMKillsDelta = ptrInt(delta)
		} else {
			z := 0
			sample.OOMKillsDelta = &z
		}
		st.PrevOOMKills = cur
	}

	// 4) Proceso PG: CPU%, RSS, FD, uptime
	if det.PID > 0 {
		if cpu, rss, uptimeSec, err := readProcessStats(det.PID, st, now); err == nil {
			sample.PGCPUPct = ptrF(cpu)
			sample.PGRSSBytes = ptrI(rss)
			sample.PGUptimeSec = ptrI(uptimeSec)
		}
		if used, lim, err := readFDStats(det.PID); err == nil {
			sample.PGFDUsed = ptrInt(used)
			sample.PGFDLimit = ptrInt(lim)
		}
	}

	// 5) Tail de log con cursor incremental (ultimas N lineas que matchean)
	if logPath != "" {
		if events, err := tailLog(logPath, st); err == nil {
			sample.LogEvents = events
		}
	}

	_ = ctx
	st.PrevSampleAt = now
	return sample
}

// fsStat retorna pct usado, bytes libres, bytes totales del filesystem
// que contiene path.
func fsStat(path string) (float64, int64, int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, err
	}
	total := int64(st.Blocks) * int64(st.Bsize)
	free := int64(st.Bavail) * int64(st.Bsize)
	used := total - free
	pct := 0.0
	if total > 0 {
		pct = float64(used) * 100.0 / float64(total)
	}
	return pct, free, total, nil
}

// deviceForPath devuelve el nombre del device de bloque (ej "sda", "nvme0n1")
// que contiene el path dado. Lee /proc/self/mountinfo + stat para resolver.
func deviceForPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Encontrar el mount mas largo que coincida con prefijo de path
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return "", err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	var bestMount, bestSource string
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		mountPoint := fields[4]
		// El campo "source" esta despues de "- type": buscar el indice de "-"
		dashIdx := -1
		for i, f := range fields {
			if f == "-" {
				dashIdx = i
				break
			}
		}
		if dashIdx < 0 || dashIdx+2 >= len(fields) {
			continue
		}
		source := fields[dashIdx+2]
		if strings.HasPrefix(abs, mountPoint) && len(mountPoint) > len(bestMount) {
			bestMount = mountPoint
			bestSource = source
		}
	}
	if bestSource == "" {
		return "", fmt.Errorf("no mount encontrado para %s", path)
	}
	// /dev/sda1 -> sda1 -> sda (sin particion)
	dev := strings.TrimPrefix(bestSource, "/dev/")
	// Quitar sufijo de particion comun: sda1 -> sda; nvme0n1p1 -> nvme0n1
	if len(dev) > 0 {
		if strings.HasPrefix(dev, "nvme") {
			if idx := strings.Index(dev, "p"); idx > 0 {
				dev = dev[:idx]
			}
		} else {
			for len(dev) > 0 && dev[len(dev)-1] >= '0' && dev[len(dev)-1] <= '9' {
				dev = dev[:len(dev)-1]
			}
		}
	}
	return dev, nil
}

// readDiskstats lee /proc/diskstats y retorna contadores acumulativos para el
// device dado: read_ops, write_ops, read_bytes, write_bytes.
// Formato: https://www.kernel.org/doc/Documentation/iostats.txt
func readDiskstats(dev string) (int64, int64, int64, int64, error) {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 14 {
			continue
		}
		if fields[2] != dev {
			continue
		}
		rOps, _ := strconv.ParseInt(fields[3], 10, 64)
		rSectors, _ := strconv.ParseInt(fields[5], 10, 64)
		wOps, _ := strconv.ParseInt(fields[7], 10, 64)
		wSectors, _ := strconv.ParseInt(fields[9], 10, 64)
		// Sector size canonico = 512 bytes
		return rOps, wOps, rSectors * 512, wSectors * 512, nil
	}
	return 0, 0, 0, 0, fmt.Errorf("device %s no encontrado en /proc/diskstats", dev)
}

// readOOMKillsCount lee /proc/vmstat -> oom_kill (kernel >= 4.x).
func readOOMKillsCount() (int64, error) {
	f, err := os.Open("/proc/vmstat")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && fields[0] == "oom_kill" {
			return strconv.ParseInt(fields[1], 10, 64)
		}
	}
	return 0, fmt.Errorf("oom_kill no encontrado en /proc/vmstat")
}

// readProcessStats lee /proc/<pid>/stat + /proc/uptime y retorna
// CPU% (sobre intervalo), RSS bytes y uptime del proceso en segundos.
func readProcessStats(pid int, st *State, now time.Time) (float64, int64, int64, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, 0, err
	}
	// El campo (2) es comm entre parentesis que puede contener espacios.
	// Truco: encontrar el ultimo ")" y parsear desde ahi.
	s := string(data)
	rparen := strings.LastIndex(s, ")")
	if rparen < 0 {
		return 0, 0, 0, fmt.Errorf("formato inesperado en /proc/%d/stat", pid)
	}
	tail := strings.Fields(s[rparen+1:])
	// Despues del comm los campos son indexados desde 1 (state) en man proc.
	// utime=field[11], stime=field[12], starttime=field[19], rss=field[21]
	if len(tail) < 22 {
		return 0, 0, 0, fmt.Errorf("campos insuficientes en /proc/%d/stat", pid)
	}
	utime, _ := strconv.ParseUint(tail[11], 10, 64)
	stime, _ := strconv.ParseUint(tail[12], 10, 64)
	starttime, _ := strconv.ParseUint(tail[19], 10, 64)
	rssPages, _ := strconv.ParseInt(tail[21], 10, 64)

	totalTicks := utime + stime
	clkTck := int64(100) // Linux default; sysconf(_SC_CLK_TCK)
	pageSize := int64(os.Getpagesize())

	// uptime del proceso
	uptimeSec := int64(0)
	if upBytes, err := os.ReadFile("/proc/uptime"); err == nil {
		parts := strings.Fields(string(upBytes))
		if len(parts) > 0 {
			if sysUp, err := strconv.ParseFloat(parts[0], 64); err == nil {
				uptimeSec = int64(sysUp - float64(starttime)/float64(clkTck))
			}
		}
	}

	// CPU% sobre el intervalo
	cpuPct := 0.0
	if st.PrevPGCPUTicks > 0 && !st.PrevSampleAt.IsZero() {
		deltaTicks := totalTicks - st.PrevPGCPUTicks
		dt := now.Sub(st.PrevSampleAt).Seconds()
		if dt > 0 {
			cpuPct = float64(deltaTicks) / float64(clkTck) / dt * 100.0
		}
	}
	st.PrevPGCPUTicks = totalTicks

	return cpuPct, rssPages * pageSize, uptimeSec, nil
}

// readFDStats cuenta los FDs abiertos en /proc/<pid>/fd y lee el limite duro
// desde /proc/<pid>/limits ("Max open files").
func readFDStats(pid int) (int, int, error) {
	entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		return 0, 0, err
	}
	used := len(entries)
	lim := 0
	if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/limits", pid)); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "Max open files") {
				fields := strings.Fields(line)
				// "Max open files  1024  4096  files"
				if len(fields) >= 4 {
					lim, _ = strconv.Atoi(fields[3])
				}
				break
			}
		}
	}
	return used, lim, nil
}

// tailLog lee log_path desde el cursor guardado en state, filtra lineas que
// matcheen pgLogRegex y devuelve hasta 20 eventos. Maneja rotacion comparando
// inode. Para evitar memoria desbocada limita la lectura a 1MB por sample.
func tailLog(path string, st *State) ([]client.DBHostLogEvent, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	inode := uint64(0)
	if ok {
		inode = sys.Ino
	}
	// Detectar rotacion: si inode cambia o tamaño es menor al cursor, resetear
	if inode != st.LogInode || fi.Size() < st.LogCursor {
		st.LogCursor = 0
	}
	st.LogInode = inode

	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(st.LogCursor, io.SeekStart); err != nil {
		return nil, err
	}
	// Limitar lectura
	const maxRead = 1 << 20
	limited := io.LimitReader(f, maxRead)

	events := []client.DBHostLogEvent{}
	scanner := bufio.NewScanner(limited)
	scanner.Buffer(make([]byte, 1<<16), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		m := pgLogRegex.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		level := strings.ToUpper(m[1])
		// Eventos INFO no interesan
		if level == "INFO" || level == "LOG" {
			continue
		}
		events = append(events, client.DBHostLogEvent{
			Timestamp: time.Now(),
			Level:     level,
			Pattern:   "regex:" + level,
			Message:   line,
		})
		if len(events) >= 20 {
			break
		}
	}
	// Actualizar cursor a la posicion actual (puede no ser EOF si limited corto)
	if cur, err := f.Seek(0, io.SeekCurrent); err == nil {
		st.LogCursor = cur
	}
	return events, nil
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int64) *int64     { return &v }
func ptrInt(v int) *int       { return &v }
