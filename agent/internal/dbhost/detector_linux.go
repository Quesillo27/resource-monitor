//go:build linux

package dbhost

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// detect escanea /proc buscando el proceso principal del motor. Si hint no
// esta vacio fuerza ese motor y solo se busca el PID del postmaster.
//
// Orden de busqueda:
//   1. /proc/<pid>/comm == "postgres" | "mysqld" | "mongod"
//   2. Se elige el PID padre (postmaster, no backend hijo) — el de menor PID
//      generalmente es el principal en PG.
//   3. Datadir: para PG via /proc/<pid>/cwd; para mysql/mongo via cmdline.
func detect(hint string) (Detected, error) {
	var d Detected
	want := strings.ToLower(strings.TrimSpace(hint))

	candidates := map[string][]int{} // engine -> PIDs encontrados
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return d, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		if err != nil {
			continue
		}
		name := strings.TrimSpace(string(comm))
		switch name {
		case "postgres":
			candidates["postgres"] = append(candidates["postgres"], pid)
		case "mysqld":
			candidates["mysql"] = append(candidates["mysql"], pid)
		case "mongod":
			candidates["mongo"] = append(candidates["mongo"], pid)
		}
	}

	pick := want
	if pick == "" {
		// Auto: prioridad postgres > mysql > mongo
		for _, k := range []string{"postgres", "mysql", "mongo"} {
			if len(candidates[k]) > 0 {
				pick = k
				break
			}
		}
	}
	if pick == "" || len(candidates[pick]) == 0 {
		return d, fmt.Errorf("no se detecto un motor de BD soportado en /proc (hint=%q)", hint)
	}
	d.Engine = pick
	pids := candidates[pick]
	sort.Ints(pids)
	d.PID = pids[0] // postmaster suele ser el primero

	// Datadir + log path por motor
	switch pick {
	case "postgres":
		// cwd del postmaster apunta al datadir en la mayoria de installs
		if link, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", d.PID)); err == nil {
			d.DataDir = link
		}
		// Log: intentar /var/log/postgresql/postgresql-*.log
		if matches, _ := filepath.Glob("/var/log/postgresql/postgresql-*.log"); len(matches) > 0 {
			sort.Strings(matches)
			d.LogPath = matches[len(matches)-1] // el mas reciente
		}
		// Version
		d.EngineVersion = detectPGVersion(d.PID)
	case "mysql":
		// cmdline tiene --datadir=/var/lib/mysql
		if cmd, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", d.PID)); err == nil {
			parts := bytes.Split(cmd, []byte{0})
			for _, p := range parts {
				s := string(p)
				if strings.HasPrefix(s, "--datadir=") {
					d.DataDir = strings.TrimPrefix(s, "--datadir=")
				}
			}
		}
		if d.DataDir == "" {
			d.DataDir = "/var/lib/mysql"
		}
		if _, err := os.Stat("/var/log/mysql/error.log"); err == nil {
			d.LogPath = "/var/log/mysql/error.log"
		}
	case "mongo":
		if d.DataDir == "" {
			d.DataDir = "/var/lib/mongodb"
		}
		if _, err := os.Stat("/var/log/mongodb/mongod.log"); err == nil {
			d.LogPath = "/var/log/mongodb/mongod.log"
		}
	}
	return d, nil
}

// detectPGVersion intenta leer la version desde el binario apuntado en
// /proc/<pid>/exe (-V flag). Falla silenciosamente.
func detectPGVersion(pid int) string {
	exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return ""
	}
	out, err := exec.Command(exe, "-V").Output()
	if err != nil {
		return ""
	}
	// "postgres (PostgreSQL) 16.2 (...)"
	s := strings.TrimSpace(string(out))
	if idx := strings.LastIndex(s, " "); idx > 0 {
		// Tomar el segundo-último token
		parts := strings.Fields(s)
		for i := len(parts) - 1; i >= 0; i-- {
			if v := parts[i]; len(v) > 0 && (v[0] >= '0' && v[0] <= '9') {
				return v
			}
		}
	}
	return s
}
