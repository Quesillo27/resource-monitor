//go:build linux

package collector

import (
	"os/exec"
	"strings"
)

func CollectSoftware() []SoftwareItem {
	if items := tryDpkg(); len(items) > 0 {
		return items
	}
	if items := tryRpm(); len(items) > 0 {
		return items
	}
	return nil
}

func tryDpkg() []SoftwareItem {
	out, err := exec.Command("dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\n").Output()
	if err != nil {
		return nil
	}
	result := []SoftwareItem{}
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "\t", 3)
		if len(parts) < 2 || parts[0] == "" {
			continue
		}
		item := SoftwareItem{Name: parts[0], Version: parts[1]}
		if len(parts) == 3 {
			item.Publisher = parts[2]
		}
		result = append(result, item)
	}
	return result
}

func tryRpm() []SoftwareItem {
	out, err := exec.Command("rpm", "-qa", "--queryformat", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n").Output()
	if err != nil {
		return nil
	}
	result := []SoftwareItem{}
	for _, line := range strings.Split(string(out), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "\t", 3)
		if len(parts) < 2 || parts[0] == "" {
			continue
		}
		item := SoftwareItem{Name: parts[0], Version: parts[1]}
		if len(parts) == 3 {
			item.Publisher = parts[2]
		}
		result = append(result, item)
	}
	return result
}
