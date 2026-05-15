import React, { useState } from 'react';
import {
  Activity, ChevronLeft, Database, Edit3, Plus,
  Terminal, Trash2, Wifi, WifiOff, Zap,
} from 'lucide-react';
import { Header, IconButton, Modal, Panel, RefreshMeta, Skeleton, bytes, round, useLoad } from '../lib/ui';

const DB_REFRESH_MS  = 30_000;
const LIVE_REFRESH_MS = 12_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function statusBadge(t) {
  if (t.last_ok == null) return <span className="db-badge db-badge-unknown">Sin datos</span>;
  return t.last_ok
    ? <span className="db-badge db-badge-ok">OK</span>
    : <span className="db-badge db-badge-err">Error</span>;
}

function typeIcon(type) {
  return type === 'redis'
    ? <span className="db-type-pill db-type-redis">Redis</span>
    : <span className="db-type-pill db-type-postgres">PostgreSQL</span>;
}

function cacheColor(ratio) {
  if (ratio == null) return 'var(--text-muted)';
  if (ratio >= 0.95) return 'var(--green)';
  if (ratio >= 0.8)  return 'var(--amber)';
  return 'var(--red)';
}

function hitRate(hits, misses) {
  const h = hits ?? 0, m = misses ?? 0;
  if (h + m === 0) return null;
  return h / (h + m);
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDuration(ms) {
  if (ms < 1000)        return `< 1s`;
  if (ms < 60_000)      return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000)   return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function relativeTime(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000)    return 'hace <1m';
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)}m`;
  return `hace ${Math.floor(diff / 3_600_000)}h`;
}

function xidColor(age) {
  if (age > 1_500_000_000) return '#ef4444';
  if (age > 500_000_000)   return '#f59e0b';
  return '#22c55e';
}

// ── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ values = [], width = 72, height = 22, color = '#3b82f6' }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = (height - 2) - ((v - min) / range) * (height - 4) + 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <span className="db-sparkline-wrap" title={`Último: ${values[values.length - 1]}`}>
      <svg width={width} height={height} className="db-sparkline">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      <span className="db-sparkline-last">{values[values.length - 1]}</span>
    </span>
  );
}

// ── LineChart ────────────────────────────────────────────────────────────────

function LineChart({ samples, field, color = '#3b82f6', label = '', scale = 1, suffix = '' }) {
  const pts = [...samples].reverse()
    .map(s => ({ v: s[field] != null ? s[field] * scale : null, t: s.captured_at }))
    .filter(d => d.v != null);

  if (pts.length < 2) {
    return <div className="db-chart-empty">Sin datos suficientes para graficar</div>;
  }

  const W = 500, H = 100;
  const pl = 34, pr = 6, pt = 6, pb = 18;
  const iw = W - pl - pr, ih = H - pt - pb;
  const vals  = pts.map(d => d.v);
  const min   = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const cx = i => pl + (i / (pts.length - 1)) * iw;
  const cy = v => pt + ih - ((v - min) / range) * ih;
  const line = pts.map((d, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${cy(d.v).toFixed(1)}`).join(' ');
  const area = `${line} L${cx(pts.length - 1).toFixed(1)},${(pt + ih).toFixed(1)} L${pl},${(pt + ih).toFixed(1)} Z`;
  const gradId = `dbg-${field}`;
  const yTicks = [0, 0.5, 1].map(f => {
    const v = min + f * range;
    const label = suffix === '%' ? `${v.toFixed(1)}%` : `${Math.round(v)}${suffix}`;
    return { label, y: cy(v) };
  });
  const xIdx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="db-line-chart" aria-label={label}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.18"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {yTicks.map(({ y }, i) => (
        <line key={i} x1={pl} y1={y} x2={W - pr} y2={y} stroke="#e2e8f0" strokeWidth="0.5" strokeDasharray="3,2"/>
      ))}
      <path d={area} fill={`url(#${gradId})`}/>
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      {pts.length <= 30 && pts.map((d, i) => (
        <circle key={i} cx={cx(i)} cy={cy(d.v)} r="2" fill={color} opacity="0.7"/>
      ))}
      {yTicks.map(({ label, y }, i) => (
        <text key={i} x={pl - 3} y={y + 3.5} textAnchor="end" fontSize="9" fill="#94a3b8">{label}</text>
      ))}
      {xIdx.map(i => pts[i] && (
        <text key={i} x={cx(i)} y={H - 1}
          textAnchor={i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}
          fontSize="9" fill="#94a3b8">
          {new Date(pts[i].t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </text>
      ))}
    </svg>
  );
}

// ── Section label ─────────────────────────────────────────────────────────────

function SectionLabel({ label }) {
  return <div className="db-section-label"><span>{label}</span></div>;
}

// ── ConnBar ──────────────────────────────────────────────────────────────────

function ConnBar({ active = 0, idle = 0, waiting = 0, total }) {
  const tot  = total || (active + idle + waiting) || 1;
  const pctA = Math.round((active  / tot) * 100);
  const pctI = Math.round((idle    / tot) * 100);
  const pctW = Math.round((waiting / tot) * 100);
  return (
    <div className="db-connbar-wrap">
      <div className="db-conn-bar">
        <div className="db-conn-seg seg-active"  style={{ width: `${pctA}%` }} title={`Activas: ${active}`}/>
        <div className="db-conn-seg seg-idle"    style={{ width: `${pctI}%` }} title={`Idle: ${idle}`}/>
        <div className="db-conn-seg seg-waiting" style={{ width: `${pctW}%` }} title={`Esperando: ${waiting}`}/>
      </div>
      <div className="db-conn-legend">
        <span><span className="dot dot-active"/>Activas <b>{active}</b></span>
        <span><span className="dot dot-idle"/>Idle <b>{idle}</b></span>
        {waiting > 0 && <span><span className="dot dot-waiting"/>Esperando <b>{waiting}</b></span>}
        <span className="db-conn-total">Total <b>{tot}</b></span>
      </div>
    </div>
  );
}

// ── MemBar ───────────────────────────────────────────────────────────────────

function MemBar({ used, max }) {
  if (used == null) return <span className="db-na">—</span>;
  if (!max) return <span>{bytes(used)}</span>;
  const pct   = Math.min(100, Math.round((used / max) * 100));
  const color = pct > 90 ? '#ef4444' : pct > 75 ? '#f59e0b' : '#22c55e';
  return (
    <div className="db-membar-wrap">
      <div className="db-conn-bar">
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width .3s' }}/>
      </div>
      <small className="db-membar-label">{bytes(used)} / {bytes(max)} ({pct}%)</small>
    </div>
  );
}

// ── MetricsCard ───────────────────────────────────────────────────────────────

