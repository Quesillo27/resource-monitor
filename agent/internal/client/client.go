package client

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"resource-monitor/agent/internal/collector"
)

var ErrUnauthorized = errors.New("agent credential rejected by server (401) — re-run install with --enrollment-token")

type Client struct {
	baseURL    string
	credential string
	http       *http.Client
}

type RegisterResponse struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

// New crea un cliente HTTP. insecureTLS=true desactiva la verificación de
// certificados (sólo para servers con cert auto-firmado en LAN).
func New(baseURL, credential string) *Client {
	return NewWithTLS(baseURL, credential, false)
}

func NewWithTLS(baseURL, credential string, insecureTLS bool) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if insecureTLS {
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		credential: credential,
		http: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
	}
}

func (c *Client) Register(ctx context.Context, token string, host collector.Host) (RegisterResponse, error) {
	payload := map[string]any{
		"enrollment_token": token,
		"name":             host.Name,
		"hostname":         host.Hostname,
		"os":               host.OS,
		"arch":             host.Arch,
		"uptime_seconds":   host.UptimeSeconds,
		"primary_ip":       host.PrimaryIP,
	}
	var result RegisterResponse
	err := c.post(ctx, "/api/agent/register", payload, false, &result)
	return result, err
}

// HeartbeatResponse contiene los comandos pendientes que el server le entrega
// al agente en respuesta al heartbeat. Usar Heartbeat() (sin response) para
// llamadas que no necesitan procesarlos.
type HeartbeatResponse struct {
	Status   string         `json:"status"`
	Commands []AgentCommand `json:"commands,omitempty"`
}

type AgentCommand struct {
	ID      string         `json:"id"`
	Command string         `json:"command"`
	Params  map[string]any `json:"params,omitempty"`
}

func (c *Client) Heartbeat(ctx context.Context, host collector.Host) error {
	return c.post(ctx, "/api/agent/heartbeat", host, true, nil)
}

// HeartbeatWithCommands envía el heartbeat y devuelve los comandos pendientes.
func (c *Client) HeartbeatWithCommands(ctx context.Context, host collector.Host) (*HeartbeatResponse, error) {
	var resp HeartbeatResponse
	if err := c.post(ctx, "/api/agent/heartbeat", host, true, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

// CompleteCommand reporta el resultado de un comando ejecutado.
func (c *Client) CompleteCommand(ctx context.Context, commandID string, ok bool, result map[string]any, errMsg string) error {
	payload := map[string]any{"ok": ok, "result": result, "error": errMsg}
	return c.post(ctx, "/api/agent/commands/"+commandID+"/result", payload, true, nil)
}

func (c *Client) SendMetrics(ctx context.Context, metrics collector.Metrics) error {
	return c.post(ctx, "/api/agent/metrics", metrics, true, nil)
}

func (c *Client) SendInventory(ctx context.Context, inv collector.Inventory) error {
	return c.post(ctx, "/api/agent/inventory", inv, true, nil)
}

// SendOfflineNotice avisa al server que el agente se está apagando limpiamente
// (shutdown del host o stop del servicio). Permite marcar offline en segundos
// en lugar de esperar OFFLINE_AFTER_SECONDS (180s default).
func (c *Client) SendOfflineNotice(ctx context.Context, reason string) error {
	return c.post(ctx, "/api/agent/offline", map[string]string{"reason": reason}, true, nil)
}

func (c *Client) post(ctx context.Context, path string, payload any, auth bool, out any) error {
	if c.baseURL == "" {
		return fmt.Errorf("server URL is required")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if auth {
		req.Header.Set("Authorization", "Bearer "+c.credential)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return ErrUnauthorized
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		message := strings.TrimSpace(string(bytes))
		if message == "" {
			message = resp.Status
		}
		return fmt.Errorf("server returned %s: %s", resp.Status, message)
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}
