// Package buffer persiste muestras de métricas a disco cuando el server está
// caído, para reenviarlas cuando se restablece la conexión. Limita el espacio
// ocupado descartando las más viejas (FIFO con bound).
package buffer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// MaxEntries es el tope de muestras almacenadas (≈1.4 días con interval=60s).
// Cada entry pesa 5-30 KB → ~5 MB en peor caso.
const MaxEntries = 2000

type Entry struct {
	At      time.Time       `json:"at"`
	Kind    string          `json:"kind"` // "metrics" | "heartbeat" | "inventory"
	Payload json.RawMessage `json:"payload"`
}

type Buffer struct {
	dir string
	mu  sync.Mutex
}

func New(dir string) (*Buffer, error) {
	if dir == "" {
		return nil, errors.New("buffer dir required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Buffer{dir: dir}, nil
}

// Append guarda una muestra. Si supera MaxEntries, descarta las más viejas.
func (b *Buffer) Append(kind string, payload any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	entry := Entry{At: time.Now(), Kind: kind, Payload: raw}
	name := filepath.Join(b.dir, time.Now().UTC().Format("20060102T150405.000000000")+"-"+kind+".json")
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if err := os.WriteFile(name, data, 0o600); err != nil {
		return err
	}
	return b.pruneLocked()
}

// Drain entrega todas las entries en orden cronológico al callback. Si el
// callback retorna nil, la entrada se elimina; si retorna error, se detiene
// el drenaje (la siguiente reconexión lo intenta de nuevo).
func (b *Buffer) Drain(ctx context.Context, send func(Entry) error) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	entries, err := b.listLocked()
	if err != nil {
		return err
	}
	for _, info := range entries {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		path := filepath.Join(b.dir, info.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var entry Entry
		if err := json.Unmarshal(data, &entry); err != nil {
			_ = os.Remove(path)
			continue
		}
		if err := send(entry); err != nil {
			return err
		}
		_ = os.Remove(path)
	}
	return nil
}

// Count devuelve cuántas entradas hay pendientes (para health/status).
func (b *Buffer) Count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	entries, _ := b.listLocked()
	return len(entries)
}

func (b *Buffer) listLocked() ([]os.DirEntry, error) {
	all, err := os.ReadDir(b.dir)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, e := range all {
		if !e.IsDir() {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name() < out[j].Name() })
	return out, nil
}

func (b *Buffer) pruneLocked() error {
	entries, err := b.listLocked()
	if err != nil {
		return err
	}
	for len(entries) > MaxEntries {
		_ = os.Remove(filepath.Join(b.dir, entries[0].Name()))
		entries = entries[1:]
	}
	return nil
}
