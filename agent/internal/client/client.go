package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"resource-monitor/agent/internal/collector"
)

type Client struct {
	baseURL    string
	credential string
	http       *http.Client
}

type RegisterResponse struct {
	AgentID    string `json:"agent_id"`
	Credential string `json:"credential"`
}

func New(baseURL, credential string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		credential: credential,
		http:       &http.Client{Timeout: 30 * time.Second},
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
	}
	var result RegisterResponse
	err := c.post(ctx, "/api/agent/register", payload, false, &result)
	return result, err
}

func (c *Client) Heartbeat(ctx context.Context, host collector.Host) error {
	return c.post(ctx, "/api/agent/heartbeat", host, true, nil)
}

func (c *Client) SendMetrics(ctx context.Context, metrics collector.Metrics) error {
	return c.post(ctx, "/api/agent/metrics", metrics, true, nil)
}

func (c *Client) SendInventory(ctx context.Context, inv collector.Inventory) error {
	return c.post(ctx, "/api/agent/inventory", inv, true, nil)
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
