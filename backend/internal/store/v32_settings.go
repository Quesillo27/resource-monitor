package store

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

func (s *Store) EnsureV32Schema(ctx context.Context) error {
	statements := []string{
		"ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'",
		"ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true",
		"ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()",
		"UPDATE users SET role = 'admin' WHERE role = ''",
		"ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN NOT NULL DEFAULT false",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notify_telegram BOOLEAN NOT NULL DEFAULT false",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS telegram_notified_at TIMESTAMPTZ",
		"ALTER TABLE alerts ADD COLUMN IF NOT EXISTS telegram_notification_count INTEGER NOT NULL DEFAULT 0",
		`CREATE TABLE IF NOT EXISTS telegram_settings (
			id INTEGER PRIMARY KEY DEFAULT 1,
			enabled BOOLEAN NOT NULL DEFAULT false,
			bot_token TEXT NOT NULL DEFAULT '',
			chat_ids TEXT NOT NULL DEFAULT '',
			parse_mode TEXT NOT NULL DEFAULT 'HTML',
			cooldown_minutes INTEGER NOT NULL DEFAULT 30,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			CONSTRAINT telegram_settings_singleton CHECK (id = 1)
		)`,
		"INSERT INTO telegram_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
	}
	for _, statement := range statements {
		if _, err := s.pool.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AuthenticateUserV32(ctx context.Context, username, password string) (*User, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return nil, err
	}
	var user User
	var active bool
	err := s.pool.QueryRow(ctx, "SELECT id::text, username, password_hash, active FROM users WHERE username = $1", username).Scan(&user.ID, &user.Username, &user.PasswordHash, &active)
	if err == pgx.ErrNoRows || !active {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		return nil, ErrUnauthorized
	}
	return &user, nil
}

func (s *Store) UserRole(ctx context.Context, userID string) (string, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return "", err
	}
	var role string
	err := s.pool.QueryRow(ctx, "SELECT role FROM users WHERE id = $1 AND active = true", userID).Scan(&role)
	if err == pgx.ErrNoRows {
		return "", ErrUnauthorized
	}
	if strings.TrimSpace(role) == "" {
		role = "admin"
	}
	return normalizeRoleV32(role), err
}

func (s *Store) ListUsers(ctx context.Context) ([]models.UserDTO, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, username, role, active, created_at, updated_at
		FROM users
		ORDER BY username
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []models.UserDTO{}
	for rows.Next() {
		var user models.UserDTO
		if err := rows.Scan(&user.ID, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, err
		}
		user.Role = normalizeRoleV32(user.Role)
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) CreateUser(ctx context.Context, req models.UserCreateRequest) (models.UserDTO, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return models.UserDTO{}, err
	}
	username := strings.TrimSpace(req.Username)
	if username == "" || strings.TrimSpace(req.Password) == "" {
		return models.UserDTO{}, fmt.Errorf("username and password are required")
	}
	role := normalizeRoleV32(req.Role)
	active := true
	if req.Active != nil {
		active = *req.Active
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return models.UserDTO{}, err
	}
	var user models.UserDTO
	err = s.pool.QueryRow(ctx, `
		INSERT INTO users (username, password_hash, role, active, updated_at)
		VALUES ($1, $2, $3, $4, now())
		RETURNING id::text, username, role, active, created_at, updated_at
	`, username, string(hash), role, active).Scan(&user.ID, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.UpdatedAt)
	return user, err
}

func (s *Store) UpdateUser(ctx context.Context, id string, req models.UserUpdateRequest) (models.UserDTO, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return models.UserDTO{}, err
	}
	role := normalizeRoleV32(req.Role)
	active := true
	if req.Active != nil {
		active = *req.Active
	}
	username := strings.TrimSpace(req.Username)
	var user models.UserDTO
	err := s.pool.QueryRow(ctx, `
		UPDATE users
		SET username = COALESCE(NULLIF($2, ''), username), role = $3, active = $4, updated_at = now()
		WHERE id = $1
		RETURNING id::text, username, role, active, created_at, updated_at
	`, id, username, role, active).Scan(&user.ID, &user.Username, &user.Role, &user.Active, &user.CreatedAt, &user.UpdatedAt)
	if err == pgx.ErrNoRows {
		return models.UserDTO{}, ErrNotFound
	}
	return user, err
}