function MetricsCard({ target, sample }) {
  if (!sample) {
    if (target.last_ok === false) {
      return (
        <div className="db-metrics-empty db-metrics-err">
          <WifiOff size={16}/> <span>{target.last_error || 'Error de conexión'}</span>
        </div>
      );
    }
    return <div className="db-metrics-empty"><Activity size={14}/> Esperando primera muestra…</div>;
  }
  if (!sample.ok) {
    return (
      <div className="db-metrics-empty db-metrics-err">
        <WifiOff size={16}/> {sample.error_message || 'Error de conexión'}
      </div>
    );
  }

  if (target.type === 'redis') {
    const hr = hitRate(sample.keyspace_hits, sample.keyspace_misses);
    return (
      <div className="db-metrics-grid">
        <div className="db-metric-tile"><span>Memoria</span>
          <MemBar used={sample.memory_used_bytes} max={sample.memory_max_bytes}/></div>
        <div className="db-metric-tile"><span>Clientes</span>
          <strong>{sample.connected_clients ?? '—'}</strong></div>
        <div className="db-metric-tile"><span>Ops/s</span>
          <strong>{sample.ops_per_sec != null ? round(sample.ops_per_sec) : '—'}</strong></div>
        <div className="db-metric-tile"><span>Hit rate</span>
          <strong style={{ color: hr != null ? cacheColor(hr) : undefined }}>
            {hr != null ? `${Math.round(hr * 100)}%` : '—'}
          </strong></div>
      </div>
    );
  }

  const cacheRatio = sample.cache_hit_ratio;
  return (
    <div className="db-pg-metrics">
      {sample.connections_total != null && (
        <ConnBar active={sample.connections_active ?? 0} idle={sample.connections_idle ?? 0}
          waiting={sample.connections_waiting ?? 0} total={sample.connections_total}/>
      )}
      <div className="db-metrics-grid">
        <div className="db-metric-tile"><span>Tamaño BD</span>
          <strong>{sample.db_size_bytes != null ? bytes(sample.db_size_bytes) : '—'}</strong></div>
        <div className="db-metric-tile"><span>Cache hit</span>
          <strong style={{ color: cacheColor(cacheRatio) }}>
            {cacheRatio != null ? `${Math.round(cacheRatio * 100)}%` : '—'}
          </strong></div>
        <div className="db-metric-tile"><span>Slow queries</span>
          <strong style={{ color: (sample.slow_queries ?? 0) > 0 ? 'var(--red)' : undefined }}>
            {sample.slow_queries ?? '—'}
          </strong></div>
        <div className="db-metric-tile"><span>Locks espera</span>
          <strong style={{ color: (sample.active_locks ?? 0) > 0 ? 'var(--amber)' : undefined }}>
            {sample.active_locks ?? '—'}
          </strong></div>
        {sample.transactions_committed != null && (
          <div className="db-metric-tile"><span>Commits</span>
            <strong>{Number(sample.transactions_committed).toLocaleString()}</strong></div>
        )}
        {sample.transactions_rolled_back != null && (
          <div className="db-metric-tile"><span>Rollbacks</span>
            <strong style={{ color: (sample.transactions_rolled_back ?? 0) > 0 ? 'var(--amber)' : undefined }}>
              {Number(sample.transactions_rolled_back).toLocaleString()}
            </strong></div>
        )}
      </div>
    </div>
  );
}

// ── PGInfoPanel (extended) ────────────────────────────────────────────────────

