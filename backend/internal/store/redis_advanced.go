package store

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"

	"resource-monitor/backend/internal/models"
)

// ─── RESP helpers ────────────────────────────────────────────────────────────

func sendRedisCmd(w io.Writer, args ...string) error {
	var b strings.Builder
	fmt.Fprintf(&b, "*%d\r\n", len(args))
	for _, a := range args {
		fmt.Fprintf(&b, "$%d\r\n%s\r\n", len(a), a)
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// readRedisReply parsea una respuesta RESP. Retorna string|int64|[]interface{}|nil.
func readRedisReply(r *bufio.Reader) (interface{}, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimRight(line, "\r\n")
	if len(line) == 0 {
		return nil, fmt.Errorf("redis: empty reply line")
	}
	typ := line[0]
	payload := line[1:]
	switch typ {
	case '+':
		return payload, nil
	case '-':
		return nil, fmt.Errorf("redis: %s", payload)
	case ':':
		return strconv.ParseInt(payload, 10, 64)
	case '$':
		n, err := strconv.Atoi(payload)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		if _, err := r.Discard(2); err != nil { // \r\n
			return nil, err
		}
		return string(buf), nil
	case '*':
		n, err := strconv.Atoi(payload)
		if err != nil {
			return nil, err
		}
		if n < 0 {
			return nil, nil
		}
		arr := make([]interface{}, n)
		for i := 0; i < n; i++ {
			arr[i], err = readRedisReply(r)
			if err != nil {
				return nil, err
			}
		}
		return arr, nil
	default:
		return nil, fmt.Errorf("redis: unknown RESP type %q", typ)
	}
}

// dialRedisTarget abre una conexion al target, hace AUTH si hay password, y
// retorna conn + reader listos para enviar comandos.
func (s *Store) dialRedisTarget(ctx context.Context, id string) (net.Conn, *bufio.Reader, error) {
	t, err := s.GetDatabaseTarget(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if t.Type != "redis" {
		return nil, nil, fmt.Errorf("redis op only available for redis targets")
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", t.DSN)
	if err != nil {
		return nil, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	if pw := t.Params["password"]; pw != "" {
		if err := sendRedisCmd(conn, "AUTH", pw); err != nil {
			conn.Close()
			return nil, nil, err
		}
		reply, err := readRedisReply(r)
		if err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("redis AUTH failed: %w", err)
		}
		if s, _ := reply.(string); s != "OK" {
			conn.Close()
			return nil, nil, fmt.Errorf("redis AUTH unexpected reply: %v", reply)
		}
	}
	return conn, r, nil
}

// ─── SLOWLOG ─────────────────────────────────────────────────────────────────

// GetRedisSlowlog devuelve los ultimos N comandos lentos registrados en el
// slowlog del target. Cada entrada incluye id, timestamp unix, duracion en
// microsegundos y el comando ejecutado.
func (s *Store) GetRedisSlowlog(ctx context.Context, id string, limit int) ([]models.RedisSlowlogEntry, error) {
	if limit <= 0 || limit > 200 {
		limit = 64
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, r, err := s.dialRedisTarget(callCtx, id)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := sendRedisCmd(conn, "SLOWLOG", "GET", strconv.Itoa(limit)); err != nil {
		return nil, err
	}
	reply, err := readRedisReply(r)
	if err != nil {
		return nil, err
	}
	entries := []models.RedisSlowlogEntry{}
	arr, ok := reply.([]interface{})
	if !ok {
		return entries, nil
	}
	for _, raw := range arr {
		row, ok := raw.([]interface{})
		if !ok || len(row) < 4 {
			continue
		}
		e := models.RedisSlowlogEntry{}
		if v, ok := row[0].(int64); ok {
			e.ID = v
		}
		if v, ok := row[1].(int64); ok {
			e.Timestamp = v
		}
		if v, ok := row[2].(int64); ok {
			e.DurationMicro = v
		}
		if cmdArgs, ok := row[3].([]interface{}); ok {
			parts := make([]string, 0, len(cmdArgs))
			for _, a := range cmdArgs {
				if sa, ok := a.(string); ok {
					if len(sa) > 200 {
						sa = sa[:200] + "…"
					}
					parts = append(parts, sa)
				}
			}
			e.Command = strings.Join(parts, " ")
		}
		// Redis 4.0+: extra fields client_addr (4) y client_name (5)
		if len(row) > 4 {
			if v, ok := row[4].(string); ok {
				e.ClientAddr = v
			}
		}
		if len(row) > 5 {
			if v, ok := row[5].(string); ok {
				e.ClientName = v
			}
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// ─── CLIENT LIST ─────────────────────────────────────────────────────────────

// GetRedisClients ejecuta CLIENT LIST y devuelve cada conexion activa parseada.
// El formato es texto plano: "id=42 addr=1.2.3.4:5678 name= age=10 idle=2 ...\n"
func (s *Store) GetRedisClients(ctx context.Context, id string) ([]models.RedisClient, error) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, r, err := s.dialRedisTarget(callCtx, id)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := sendRedisCmd(conn, "CLIENT", "LIST"); err != nil {
		return nil, err
	}
	reply, err := readRedisReply(r)
	if err != nil {
		return nil, err
	}
	text, _ := reply.(string)
	if text == "" {
		return []models.RedisClient{}, nil
	}
	out := []models.RedisClient{}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		c := models.RedisClient{}
		for _, tok := range strings.Fields(line) {
			kv := strings.SplitN(tok, "=", 2)
			if len(kv) != 2 {
				continue
			}
			switch kv[0] {
			case "id":
				c.ID, _ = strconv.ParseInt(kv[1], 10, 64)
			case "addr":
				c.Addr = kv[1]
			case "name":
				c.Name = kv[1]
			case "age":
				c.AgeSec, _ = strconv.ParseInt(kv[1], 10, 64)
			case "idle":
				c.IdleSec, _ = strconv.ParseInt(kv[1], 10, 64)
			case "db":
				c.DB, _ = strconv.Atoi(kv[1])
			case "cmd":
				c.Cmd = kv[1]
			case "flags":
				c.Flags = kv[1]
			case "sub", "psub":
				n, _ := strconv.Atoi(kv[1])
				c.SubCount += n
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// ─── MEMORY STATS ────────────────────────────────────────────────────────────

// GetRedisMemoryStats ejecuta MEMORY STATS y devuelve los desgloses principales.
// Redis responde con un array plano [k1, v1, k2, v2, ...] donde los valores
// pueden ser enteros, strings o sub-arrays (que aplanamos a "extra").
func (s *Store) GetRedisMemoryStats(ctx context.Context, id string) (*models.RedisMemoryStats, error) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	conn, r, err := s.dialRedisTarget(callCtx, id)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	if err := sendRedisCmd(conn, "MEMORY", "STATS"); err != nil {
		return nil, err
	}
	reply, err := readRedisReply(r)
	if err != nil {
		return nil, err
	}
	arr, ok := reply.([]interface{})
	if !ok || len(arr)%2 != 0 {
		return nil, fmt.Errorf("redis: respuesta MEMORY STATS invalida")
	}
	res := &models.RedisMemoryStats{Extra: map[string]string{}}
	for i := 0; i+1 < len(arr); i += 2 {
		key, _ := arr[i].(string)
		switch v := arr[i+1].(type) {
		case int64:
			switch key {
			case "peak.allocated":
				// nada — solo info
			case "total.allocated":
				res.TotalAllocated = v
			case "startup.allocated":
				res.StartupAllocated = v
			case "replication.backlog":
				res.ReplicaBuf = v
			case "aof.buffer":
				res.AofBufferTotal = v
			case "keys.count":
				res.KeysCount = v
			case "clients.normal", "clients.slaves":
				res.ClientsTotal += v
			case "overhead.total":
				res.OverheadTotal = v
			default:
				res.Extra[key] = strconv.FormatInt(v, 10)
			}
		case string:
			res.Extra[key] = v
		case float64:
			if key == "fragmentation" {
				res.FragRatio = v
			} else {
				res.Extra[key] = strconv.FormatFloat(v, 'f', -1, 64)
			}
		default:
			// nested arrays — los serializamos resumidamente
			res.Extra[key] = fmt.Sprintf("%v", v)
		}
	}
	return res, nil
}
