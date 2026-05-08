package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// CheckLatest queries the server for the latest agent version and compares it
// to the currently running version. Returns the latest version string, whether
// an update is available, and any network/parse error.
//
// The endpoint GET {serverURL}/api/agent/version must be public (no auth).
// On any error the caller should decide whether to log or silently ignore.
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