function PGInfoPanel({ api, targetId }) {
  const { data, loading } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/info`),
    [targetId],
    30_000,
  );
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener info del servidor</div>;

  const xidPct   = Math.min(100, Math.round((data.xid_age / 2_000_000_000) * 100));
  const xidCol   = xidColor(data.xid_age);
  const oldestMs = data.oldest_xact_ms || 0;
  const oldestCol = oldestMs > 1_800_000 ? '#ef4444' : oldestMs > 60_000 ? '#f59e0b' : '#22c55e';
  const totalCp  = (data.checkpoints?.timed ?? 0) + (data.checkpoints?.requested ?? 0);
  const forcedPct = totalCp > 0 ? Math.round(((data.checkpoints?.requested ?? 0) / totalCp) * 100) : 0;

  return (
    <div>
      {/* Core info */}
      <div className="db-info-grid">
        <div className="db-info-item"><span>Versión</span><strong>{data.version || '—'}</strong></div>
        <div className="db-info-item"><span>Base de datos</span><strong>{data.db_name || '—'}</strong></div>
        <div className="db-info-item"><span>Uptime</span><strong>{formatUptime(data.uptime_seconds)}</strong></div>
        <div className="db-info-item"><span>Máx. conexiones</span><strong>{data.max_connections || '—'}</strong></div>
      </div>

      {/* XID wraparound */}
      {data.xid_age > 0 && (
        <div className="db-info-section">
          <div className="db-info-section-title">Wraparound XID</div>
          <div className="db-xid-wrap">
            <div className="db-conn-bar" style={{ height: 8 }}>
              <div style={{ width: `${Math.max(xidPct, 1)}%`, height: '100%', background: xidCol, borderRadius: 3 }}/>
            </div>
            <div className="db-xid-legend">
              <small style={{ color: xidCol, fontWeight: 600 }}>
                {(data.xid_age / 1_000_000).toFixed(1)}M XIDs — {xidPct}%
              </small>
              <small style={{ color: 'var(--text-muted)' }}>Límite: 2,000M</small>
              {data.xid_age > 1_500_000_000 && (
                <span className="db-warn-chip">⚠ Crítico — vacuuming urgente</span>
              )}
              {data.xid_age > 500_000_000 && data.xid_age <= 1_500_000_000 && (
                <span className="db-warn-chip db-warn-amber">⚠ Monitorear</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Oldest transaction */}
      {oldestMs > 0 && (
        <div className="db-info-section">
          <div className="db-info-section-title">Transacción más antigua abierta</div>
          <span style={{ fontWeight: 700, color: oldestCol, fontSize: 15 }}>
            {formatDuration(oldestMs)}
          </span>
          {oldestMs > 1_800_000 && (
            <span className="db-warn-chip" style={{ marginLeft: 8 }}>⚠ Puede bloquear VACUUM</span>
          )}
          {oldestMs > 60_000 && oldestMs <= 1_800_000 && (
            <span className="db-warn-chip db-warn-amber" style={{ marginLeft: 8 }}>⚠ Transacción larga</span>
          )}
        </div>
      )}

      {/* Checkpoint stats */}
      {totalCp > 0 && (
        <div className="db-info-section">
          <div className="db-info-section-title">Checkpoints</div>
          <div className="db-cp-grid">
            <div className="db-info-item"><span>Por tiempo</span><strong>{data.checkpoints.timed.toLocaleString()}</strong></div>
            <div className="db-info-item"><span>Forzados</span>
              <strong style={{ color: forcedPct > 10 ? '#f59e0b' : undefined }}>
                {data.checkpoints.requested.toLocaleString()}
                {forcedPct > 10 && <small style={{ fontSize: 11, marginLeft: 4 }}>({forcedPct}%)</small>}
              </strong>
            </div>
            <div className="db-info-item"><span>Buffers backend</span><strong>{data.checkpoints.buffers_backend.toLocaleString()}</strong></div>
          </div>
          {forcedPct > 10 && (
            <div className="db-hint">Muchos checkpoints forzados — considera aumentar <code>max_wal_size</code></div>
          )}
        </div>
      )}

      {/* Sequences near overflow */}
      {data.sequences?.length > 0 && (
        <div className="db-info-section">
          <div className="db-info-section-title">Sequences por encima del 50%</div>
          <div className="db-seq-list">
            {data.sequences.map((s, i) => {
              const col = s.pct_used > 90 ? '#ef4444' : s.pct_used > 75 ? '#f59e0b' : '#f59e0b';
              return (
                <div key={i} className="db-seq-row">
                  <span className="db-seq-name">
                    {s.schema !== 'public' && <span className="db-schema-pill">{s.schema}</span>}
                    {s.name}
                  </span>
                  <div className="db-dbsize-bar-wrap" style={{ flex: 1 }}>
                    <div className="db-dbsize-bar" style={{ width: `${s.pct_used}%`, background: col }}/>
                  </div>
                  <span style={{ fontWeight: 700, color: col, fontSize: 12, minWidth: 40, textAlign: 'right' }}>
                    {s.pct_used}%
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top databases */}
      {data.databases?.length > 0 && (
        <div className="db-info-section">
          <div className="db-info-section-title">Bases de datos en el servidor</div>
          <div className="db-dbsize-list">
            {data.databases.map((db, i) => {
              const maxB = data.databases[0].bytes || 1;
              const pct  = Math.round((db.bytes / maxB) * 100);
              return (
                <div key={i} className="db-dbsize-row">
                  <span className="db-dbsize-name">{db.name}</span>
                  <div className="db-dbsize-bar-wrap">
                    <div className="db-dbsize-bar" style={{ width: `${Math.max(pct, 2)}%` }}/>
                  </div>
                  <span className="db-dbsize-bytes">{bytes(db.bytes)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ActiveQueriesPanel ────────────────────────────────────────────────────────

const SESSION_CATS = {
  active:   { label: 'En ejecución',         bg: '#dcfce7', fg: '#15803d' },
  opentx:   { label: 'Transacciones abiertas', bg: '#fef3c7', fg: '#92400e' },
  aborted:  { label: 'Tx abortadas',          bg: '#fee2e2', fg: '#b91c1c' },
  idle:     { label: 'Inactivas',             bg: '#f1f5f9', fg: '#64748b' },
  other:    { label: 'Otros',                 bg: '#ede9fe', fg: '#7c3aed' },
};

function catOf(state) {
  if (state === 'active')                        return 'active';
  if (state === 'idle in transaction')           return 'opentx';
  if (state === 'idle in transaction (aborted)') return 'aborted';
  if (state === 'idle')                          return 'idle';
  return 'other';
}

function SessionRow({ q, variant }) {
  const cat = catOf(q.state);
  const { bg, fg } = SESSION_CATS[cat];

  const pidCell  = <td className="db-col-pid">{q.pid}</td>;
  const dbCell   = <td className="db-col-app" style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{q.database || <span className="db-na">—</span>}</td>;
  const userCell = <td className="db-col-app">{q.user_name || <span className="db-na">—</span>}</td>;
  const ipCell   = <td className="db-col-app" style={{ fontFamily: 'monospace', fontSize: 11 }}>{q.client_addr || <span className="db-na">local</span>}</td>;
  const appCell  = <td className="db-col-app">{q.app_name || <span className="db-na">—</span>}</td>;
  const ageCell  = (
    <td className="db-col-dur" style={{ color: q.backend_age_ms > 3_600_000 ? '#f59e0b' : undefined }}>
      {formatDuration(q.backend_age_ms)}
    </td>
  );
  const waitCell = <td className="db-col-wait">{q.wait_event || <span className="db-na">—</span>}</td>;

  if (variant === 'idle') {
    return (
      <tr key={q.pid}>
        {pidCell}{dbCell}{userCell}{ipCell}{appCell}
        <td><span className="db-qstate" style={{ background: bg, color: fg }}>{q.state}</span></td>
        {ageCell}
      </tr>
    );
  }

  if (variant === 'opentx') {
    const longOpen = q.backend_age_ms > 60_000;
    return (
      <tr key={q.pid} className={longOpen ? 'db-row-slow' : ''}>
        {pidCell}{dbCell}{userCell}{ipCell}{appCell}
        <td><span className="db-qstate" style={{ background: bg, color: fg }}>{q.state}</span></td>
        <td className={longOpen ? 'db-col-dur db-col-dur-slow' : 'db-col-dur'}>{formatDuration(q.backend_age_ms)}</td>
        {waitCell}
        <td className="db-col-query" title={q.query}>{q.query || <span className="db-na">—</span>}</td>
      </tr>
    );
  }

  // active / other
  const slow = q.duration_ms > 5000;
  return (
    <tr key={q.pid} className={slow ? 'db-row-slow' : ''}>
      {pidCell}{dbCell}{userCell}{ipCell}{appCell}
      <td className={slow ? 'db-col-dur db-col-dur-slow' : 'db-col-dur'}>{formatDuration(q.duration_ms)}</td>
      {ageCell}
      {waitCell}
      <td className="db-col-query" title={q.query}>{q.query}</td>
    </tr>
  );
}

function SessionSection({ catKey, sessions }) {
  const { label, fg } = SESSION_CATS[catKey];
  const variant = (catKey === 'idle') ? 'idle' : (catKey === 'opentx' || catKey === 'aborted') ? 'opentx' : 'active';
  return (
    <div style={{ marginTop: 16 }}>
      <div className="db-section-label" style={{ color: fg }}>{label} ({sessions.length})</div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead>
            {variant === 'idle' ? (
              <tr><th>PID</th><th>BD</th><th>Usuario</th><th>Cliente</th><th>App</th><th>Estado</th><th>Edad sesión</th></tr>
            ) : variant === 'opentx' ? (
              <tr><th>PID</th><th>BD</th><th>Usuario</th><th>Cliente</th><th>App</th><th>Estado</th><th>Tiempo abierta</th><th>Wait</th><th>Último query</th></tr>
            ) : (
              <tr><th>PID</th><th>BD</th><th>Usuario</th><th>Cliente</th><th>App</th><th>Dur. query</th><th>Edad sesión</th><th>Wait</th><th>Query</th></tr>
            )}
          </thead>
          <tbody>
            {sessions.map(q => <SessionRow key={q.pid} q={q} variant={variant}/>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActiveQueriesPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/active-queries`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const [hideIdle, setHideIdle] = useState(false);
  const all = data?.queries || [];

  const cats = { active: [], opentx: [], aborted: [], idle: [], other: [] };
  all.forEach(q => cats[catOf(q.state)].push(q));

  const toggle = (
    <label className="db-toggle" style={{ gap: 6 }}>
      <input type="checkbox" checked={hideIdle} onChange={e => setHideIdle(e.target.checked)}/>
      <span className="db-toggle-track"><span className="db-toggle-thumb"/></span>
      <span className="db-toggle-label" style={{ fontSize: 12, fontWeight: 500 }}>Ocultar inactivas</span>
    </label>
  );

  if (loading && !data) return <Panel title="Sesiones" action={toggle}><Skeleton/></Panel>;

  const nonIdle = cats.active.length + cats.opentx.length + cats.aborted.length + cats.other.length;

  return (
    <Panel
      title="Sesiones"
      action={<div style={{ display:'flex', alignItems:'center', gap:10 }}>{toggle}<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/></div>}
    >
      {/* Summary bar */}
      <div className="db-sessions-summary">
        {Object.entries(cats).map(([key, list]) => {
          if (list.length === 0) return null;
          const { label, bg, fg } = SESSION_CATS[key];
          return (
            <span key={key} className="db-sessions-state-chip" style={{ background: bg, color: fg }}>
              {label} <strong>{list.length}</strong>
            </span>
          );
        })}
        <span className="db-sessions-total">Total: {all.length}</span>
      </div>

      {all.length === 0 && (
        <div className="db-live-empty" style={{ marginTop: 8 }}>
          <Terminal size={14}/>Sin sesiones abiertas en este momento
        </div>
      )}

      {/* Sections in priority order */}
      {cats.active.length  > 0 && <SessionSection catKey="active"  sessions={cats.active}/>}
      {cats.opentx.length  > 0 && <SessionSection catKey="opentx"  sessions={cats.opentx}/>}
      {cats.aborted.length > 0 && <SessionSection catKey="aborted" sessions={cats.aborted}/>}
      {cats.other.length   > 0 && <SessionSection catKey="other"   sessions={cats.other}/>}
      {!hideIdle && cats.idle.length > 0 && <SessionSection catKey="idle" sessions={cats.idle}/>}
      {hideIdle && nonIdle === 0 && (
        <div className="db-live-empty" style={{ marginTop: 8 }}>
          <Terminal size={14}/>Sin queries activas — {cats.idle.length} conexiones inactivas ocultas
        </div>
      )}
    </Panel>
  );
}

