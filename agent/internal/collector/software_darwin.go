//go:build darwin

package collector

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"
)

func CollectSoftware() []SoftwareItem {
	seen := make(map[string]struct{})
	var result []SoftwareItem

	for _, item := range tryBrew() {
		if _, exists := seen[item.Name]; !exists {
			seen[item.Name] = struct{}{}
			result = append(result, item)
		}
	}

	for _, item := range trySystemProfiler() {
		if _, exists := seen[item.Name]; !exists {
			seen[item.Name] = struct{}{}
			result = append(result, item)
		}
	}

	return result
}

func tryBrew() []SoftwareItem {
	brewPath, err := exec.LookPath("brew")
	if err != nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, brewPath, "list", "--versions").Output()
	if err != nil {
		return nil
	}

	var result []SoftwareItem
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		name := parts[0]
		version := strings.Join(parts[1:], " ")
		result = append(result, SoftwareItem{Name: name, Version: version})
	}
	return result
}

func trySystemProfiler() []SoftwareItem {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, "system_profiler", "SPApplicationsDataType", "-json").Output()
	if err != nil {
		return nil
	}

	var data struct {
		SPApplicationsDataType []struct {
			Name    string `json:"_name"`
			Version string `json:"version"`
		} `json:"SPApplicationsDataType"`
	}
	if err := json.Unmarshal(out, &data); err != nil {
		return nil
	}

	const maxApps = 200
	var result []SoftwareItem
	for i, app := range data.SPApplicationsDataType {
		if i >= maxApps {
			break
		}
		if app.Name == "" {
			continue
		}
		result = append(result, SoftwareItem{Name: app.Name, Version: app.Version})
	}
	return result
}
