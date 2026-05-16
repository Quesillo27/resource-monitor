//go:build !linux

package dbhost

import "fmt"

func detect(hint string) (Detected, error) {
	return Detected{}, fmt.Errorf("modo db host: solo soportado en Linux por ahora")
}