// ── TableSizesPanel ───────────────────────────────────────────────────────────

function TableSizesPanel({ api, targetId }) {
  const { data, loading } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/table-sizes`),
    [targetId],
    60_000,
  );
  const tables  = data?.tables || [];
  const maxBytes = tables[0]?.total_bytes || 1;
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo cargar tamaños de tablas</div>;
  return (
    <div className="db-tblsize-wrap">
      <table className="db-live-table">
        <thead><tr><th>Tabla</th><th>Total</th><th>Distribución</th><th>Índices</th></tr></thead>
        <tbody>
          {tables.map((t, i) => {
            const pctTotal = Math.round((t.total_bytes / maxBytes) * 100);
            const pctIdx   = t.total_bytes > 0 ? Math.round((t.index_bytes / t.total_bytes) * 100) : 0;
            return (
              <tr key={i}>
                <td className="db-col-tbl">
                  {t.schema !== 'public' && <span className="db-schema-pill">{t.schema}</span>}
                  {t.table}
                </td>
                <td className="db-col-bytes">{bytes(t.total_bytes)}</td>
                <td className="db-col-bar">
                  <div className="db-tblbar-wrap">
                    <div className="db-tblbar-fill" style={{ width: `${Math.max(pctTotal, 1)}%` }}>
                      <div className="db-tblbar-idx" style={{ width: `${pctIdx}%` }}/>
                    </div>
                  </div>
                </td>
                <td className="db-col-idx">{bytes(t.index_bytes)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="db-tblsize-legend">
        <span><i className="db-legend-dot" style={{ background: '#3b82f6' }}/>Datos</span>
        <span><i className="db-legend-dot" style={{ background: '#93c5fd' }}/>Índices</span>
      </div>
    </div>
  );
}

// ── VacuumStatsPanel ──────────────────────────────────────────────────────────

function VacuumStatsPanel({ api, targetId }) {
  const { data, loading } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/vacuum-stats`),
    [targetId],
    60_000,
  );
  const tables = data?.tables || [];
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener estadísticas de vacuum</div>;
  if (tables.length === 0) return <div className="db-live-empty">Sin tablas con datos de vacuum</div>;

  return (
    <div className="db-live-table-wrap">
      <table className="db-live-table">
        <thead><tr>
          <th>Tabla</th><th>Filas vivas</th><th>Muertas</th><th>Bloat %</th>
          <th>Último vacuum</th><th>Último analyze</th><th>Vacuums</th>
        </tr></thead>
        <tbody>
          {tables.map((t, i) => {
            const bloatHigh = t.bloat_pct > 20;
            const bloatMed  = t.bloat_pct > 10 && !bloatHigh;
            return (
              <tr key={i} className={bloatHigh ? 'db-row-bloat-high' : bloatMed ? 'db-row-bloat-med' : ''}>
                <td className="db-col-tbl">
                  {t.schema !== 'public' && <span className="db-schema-pill">{t.schema}</span>}
                  {t.table}
                </td>
                <td className="db-col-bytes">{t.live_tuples.toLocaleString()}</td>
                <td className="db-col-bytes" style={{ color: t.dead_tuples > 0 ? '#f59e0b' : undefined }}>
                  {t.dead_tuples.toLocaleString()}
                </td>
                <td>
                  <span style={{
                    fontWeight: 700,
                    color: bloatHigh ? '#ef4444' : bloatMed ? '#f59e0b' : '#64748b',
                  }}>
                    {t.bloat_pct.toFixed(1)}%
                  </span>
                </td>
                <td className="db-col-time">{t.last_vacuum || <span className="db-na">Nunca</span>}</td>
                <td className="db-col-time">{t.last_analyze || <span className="db-na">Nunca</span>}</td>
                <td className="db-col-pid">{t.vacuum_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="db-tblsize-legend">
        <span><i className="db-legend-dot" style={{ background: '#fef3c7', border: '1px solid #fbbf24' }}/>Bloat moderado (&gt;10%)</span>
        <span><i className="db-legend-dot" style={{ background: '#fee2e2', border: '1px solid #fca5a5' }}/>Bloat alto (&gt;20%)</span>
      </div>
    </div>
  );
}

// ── IndexUsagePanel ───────────────────────────────────────────────────────────

function IndexUsagePanel({ api, targetId }) {
  const { data, loading } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/index-usage`),
    [targetId],
    120_000,
  );
  const indexes = data?.indexes || [];
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener uso de índices</div>;
  if (indexes.length === 0) return <div className="db-live-empty">Sin índices para mostrar</div>;

  return (
    <div className="db-live-table-wrap">
      <table className="db-live-table">
        <thead><tr>
          <th>Índice</th><th>Tabla</th><th>Scans</th><th>Tamaño</th><th>Tipo</th>
        </tr></thead>
        <tbody>
          {indexes.map((idx, i) => {
            const unused = idx.scans === 0;
            return (
              <tr key={i} className={unused && idx.size_bytes > 0 ? 'db-row-unused' : ''}>
                <td className="db-col-tbl" style={{ maxWidth: 200 }}>
                  {idx.index}
                  {unused && idx.size_bytes > 10240 && (
                    <span className="db-unused-badge">sin uso</span>
                  )}
                </td>
                <td className="db-col-app">
                  {idx.schema !== 'public' && <span className="db-schema-pill">{idx.schema}</span>}
                  {idx.table}
                </td>
                <td className="db-col-pid" style={{ fontWeight: unused ? 700 : undefined, color: unused ? '#94a3b8' : undefined }}>
                  {idx.scans.toLocaleString()}
                </td>
                <td className="db-col-bytes">{bytes(idx.size_bytes)}</td>
                <td>
                  {idx.is_unique
                    ? <span className="db-idx-type-unique">UNIQUE</span>
                    : <span className="db-idx-type-plain">INDEX</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="db-hint">Índices sin scans y con tamaño significativo son candidatos a eliminarse.</div>
    </div>
  );
}

// ── SlowQueriesPanel ──────────────────────────────────────────────────────────

function SlowQueriesPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/slow-queries`),
    [targetId],
    60_000,
  );
  const queries = data?.queries || [];
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo consultar pg_stat_statements</div>;
  if (queries.length === 0) {
    return (
      <div className="db-live-empty" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
        <span>Sin datos — pg_stat_statements puede no estar habilitado.</span>
        <code className="db-hint-code">CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</code>
        <span className="db-hint">Luego reinicia la conexión o espera el próximo ciclo de polling.</span>
      </div>
    );
  }

  return (
    <div>
      <div className="db-live-head">
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead><tr>
            <th>Query</th><th>Calls</th><th>Total</th><th>Media</th><th>Máx</th><th>Cache hit</th>
          </tr></thead>
          <tbody>
            {queries.map((q, i) => (
              <tr key={i}>
                <td className="db-col-query" title={q.query}>{q.query}</td>
                <td className="db-col-pid">{q.calls.toLocaleString()}</td>
                <td className="db-col-dur">{formatDuration(Math.round(q.total_ms))}</td>
                <td className="db-col-dur" style={{ color: q.mean_ms > 1000 ? '#f59e0b' : undefined }}>
                  {formatDuration(Math.round(q.mean_ms))}
                </td>
                <td className="db-col-dur" style={{ color: q.max_ms > 5000 ? '#ef4444' : undefined }}>
                  {formatDuration(Math.round(q.max_ms))}
                </td>
                <td style={{ color: q.cache_hit_pct < 80 ? '#ef4444' : q.cache_hit_pct < 95 ? '#f59e0b' : '#22c55e', fontWeight: 600, fontSize: 12 }}>
                  {q.cache_hit_pct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── RedisLivePanel ────────────────────────────────────────────────────────────

function RedisLivePanel({ api, targetId }) {
  const { data, loading } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/redis-live`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener info de Redis</div>;

  const fragColor = data.frag_ratio > 2 ? '#ef4444' : data.frag_ratio > 1.5 ? '#f59e0b' : '#22c55e';

  return (
    <div>
      <div className="db-metrics-grid">
        <div className="db-metric-tile">
          <span>Fragmentación</span>
          <strong style={{ color: fragColor }}>
            {data.frag_ratio > 0 ? data.frag_ratio.toFixed(2) : '—'}
          </strong>
        </div>
        <div className="db-metric-tile">
          <span>Evicted keys</span>
          <strong style={{ color: data.evicted_keys > 0 ? '#ef4444' : undefined }}>
            {data.evicted_keys.toLocaleString()}
          </strong>
        </div>
        <div className="db-metric-tile">
          <span>Expired keys</span>
          <strong>{data.expired_keys.toLocaleString()}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Clientes bloq.</span>
          <strong style={{ color: data.blocked_clients > 0 ? '#f59e0b' : undefined }}>
            {data.blocked_clients}
          </strong>
        </div>
        <div className="db-metric-tile">
          <span>Uptime</span>
          <strong>{formatUptime(data.uptime_seconds)}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Rol</span>
          <strong>{data.role || '—'}</strong>
        </div>
      </div>
      {data.evicted_keys > 0 && (
        <div className="db-hint" style={{ marginTop: 10, color: '#b91c1c' }}>
          ⚠ Se están eviccionando keys — considera aumentar <code>maxmemory</code>
        </div>
      )}
      {data.keyspace?.length > 0 && (
        <div className="db-info-section" style={{ marginTop: 12 }}>
          <div className="db-info-section-title">Keyspace</div>
          <div className="db-live-table-wrap">
            <table className="db-live-table">
              <thead><tr><th>DB</th><th>Keys</th><th>Con expiración</th></tr></thead>
              <tbody>
                {data.keyspace.sort((a, b) => a.db.localeCompare(b.db)).map((ks, i) => (
                  <tr key={i}>
                    <td className="db-col-pid">{ks.db}</td>
                    <td className="db-col-bytes">{ks.keys.toLocaleString()}</td>
                    <td className="db-col-bytes">{ks.expires.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ReplicationPanel ──────────────────────────────────────────────────────────

function ReplicationPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/replication`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const replicas = data?.replicas || [];
  if (loading && !data) return <Skeleton/>;

  if (!replicas.length) {
    return (
      <div className="db-live-empty">
        <Zap size={14}/>
        <span>Sin standbys activos — este servidor es standalone o read replica.</span>
      </div>
    );
  }

  const syncColor = (s) => s === 'sync' ? '#22c55e' : s === 'async' ? '#3b82f6' : '#94a3b8';

  return (
    <div>
      <div className="db-live-head">
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead><tr>
            <th>Réplica</th><th>Dirección</th><th>Estado</th><th>Sync</th>
            <th>Sent lag</th><th>Apply lag</th>
          </tr></thead>
          <tbody>
            {replicas.map((r, i) => (
              <tr key={i} className={r.apply_lag_kb > 1024 ? 'db-row-slow' : ''}>
                <td><strong style={{ fontSize: 13 }}>{r.app_name || '—'}</strong></td>
                <td className="db-col-pid">{r.client_addr || '—'}</td>
                <td>
                  <span className="db-qstate" style={{
                    background: r.state === 'streaming' ? '#dcfce7' : '#fef3c7',
                    color:      r.state === 'streaming' ? '#15803d' : '#92400e',
                  }}>{r.state || '—'}</span>
                </td>
                <td>
                  <span style={{ fontWeight: 700, fontSize: 12, color: syncColor(r.sync_state) }}>
                    {r.sync_state || '—'}
                  </span>
                </td>
                <td className="db-col-bytes">
                  {r.sent_lag_kb > 0
                    ? <span style={{ color: r.sent_lag_kb > 1024 ? '#f59e0b' : undefined }}>{r.sent_lag_kb.toLocaleString()} KB</span>
                    : <span style={{ color: '#22c55e' }}>0</span>
                  }
                </td>
                <td className="db-col-bytes">
                  {r.apply_lag_kb > 0
                    ? <span style={{ color: r.apply_lag_kb > 1024 ? '#ef4444' : '#f59e0b' }}>{r.apply_lag_kb.toLocaleString()} KB</span>
                    : <span style={{ color: '#22c55e' }}>0</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TargetModal (con test de conexión) ────────────────────────────────────────

const EMPTY = { name: '', type: 'postgres', dsn: '', params: {}, enabled: true, poll_interval_seconds: 60 };

function TargetModal({ api, initial, onSave, onClose, saving, error }) {
  const [form, setForm]       = useState(initial || EMPTY);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const set      = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTestResult(null); };
  const setParam = (k, v) => setForm(f => ({ ...f, params: { ...f.params, [k]: v } }));
  const isNew    = !initial?.id;

  async function testConn() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post('/api/db-targets/test', {
        type: form.type, dsn: form.dsn, params: form.params || {},
      });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal title={isNew ? 'Agregar base de datos' : 'Editar base de datos'} onClose={onClose}>
      <div className="db-form">

        <div className="db-form-field">
          <span className="db-form-label">Tipo de base de datos</span>
          <div className="db-type-selector">
            <button type="button" className={`db-type-btn${form.type === 'postgres' ? ' active-pg' : ''}`}
              onClick={() => set('type', 'postgres')}>
              <span className="db-type-icon pg">PG</span>PostgreSQL
            </button>
            <button type="button" className={`db-type-btn${form.type === 'redis' ? ' active-rd' : ''}`}
              onClick={() => set('type', 'redis')}>
              <span className="db-type-icon rd">R</span>Redis
            </button>
          </div>
        </div>

        <div className="db-form-field">
          <label className="db-form-label" htmlFor="db-f-name">Nombre</label>
          <input id="db-f-name" className="db-form-input" value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder={form.type === 'postgres' ? 'Ej: Producción PostgreSQL' : 'Ej: Redis caché'}
            autoFocus/>
        </div>

        {form.type === 'postgres' ? (
          <div className="db-form-field">
            <label className="db-form-label" htmlFor="db-f-dsn">
              URL de conexión
              <span className="db-form-optional"> — incluye credenciales en la URL</span>
            </label>
            <input id="db-f-dsn" className="db-form-input db-form-mono" value={form.dsn}
              onChange={e => set('dsn', e.target.value)}
              placeholder="postgres://usuario:contraseña@host:5432/nombre_bd"
              autoComplete="off" spellCheck={false}/>
          </div>
        ) : (
          <>
            <div className="db-form-field">
              <label className="db-form-label" htmlFor="db-f-addr">Dirección</label>
              <input id="db-f-addr" className="db-form-input db-form-mono" value={form.dsn}
                onChange={e => set('dsn', e.target.value)} placeholder="localhost:6379"/>
            </div>
            <div className="db-form-field">
              <label className="db-form-label" htmlFor="db-f-pass">
                Contraseña <span className="db-form-optional">— opcional</span>
              </label>
              <input id="db-f-pass" type="password" className="db-form-input"
                value={form.params?.password || ''} onChange={e => setParam('password', e.target.value)}
                autoComplete="new-password" placeholder="Sin contraseña"/>
            </div>
          </>
        )}

        {/* Test connection */}
        <div className="db-form-test-row">
          <button type="button" className="db-form-test-btn" onClick={testConn}
            disabled={testing || !form.dsn}>
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
          {testResult && (
            <span className={`db-test-result${testResult.ok ? ' ok' : ' err'}`}>
              {testResult.ok
                ? `✓ Conectado en ${testResult.duration_ms}ms`
                : `✗ ${testResult.error}`}
            </span>
          )}
        </div>

        <div className="db-form-row2">
          <div className="db-form-field">
            <label className="db-form-label" htmlFor="db-f-interval">Intervalo de polling</label>
            <div className="db-form-with-unit">
              <input id="db-f-interval" type="number" className="db-form-input"
                min={15} max={3600} value={form.poll_interval_seconds}
                onChange={e => set('poll_interval_seconds', parseInt(e.target.value) || 60)}/>
              <span className="db-form-unit">segundos</span>
            </div>
          </div>
          <div className="db-form-field">
            <span className="db-form-label">Estado</span>
            <label className="db-toggle">
              <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)}/>
              <span className="db-toggle-track"><span className="db-toggle-thumb"/></span>
              <span className="db-toggle-label">{form.enabled ? 'Habilitado' : 'Desactivado'}</span>
            </label>
          </div>
        </div>
      </div>

      {error && <div className="status-msg err" style={{ marginBottom: 0 }}>{error}</div>}

      <div className="db-form-actions">
        <button className="db-form-btn" type="button" onClick={onClose}>Cancelar</button>
        <button className="db-form-btn db-form-btn-primary" type="button"
          onClick={() => onSave(form)} disabled={saving || !form.name || !form.dsn}>
          {saving ? 'Guardando…' : isNew ? 'Agregar base de datos' : 'Guardar cambios'}
        </button>
      </div>
    </Modal>
  );
}

// ── TargetDetail ──────────────────────────────────────────────────────────────

function TargetDetail({ api, target, onEdit, onDelete, onBack }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${target.id}/metrics?limit=60`),
    [target.id],
    DB_REFRESH_MS,
  );
  const [tab, setTab] = useState('resumen');
  const samples = data?.samples || [];
  const latest  = samples[0] || null;
  const isPG    = target.type === 'postgres';

  // Tabs disponibles según el tipo
  const pgTabs  = ['resumen', 'en-vivo', 'servidor', 'almacenamiento', 'diagnostico', 'historial'];
  const rdTabs  = ['resumen', 'en-vivo', 'historial'];
  const tabs    = isPG ? pgTabs : rdTabs;

  const tabLabels = {
    'resumen':        'Resumen',
    'en-vivo':        'En vivo',
    'servidor':       'Servidor',
    'almacenamiento': 'Almacenamiento',
    'diagnostico':    'Diagnóstico',
    'historial':      'Historial',
  };

  return (
    <div className="db-detail">

      {/* ── Header ── */}
      <div className="db-detail-head">
        <button className="db-back-btn" type="button" onClick={onBack}>
          <ChevronLeft size={15}/> Volver
        </button>
        <Database size={17} style={{ color: isPG ? '#2563eb' : '#dc2626', flexShrink: 0 }}/>
        <strong className="db-detail-name">{target.name}</strong>
        {typeIcon(target.type)}
        {statusBadge(target)}
        {!target.enabled && <span className="db-badge db-badge-disabled">Desactivado</span>}
        <span className="db-detail-actions">
          <IconButton icon={Edit3} label="Editar" onClick={onEdit}/>
          <IconButton icon={Trash2} label="Eliminar" onClick={onDelete}/>
          <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
        </span>
      </div>

      {/* ── Tabs ── */}
      <div className="tab-row">
        {tabs.map(t => (
          <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {/* ══ RESUMEN ══ */}
      {tab === 'resumen' && (
        <div className="db-tab-content">
          <Panel title="Métricas actuales">
            {loading && !latest ? <Skeleton/> : <MetricsCard target={target} sample={latest}/>}
          </Panel>
          {samples.length >= 3 && (
            <Panel title={isPG ? 'Conexiones en el tiempo' : 'Clientes en el tiempo'}>
              <LineChart samples={samples} field={isPG ? 'connections_total' : 'connected_clients'}
                color={isPG ? '#3b82f6' : '#ef4444'}
                label={isPG ? 'Conexiones totales' : 'Clientes conectados'}/>
            </Panel>
          )}
          {isPG && samples.length >= 3 && (
            <Panel title="Cache hit ratio (% bloques servidos desde memoria)">
              <LineChart samples={samples} field="cache_hit_ratio"
                color="#22c55e" label="Cache hit ratio" scale={100} suffix="%"/>
            </Panel>
          )}
        </div>
      )}

      {/* ══ EN VIVO ══ */}
      {tab === 'en-vivo' && (
        <div className="db-tab-content">
          {isPG ? (
            <ActiveQueriesPanel api={api} targetId={target.id}/>
          ) : (
            <Panel title="Info Redis en vivo">
              <RedisLivePanel api={api} targetId={target.id}/>
            </Panel>
          )}
        </div>
      )}

      {/* ══ SERVIDOR (PG) ══ */}
      {tab === 'servidor' && isPG && (
        <div className="db-tab-content">
          <Panel title="Información del servidor">
            <PGInfoPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="Replicación">
            <ReplicationPanel api={api} targetId={target.id}/>
          </Panel>
        </div>
      )}

      {/* ══ ALMACENAMIENTO (PG) ══ */}
      {tab === 'almacenamiento' && isPG && (
        <div className="db-tab-content">
          <Panel title="Tamaño por tabla">
            <TableSizesPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="Vacuum / Bloat">
            <VacuumStatsPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="Uso de índices">
            <IndexUsagePanel api={api} targetId={target.id}/>
          </Panel>
        </div>
      )}

      {/* ══ DIAGNÓSTICO (PG) ══ */}
      {tab === 'diagnostico' && isPG && (
        <div className="db-tab-content">
          <Panel title="Queries más lentas (pg_stat_statements)">
            <SlowQueriesPanel api={api} targetId={target.id}/>
          </Panel>
        </div>
      )}

      {/* ══ HISTORIAL ══ */}
      {tab === 'historial' && (
        <div className="db-tab-content">
          <div className="db-hint" style={{ marginBottom: 4 }}>
            Cada fila es una <strong>muestra de polling</strong> — el monitor conecta a la BD, mide sus métricas y las guarda.
            {' '}<strong>Conexión OK</strong> = logró conectar y recopilar métricas.
            {' '}<strong>Error</strong> = falló la conexión o hubo un error al consultar (hover para ver el mensaje).
          </div>
          {samples.length < 2 ? (
            <div className="db-live-empty"><span>Sin muestras históricas aún — el monitor pollea cada {target.poll_interval_seconds}s.</span></div>
          ) : (
            <Panel title={`Últimas ${Math.min(samples.length, 30)} muestras (polling cada ${target.poll_interval_seconds}s)`}>
              <div className="db-history-table">
                <table>
                  <thead>
                    <tr>
                      <th title="Momento en que se tomó la muestra">Hora captura</th>
                      {isPG ? (
                        <>
                          <th title="Total de conexiones abiertas al momento del poll">Conexiones</th>
                          <th title="Tamaño total de la base de datos">Tamaño BD</th>
                          <th title="% de bloques leídos desde caché (ideal: >95%)">Cache hit</th>
                          <th title="Queries activas con duración >5s al momento del poll">Queries lentas</th>
                          <th title="Locks en espera (waiting)">Locks wait</th>
                        </>
                      ) : (
                        <>
                          <th title="Clientes conectados al momento del poll">Clientes</th>
                          <th title="Memoria usada por Redis">Memoria</th>
                          <th title="Operaciones por segundo">Ops/s</th>
                          <th title="Ratio de hits en keyspace (keyspace_hits / total)">Hit rate</th>
                        </>
                      )}
                      <th title="Si el monitor pudo conectar y recopilar métricas correctamente">Conexión</th>
                    </tr>
                  </thead>
                  <tbody>
                    {samples.slice(0, 30).map(s => (
                      <tr key={s.id} className={!s.ok ? 'db-row-err' : ''}>
                        <td className="db-col-time">
                          <span title={new Date(s.captured_at).toLocaleString()}>
                            {new Date(s.captured_at).toLocaleTimeString()}
                          </span>
                        </td>
                        {isPG ? (
                          <>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {s.connections_total != null
                                ? <span title={`Activas: ${s.connections_active ?? '?'} | Idle: ${s.connections_idle ?? '?'} | Esperando: ${s.connections_waiting ?? '?'}`}>
                                    {s.connections_total}
                                  </span>
                                : <span className="db-na">—</span>}
                            </td>
                            <td>{s.db_size_bytes != null ? bytes(s.db_size_bytes) : <span className="db-na">—</span>}</td>
                            <td style={{ color: cacheColor(s.cache_hit_ratio), fontWeight: s.cache_hit_ratio != null && s.cache_hit_ratio < 0.8 ? 700 : undefined }}>
                              {s.cache_hit_ratio != null
                                ? `${Math.round(s.cache_hit_ratio * 100)}%`
                                : <span className="db-na">—</span>}
                            </td>
                            <td style={{ color: (s.slow_queries ?? 0) > 0 ? '#b91c1c' : '#15803d', fontWeight: (s.slow_queries ?? 0) > 0 ? 700 : undefined }}>
                              {s.slow_queries ?? <span className="db-na">—</span>}
                            </td>
                            <td style={{ color: (s.active_locks ?? 0) > 0 ? '#f59e0b' : undefined }}>
                              {s.active_locks ?? <span className="db-na">—</span>}
                            </td>
                          </>
                        ) : (
                          <>
                            <td>{s.connected_clients ?? <span className="db-na">—</span>}</td>
                            <td>{s.memory_used_bytes != null ? bytes(s.memory_used_bytes) : <span className="db-na">—</span>}</td>
                            <td>{s.ops_per_sec != null ? round(s.ops_per_sec) : <span className="db-na">—</span>}</td>
                            <td style={{ color: cacheColor(hitRate(s.keyspace_hits, s.keyspace_misses)) }}>
                              {(() => {
                                const hr = hitRate(s.keyspace_hits, s.keyspace_misses);
                                return hr != null ? `${Math.round(hr * 100)}%` : <span className="db-na">—</span>;
                              })()}
                            </td>
                          </>
                        )}
                        <td>
                          {s.ok
                            ? <span className="db-status-ok">✓ OK</span>
                            : <span className="db-status-err" title={s.error_message || 'Error de conexión'}>
                                ✗ {s.error_message ? s.error_message.slice(0, 40) + (s.error_message.length > 40 ? '…' : '') : 'Error'}
                              </span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function DatabasesView({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get('/api/db-targets'),
    [],
    DB_REFRESH_MS,
  );
  const [selected, setSelected]         = useState(null);
  const [modal, setModal]               = useState(null);
  const [saving, setSaving]             = useState(false);
  const [saveError, setSaveError]       = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);

  const targets = data?.targets || [];

  async function save(form) {
    setSaving(true);
    setSaveError('');
    try {
      if (modal?.id) {
        await api.put(`/api/db-targets/${modal.id}`, form);
        if (selected?.id === modal.id) setSelected(s => ({ ...s, ...form }));
      } else {
        await api.post('/api/db-targets', form);
      }
      setModal(null);
      reload();
    } catch (e) {
      setSaveError(e.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    try {
      await api.delete(`/api/db-targets/${id}`);
      setConfirmDelete(null);
      if (selected?.id === id) setSelected(null);
      reload();
    } catch (e) {
      alert(e.message);
    }
  }

  async function pollNow() {
    try {
      await api.post('/api/db-targets/poll', {});
      setTimeout(reload, 2500);
    } catch (_) {}
  }

  const openModal = t => { setSaveError(''); setModal(t); };
  const openAdd   = ()  => { setSaveError(''); setModal('add'); };

  // ── Detail view ──
  if (selected) {
    return (
      <>
        <TargetDetail api={api} target={selected}
          onEdit={() => openModal(selected)}
          onDelete={() => setConfirmDelete(selected.id)}
          onBack={() => setSelected(null)}/>
        {modal && (
          <TargetModal api={api} initial={modal === 'add' ? null : modal}
            onSave={save} onClose={() => setModal(null)} saving={saving} error={saveError}/>
        )}
        {confirmDelete && (
          <Modal title="Eliminar base de datos" onClose={() => setConfirmDelete(null)}>
            <p style={{ marginBottom: 16 }}>
              ¿Eliminar <strong>{targets.find(t => t.id === confirmDelete)?.name || 'este monitor'}</strong>?
              Se borrarán todas las muestras históricas.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setConfirmDelete(null)}>Cancelar</button>
              <button type="button" className="primary"
                style={{ background: 'var(--red)', borderColor: 'var(--red)', color: 'white' }}
                onClick={() => remove(confirmDelete)}>Eliminar</button>
            </div>
          </Modal>
        )}
      </>
    );
  }

  // ── List view ──
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Header title="Bases de datos"
        meta={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>}/>

      <Panel
        title={`${targets.length} base${targets.length !== 1 ? 's' : ''} configurada${targets.length !== 1 ? 's' : ''}`}
        action={
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="db-action-btn" type="button" onClick={pollNow}>
              <Zap size={14}/> Poll ahora
            </button>
            <button className="db-action-btn primary" type="button" onClick={openAdd}>
              <Plus size={14}/> Agregar
            </button>
          </span>
        }
      >
        {loading && targets.length === 0 ? <Skeleton/> : targets.length === 0 ? (
          <div className="db-empty">
            <Database size={40}/>
            <strong>Sin bases de datos configuradas</strong>
            <span>Agrega una conexión para comenzar a monitorear</span>
            <button className="db-action-btn primary" type="button" onClick={openAdd}>
              <Plus size={14}/> Agregar base de datos
            </button>
          </div>
        ) : (
          <div className="db-target-list">
            {targets.map(t => {
              const statusKey = !t.enabled ? 'disabled'
                : t.last_ok === true ? 'ok'
                : t.last_ok === false ? 'err'
                : 'unknown';
              const rel = relativeTime(t.last_sample_at);
              return (
                <div key={t.id}
                  className={`db-target-card db-card-${statusKey}`}
                  onClick={() => setSelected(t)}
                  role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && setSelected(t)}>

                  <div className="db-target-card-header">
                    <div className="db-card-id">
                      <Database size={15} style={{ color: t.type === 'redis' ? '#dc2626' : '#2563eb', flexShrink: 0 }}/>
                      <strong>{t.name}</strong>
                      {typeIcon(t.type)}
                      {statusBadge(t)}
                      {!t.enabled && <span className="db-badge db-badge-disabled">Desactivado</span>}
                    </div>
                    <div className="db-card-right" onClick={e => e.stopPropagation()}>
                      {t.sparkline?.length >= 2 && (
                        <Sparkline values={t.sparkline} color={t.type === 'redis' ? '#ef4444' : '#3b82f6'}/>
                      )}
                      <IconButton icon={Edit3} label="Editar" onClick={() => openModal(t)}/>
                      <IconButton icon={Trash2} label="Eliminar" onClick={() => setConfirmDelete(t.id)}/>
                    </div>
                  </div>

                  <div className="db-target-card-dsn">
                    {t.type === 'redis' ? <Wifi size={11}/> : <Activity size={11}/>}
                    <span>{t.dsn}</span>
                    <span className="db-card-meta">
                      {rel && <span className="db-card-updated">{rel}</span>}
                      <span className="db-poll-chip">{t.poll_interval_seconds}s</span>
                    </span>
                  </div>

                  {t.last_ok === false && (
                    <div className="db-target-card-error">
                      <WifiOff size={13}/> {t.last_error || 'Error de conexión'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {(modal === 'add' || (modal && modal.id)) && (
        <TargetModal api={api} initial={modal === 'add' ? null : modal}
          onSave={save} onClose={() => setModal(null)} saving={saving} error={saveError}/>
      )}

      {confirmDelete && (
        <Modal title="Eliminar base de datos" onClose={() => setConfirmDelete(null)}>
          <p style={{ marginBottom: 16 }}>
            ¿Eliminar <strong>{targets.find(t => t.id === confirmDelete)?.name || 'este monitor'}</strong>?
            Se borrarán todas las muestras históricas.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setConfirmDelete(null)}>Cancelar</button>
            <button type="button" className="primary"
              style={{ background: 'var(--red)', borderColor: 'var(--red)', color: 'white' }}
              onClick={() => remove(confirmDelete)}>Eliminar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
