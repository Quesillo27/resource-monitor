// Package updater verifica nuevas versiones del agente en el server y
// ejecuta el self-update: descarga binario, valida SHA-256 y reemplaza el
// binario en uso. En Linux usa rename atómico + restart del servicio; en
// Windows usa un helper desconectado para resolver el lock del .exe.
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"resource-monitor/agent/internal/config"
)

// CheckLatest queries the server for the latest agent version and compares it
// to the currently running version. Returns the latest version string, whether
// an update is available, and any network/parse error.
func CheckLatest(ctx context.Context, serverURL, currentVersion string) (latest string, hasUpdate bool, err error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	url := strings.TrimRight(serverURL, "/") + "/api/agent/version"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", false, fmt.Errorf("build request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var payload struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", false, fmt.Errorf("decode response: %w", err)
	}

	latest = payload.Version
	hasUpdate = latest != "" && latest != currentVersion
	return latest, hasUpdate, nil
}

// SelfUpdate descarga el binario más reciente para este OS/arch, verifica el
// SHA-256 contra checksums.txt del server y reemplaza el binario actual.
// En Linux retorna nil cuando termina (el caller debe reiniciar el servicio).
// En Windows lanza un helper desconectado y retorna nil; el helper hace la
// rotación tras unos segundos cuando el servicio se detiene.
func SelfUpdate(ctx context.Context, serverURL string) (string, error) {
	binName, err := osBinaryName()
	if err != nil {
		return "", err
	}
	base := strings.TrimRight(serverURL, "/")
	binURL := base + "/downloads/" + binName
	checksumsURL := base + "/downloads/checksums.txt"

	tempDir := os.TempDir()
	tempBin := filepath.Join(tempDir, "resource-monitor-agent.update")
	if runtime.GOOS == "windows" {
		tempBin = filepath.Join(tempDir, "resource-monitor-agent.update.exe")
	}

	if err := downloadFile(ctx, binURL, tempBin); err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	expected, err := fetchExpectedSHA(ctx, checksumsURL, binName)
	if err != nil {
		_ = os.Remove(tempBin)
		return "", fmt.Errorf("fetch checksum: %w", err)
	}
	got, err := sha256OfFile(tempBin)
	if err != nil {
		_ = os.Remove(tempBin)
		return "", err
	}
	if !strings.EqualFold(got, expected) {
		_ = os.Remove(tempBin)
		return "", fmt.Errorf("sha256 mismatch: got %s expected %s", got, expected)
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(tempBin, 0o755)
	}

	target := config.DefaultInstallPath()
	if err := applyUpdate(tempBin, target); err != nil {
		return "", fmt.Errorf("apply update: %w", err)
	}
	return tempBin, nil
}

func osBinaryName() (string, error) {
	switch runtime.GOOS {
	case "linux":
		switch runtime.GOARCH {
		case "amd64":
			return "resource-monitor-agent-linux-amd64", nil
		}
	case "windows":
		switch runtime.GOARCH {
		case "amd64":
			return "resource-monitor-agent-windows-amd64.exe", nil
		}
	case "darwin":
		switch runtime.GOARCH {
		case "amd64":
			return "resource-monitor-agent-darwin-amd64", nil
		case "arm64":
			return "resource-monitor-agent-darwin-arm64", nil
		}
	}
	return "", fmt.Errorf("no binary published for %s/%s", runtime.GOOS, runtime.GOARCH)
}

func downloadFile(ctx context.Context, url, dest string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, resp.Body); err != nil {
		return err
	}
	return out.Close()
}

func fetchExpectedSHA(ctx context.Context, url, binName string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == binName {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("checksum for %s not found", binName)
}

func sha256OfFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// applyUpdate reemplaza el binario actual. En Linux es un rename atómico.
// En Windows lanza un helper que espera al stop del servicio, mueve el
// binario y reinicia.
func applyUpdate(tempBin, target string) error {
	if runtime.GOOS == "windows" {
		return spawnWindowsHelper(tempBin, target)
	}
	if err := os.Rename(tempBin, target); err != nil {
		return err
	}
	// En sistemas con SELinux (Rocky, RHEL, CentOS, AlmaLinux, Fedora) el
	// rename rompe el contexto del archivo (bin_t -> default_t) y systemd
	// no puede ejecutarlo (status=203/EXEC: Permission denied). restorecon
	// lo restaura desde la policy. Si no está disponible (Debian/Ubuntu sin
	// SELinux), no es error: best-effort.
	if runtime.GOOS == "linux" {
		if path, err := exec.LookPath("restorecon"); err == nil {
			_ = exec.Command(path, "-F", target).Run()
		}
	}
	return nil
}

// spawnWindowsHelper genera un script .cmd que se ejecuta desconectado: tras
// 3s detiene el servicio, sobreescribe el .exe, lo arranca y se borra a sí
// mismo. El proceso del agente termina apenas se llama Stop-Service.
func spawnWindowsHelper(tempBin, target string) error {
	helperScript := filepath.Join(os.TempDir(), "resource-monitor-update-helper.cmd")
	script := fmt.Sprintf(`@echo off
timeout /t 3 /nobreak > nul
sc stop "resource-monitor-agent" > nul 2>&1
:waitloop
sc query "resource-monitor-agent" | find "STOPPED" > nul
if errorlevel 1 (
    timeout /t 1 /nobreak > nul
    goto waitloop
)
move /Y "%s" "%s" > nul
sc start "resource-monitor-agent" > nul 2>&1
del "%%~f0"
`, tempBin, target)
	if err := os.WriteFile(helperScript, []byte(script), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("cmd.exe", "/C", "start", "/B", "cmd.exe", "/C", helperScript)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// RestartLinuxService usa systemctl para reiniciar el servicio tras un swap
// del binario. En sistemas con auto-restart habilitado, alternativamente se
// puede dejar que el agente termine y systemd lo levante.
func RestartLinuxService(ctx context.Context) error {
	if runtime.GOOS != "linux" {
		return errors.New("not linux")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return err
	}
	c, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, "systemctl", "restart", "resource-monitor-agent")
	return cmd.Run()
}