func (s *Store) UpdateUserPassword(ctx context.Context, id, password string) error {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return err
	}
	if strings.TrimSpace(password) == "" {
		return fmt.Errorf("password is required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	result, err := s.pool.Exec(ctx, "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", id, string(hash))
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteUser(ctx context.Context, id string) error {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return err
	}
	var username string
	err := s.pool.QueryRow(ctx, "SELECT username FROM users WHERE id = $1", id).Scan(&username)
	if err == pgx.ErrNoRows {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if strings.EqualFold(strings.TrimSpace(username), "admin") {
		return fmt.Errorf("no se puede eliminar el usuario admin")
	}
	result, err := s.pool.Exec(ctx, "DELETE FROM users WHERE id = $1", id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) GetTelegramSettings(ctx context.Context) (models.TelegramSettings, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return models.TelegramSettings{}, err
	}
	var settings models.TelegramSettings
	err := s.pool.QueryRow(ctx, `
		SELECT enabled, bot_token, chat_ids, parse_mode, cooldown_minutes
		FROM telegram_settings WHERE id = 1
	`).Scan(&settings.Enabled, &settings.BotToken, &settings.ChatIDs, &settings.ParseMode, &settings.CooldownMinutes)
	if settings.ParseMode == "" {
		settings.ParseMode = "HTML"
	}
	if settings.CooldownMinutes <= 0 {
		settings.CooldownMinutes = 30
	}
	return settings, err
}

func (s *Store) SaveTelegramSettings(ctx context.Context, settings models.TelegramSettings) (models.TelegramSettings, error) {
	if err := s.EnsureV32Schema(ctx); err != nil {
		return models.TelegramSettings{}, err
	}
	if settings.ParseMode == "" {
		settings.ParseMode = "HTML"
	}
	if settings.CooldownMinutes <= 0 {
		settings.CooldownMinutes = 30
	}
	// Preserve current bot_token if empty (frontend never sends it for security)
	if strings.TrimSpace(settings.BotToken) == "" {
		if current, err := s.GetTelegramSettings(ctx); err == nil {
			settings.BotToken = current.BotToken
		}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO telegram_settings (id, enabled, bot_token, chat_ids, parse_mode, cooldown_minutes, updated_at)
		VALUES (1, $1, $2, $3, $4, $5, now())
		ON CONFLICT (id) DO UPDATE SET
		  enabled = EXCLUDED.enabled,
		  bot_token = EXCLUDED.bot_token,
		  chat_ids = EXCLUDED.chat_ids,
		  parse_mode = EXCLUDED.parse_mode,
		  cooldown_minutes = EXCLUDED.cooldown_minutes,
		  updated_at = now()
	`, settings.Enabled, settings.BotToken, settings.ChatIDs, settings.ParseMode, settings.CooldownMinutes)
	return settings, err
}

func (s *Store) TestTelegramSettings(ctx context.Context, settings models.TelegramSettings) error {
	if strings.TrimSpace(settings.BotToken) == "" {
		current, err := s.GetTelegramSettings(ctx)
		if err == nil {
			settings.BotToken = current.BotToken
		}
	}
	return sendTelegramV32(settings, "<b>Resource Monitor</b>\nPrueba de Telegram enviada correctamente.")
}

func normalizeRoleV32(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "admin":
		return "admin"
	case "operator":
		return "operator"
	default:
		return "viewer"
	}
}

type pendingAlertV32 struct {
	ID                        string
	Agent                     string
	Severity                  string
	Message                   string
	ResourceKey               string
	ObservedValue             *float64
	ThresholdValue            *float64
	Unit                      string
	DurationSamples           int
	NotifyEmail               bool
	NotifyTelegram            bool
	NotificationCount         int
	TelegramNotificationCount int
	CooldownMinutes           int
	OpenedAt                  time.Time
}

func sanitizeMailHeader(s string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(s)
}

func sendAlertHTMLMailV32(settings models.SMTPSettings, alert pendingAlertV32, processes []models.ProcMetric) error {
	subject := "Resource Monitor alerta " + strings.ToUpper(sanitizeMailHeader(alert.Severity)) + " - " + sanitizeMailHeader(alert.Agent)
	text := alertPlainTextV32(alert, processes)
	htmlBody := alertHTMLV32(alert, processes)
	return sendHTMLMailV32(settings, subject, text, htmlBody)
}

func sendHTMLMailV32(settings models.SMTPSettings, subject, textBody, htmlBody string) error {
	if settings.Port == 0 {
		settings.Port = 587
	}
	to := splitRecipientsV3(settings.ToAddresses)
	if len(to) == 0 {
		return fmt.Errorf("missing recipients")
	}
	from := strings.TrimSpace(settings.FromAddress)
	if from == "" {
		from = strings.TrimSpace(settings.Username)
	}
	if from == "" {
		return fmt.Errorf("missing sender")
	}
	boundary := "rm-alt-2026"
	msg := bytes.Buffer{}
	msg.WriteString("From: " + sanitizeMailHeader(from) + "\r\n")
	msg.WriteString("To: " + sanitizeMailHeader(strings.Join(to, ", ")) + "\r\n")
	msg.WriteString("Subject: " + sanitizeMailHeader(subject) + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: multipart/alternative; boundary=" + boundary + "\r\n\r\n")
	msg.WriteString("--" + boundary + "\r\n")
	msg.WriteString("Content-Type: text/plain; charset=utf-8\r\n\r\n")
	msg.WriteString(textBody + "\r\n")
	msg.WriteString("--" + boundary + "\r\n")
	msg.WriteString("Content-Type: text/html; charset=utf-8\r\n\r\n")
	msg.WriteString(htmlBody + "\r\n")
	msg.WriteString("--" + boundary + "--\r\n")

	auth := smtp.Auth(nil)
	if settings.Username != "" {
		auth = smtp.PlainAuth("", settings.Username, settings.Password, settings.Host)
	}
	addr := net.JoinHostPort(settings.Host, fmt.Sprint(settings.Port))
	if settings.UseTLS {
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: settings.Host, MinVersion: tls.VersionTLS12})
		if err != nil {
			return err
		}
		client, err := smtp.NewClient(conn, settings.Host)
		if err != nil {
			return err
		}
		defer client.Close()
		return sendWithClientV3(client, auth, from, to, msg.Bytes())
	}
	client, err := smtp.Dial(addr)
	if err != nil {
		return err
	}
	defer client.Close()
	if settings.UseStartTLS {
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: settings.Host, MinVersion: tls.VersionTLS12}); err != nil {
				return err
			}
		}
	}
	return sendWithClientV3(client, auth, from, to, msg.Bytes())
}

func alertHTMLV32(alert pendingAlertV32, processes []models.ProcMetric) string {
	severityColor := "#d97706"
	if alert.Severity == "critical" {
		severityColor = "#dc2626"
	}
	return fmt.Sprintf(`<!doctype html><html><body style="margin:0;background:#f3f6fa;font-family:Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%%" cellspacing="0" cellpadding="0" style="background:#f3f6fa;padding:24px;"><tr><td align="center">
<table role="presentation" width="680" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border:1px solid #dbe5f0;border-radius:14px;overflow:hidden;">
<tr><td style="padding:22px 26px;border-bottom:1px solid #e5edf5;"><div style="font-size:12px;font-weight:700;color:%s;letter-spacing:.08em;">%s</div><h1 style="margin:8px 0 0;font-size:24px;line-height:1.2;">Resource Monitor</h1><p style="margin:8px 0 0;color:#52657d;">%s - %s</p></td></tr>
<tr><td style="padding:22px 26px;"><p style="margin:0 0 16px;font-size:16px;"><b>%s</b></p>%s%s</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid #e5edf5;color:#667085;font-size:12px;">Mensaje automatico de Resource Monitor. Revise el detalle del equipo para diagnostico y reglas.</td></tr>
</table></td></tr></table></body></html>`, severityColor, strings.ToUpper(alert.Severity), escV32(alert.Agent), alert.OpenedAt.Format(time.RFC3339), escV32(alert.Message), alertFactsHTMLV32(alert), processTableHTMLV32(processes))
}

func alertFactsHTMLV32(alert pendingAlertV32) string {
	unit := strings.TrimSpace(alert.Unit)
	observed := valueTextV32(alert.ObservedValue, unit)
	threshold := valueTextV32(alert.ThresholdValue, unit)
	channel := "Plataforma"
	if alert.NotifyEmail && alert.NotifyTelegram {
		channel = "Email + Telegram"
	} else if alert.NotifyEmail {
		channel = "Email"
	} else if alert.NotifyTelegram {
		channel = "Telegram"
	}
	cards := []struct{ label, value string }{
		{"Valor observado", observed},
		{"Umbral", threshold},
		{"Duracion", fmt.Sprintf("%d muestras", alert.DurationSamples)},
		{"Recurso", blankV32(alert.ResourceKey, "general")},
		{"Canal", channel},
	}
	out := `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;"><tr>`
	for _, card := range cards {
		out += fmt.Sprintf(`<td style="width:20%%;padding:8px;"><div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px;background:#f8fbff;"><div style="font-size:11px;color:#64748b;text-transform:uppercase;font-weight:700;">%s</div><div style="font-size:16px;font-weight:800;margin-top:6px;">%s</div></div></td>`, escV32(card.label), escV32(card.value))
	}
	return out + `</tr></table>`
}

func processTableHTMLV32(processes []models.ProcMetric) string {
	if len(processes) == 0 {
		return `<p style="color:#64748b;margin:0;">Sin snapshot de procesos para esta alerta.</p>`
	}
	out := `<h2 style="font-size:16px;margin:18px 0 10px;">Top procesos al momento de la alerta</h2><table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;"><thead><tr style="background:#f8fafc;color:#475569;text-align:left;font-size:12px;text-transform:uppercase;"><th style="padding:10px;">Proceso</th><th style="padding:10px;">PID</th><th style="padding:10px;">CPU</th><th style="padding:10px;">RAM</th></tr></thead><tbody>`
	for _, proc := range processes {
		out += fmt.Sprintf(`<tr><td style="padding:10px;border-top:1px solid #edf2f7;">%s</td><td style="padding:10px;border-top:1px solid #edf2f7;">%d</td><td style="padding:10px;border-top:1px solid #edf2f7;">%.1f%%</td><td style="padding:10px;border-top:1px solid #edf2f7;">%.1f%%</td></tr>`, escV32(proc.Name), proc.PID, proc.CPUPercent, proc.MemoryPercent)
	}
	return out + `</tbody></table>`
}

func alertPlainTextV32(alert pendingAlertV32, processes []models.ProcMetric) string {
	body := fmt.Sprintf("Resource Monitor alerta %s\nEquipo: %s\nAlerta: %s\nValor: %s\nUmbral: %s\nDuracion: %d muestras\nApertura: %s\n", strings.ToUpper(alert.Severity), alert.Agent, alert.Message, valueTextV32(alert.ObservedValue, alert.Unit), valueTextV32(alert.ThresholdValue, alert.Unit), alert.DurationSamples, alert.OpenedAt.Format(time.RFC3339))
	return body + processSnapshotText(processes)
}

func telegramAlertTextV32(alert pendingAlertV32, processes []models.ProcMetric) string {
	return fmt.Sprintf("<b>Resource Monitor %s</b>\nEquipo: %s\nAlerta: %s\nValor: %s\nUmbral: %s\nMuestras: %d\n%s", strings.ToUpper(alert.Severity), escV32(alert.Agent), escV32(alert.Message), escV32(valueTextV32(alert.ObservedValue, alert.Unit)), escV32(valueTextV32(alert.ThresholdValue, alert.Unit)), alert.DurationSamples, escV32(processSnapshotText(processes)))
}

func sendTelegramV32(settings models.TelegramSettings, message string) error {
	if strings.TrimSpace(settings.BotToken) == "" {
		return fmt.Errorf("missing telegram bot token")
	}
	chats := splitRecipientsV3(settings.ChatIDs)
	if len(chats) == 0 {
		return fmt.Errorf("missing telegram chat ids")
	}
	parseMode := settings.ParseMode
	if parseMode == "" {
		parseMode = "HTML"
	}
	client := &http.Client{Timeout: 15 * time.Second}
	for _, chat := range chats {
		payload := map[string]any{"chat_id": chat, "text": message, "parse_mode": parseMode, "disable_web_page_preview": true}
		buf, _ := json.Marshal(payload)
		url := "https://api.telegram.org/bot" + strings.TrimSpace(settings.BotToken) + "/sendMessage"
		res, err := client.Post(url, "application/json", bytes.NewReader(buf))
		if err != nil {
			return err
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			res.Body.Close()
			return fmt.Errorf("telegram returned status %d", res.StatusCode)
		}
		res.Body.Close()
	}
	return nil
}

func valueTextV32(value *float64, unit string) string {
	if value == nil {
		return "n/a"
	}
	return fmt.Sprintf("%.2f%s", *value, unit)
}

func blankV32(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func escV32(value string) string {
	return html.EscapeString(value)
}
