//go:build windows

package collector

import (
	"golang.org/x/sys/windows/registry"
)

func CollectSoftware() []SoftwareItem {
	keys := []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`,
		`SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall`,
	}
	seen := map[string]bool{}
	result := []SoftwareItem{}
	for _, path := range keys {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.READ)
		if err != nil {
			continue
		}
		subkeys, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, sub := range subkeys {
			sk, err := registry.OpenKey(registry.LOCAL_MACHINE, path+`\`+sub, registry.READ)
			if err != nil {
				continue
			}
			name, _, _ := sk.GetStringValue("DisplayName")
			version, _, _ := sk.GetStringValue("DisplayVersion")
			publisher, _, _ := sk.GetStringValue("Publisher")
			sk.Close()
			if name == "" || seen[name+version] {
				continue
			}
			seen[name+version] = true
			result = append(result, SoftwareItem{Name: name, Version: version, Publisher: publisher})
		}
	}
	return result
}
