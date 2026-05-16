import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ChevronLeft, Database, Edit3, HelpCircle, Plus,
  Terminal, Trash2, Wifi, WifiOff, Zap,
} from 'lucide-react';
import { Drawer, Header, IconButton, Modal, Panel, RefreshMeta, Skeleton, bytes, round, useLoad } from '../lib/ui';

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
  switch (type) {
    case 'redis':   return <span className="db-type-pill db-type-redis">Redis</span>;
    case 'mysql':   return <span className="db-type-pill db-type-mysql">MySQL</span>;
    case 'mariadb': return <span className="db-type-pill db-type-mysql">MariaDB</span>;
    case 'sqlite':  return <span className="db-type-pill db-type-sqlite">SQLite</span>;
    case 'mongodb': return <span className="db-type-pill db-type-mongodb">MongoDB</span>;
    default:        return <span className="db-type-pill db-type-postgres">PostgreSQL</span>;
  }
}

const RELATIONAL_TYPES   = ['postgres', 'mysql', 'mariadb', 'sqlite'];
const KEYVALUE_TYPES     = ['redis'];
const DOCUMENT_TYPES     = ['mongodb'];
const SUPPORTED_DB_TYPES = [
  {
    value: 'postgres', label: 'PostgreSQL', icon: 'PG', tone: 'pg',
    minVersion: '13',  recommended: '14+',
    versionsHint: 'Versiones 10-12 funcionan con métricas reducidas (sin percentiles p50/p95/p99). Para 13+ se requiere extensión pg_stat_statements habilitada.',
    metrics: [
      'Conexiones activas/idle/waiting',
      'Tamaño de la BD y de cada tabla/índice',
      'Cache hit ratio (shared buffers)',
      'TPS (commits + rollbacks/s)',
      'Queries lentas activas + p50/p95/p99 históricos',
      'Deadlocks, locks en espera, locks bloqueantes',
      'Tuple stats (insert/update/delete/return)',
      'Temp files, WAL bytes, XID wraparound',
      'Replicación (lag, slots, estado)',
      'Tablas, índices y uso (índices sin scans)',
    ],
  },
  {
    value: 'mysql', label: 'MySQL', icon: 'MY', tone: 'my',
    minVersion: '5.6', recommended: '8.0+',
    versionsHint: 'Requiere usuario con privilegio PROCESS para Threads_*/Innodb_*. Para replicación: REPLICATION CLIENT.',
    metrics: [
      'Conexiones (Threads_connected/running) + max_connections',
      'TPS (Com_commit + Com_rollback)',
      'InnoDB buffer pool hit ratio',
      'InnoDB rows read/insert/update/delete',
      'Created_tmp_disk_tables (presión de queries pesadas)',
      'Slow_queries (contador del slow log)',
      'Innodb_row_lock_current_waits',
      'Tamaño total de la BD',
    ],
  },
  {
    value: 'mariadb', label: 'MariaDB', icon: 'MA', tone: 'my',
    minVersion: '10.0', recommended: '10.6+',
    versionsHint: 'Compatible con todas las queries de MySQL — usa el mismo driver y los mismos counters Innodb_*. Probado contra MariaDB 10.x.',
    metrics: [
      'Conexiones + max_connections',
      'TPS (commits/rollbacks)',
      'InnoDB buffer pool hit ratio',
      'InnoDB rows insert/update/delete/read',
      'Tmp tables a disco, slow queries',
      'Row locks en espera',
      'Tamaño total de la BD',
    ],
  },
  {
    value: 'sqlite', label: 'SQLite', icon: 'SQ', tone: 'sq',
    minVersion: '3.x', recommended: 'cualquiera',
    versionsHint: 'El archivo .db debe estar accesible al backend (montado vía volumen Docker). Lectura en modo read-only para no contaminar el WAL del target.',
    metrics: [
      'Tamaño en disco (archivo + WAL + SHM)',
      'Tamaño lógico (page_count × page_size)',
      'Free pages (PRAGMA freelist_count)',
      'Conteo de tablas',
      'Estado de conexión (ping)',
    ],
  },
  {
    value: 'redis', label: 'Redis', icon: 'R', tone: 'rd',
    minVersion: '4.0', recommended: '6+',
    versionsHint: 'MEMORY STATS requiere Redis 4.0+. En 2.x/3.x ese panel queda vacío pero el resto de métricas funcionan. Compatible con RESP2 y RESP3.',
    metrics: [
      'Memoria usada vs maxmemory',
      'Clientes conectados + lista detallada',
      'Ops/s, hit/miss ratio del keyspace',
      'SLOWLOG con duraciones y comandos',
      'CLIENT LIST (addr, idle, comando, flags)',
      'MEMORY STATS (frag ratio, overhead, buffers)',
      'Keys count por DB',
    ],
  },
  {
    value: 'mongodb', label: 'MongoDB', icon: 'MG', tone: 'mg',
    minVersion: '4.0', recommended: '6.0+',
    versionsHint: 'Soporta mongodb:// y mongodb+srv:// (Atlas). El usuario necesita rol clusterMonitor o readAnyDatabase para serverStatus/dbStats. WiredTiger 3.0+ para cache stats.',
    metrics: [
      'Conexiones (current/available)',
      'Tamaño de la base (dataSize)',
      'Opcounters: insert/update/delete/query (TPS derivado)',
      'WiredTiger cache hit estimado',
      'Memoria residente del proceso',
      'Cola global de locks',
      'Replica set status (perfil completo)',
    ],
  },
];

const MONITORING_PROFILES = [
  {
    value: 'basic',
    label: 'Básico',
    description: 'Solo conexión + tamaño de BD',
    detail: 'Mínimo impacto en el target. Útil para BDs muy cargadas o monitoreo agregado.',
    interval: 120,
  },
  {
    value: 'standard',
    label: 'Estándar',
    description: 'Métricas operativas (recomendado)',
    detail: 'Conexiones, cache hit, TPS, slow queries, tamaño. Balance entre cobertura y costo.',
    interval: 60,
  },
  {
    value: 'full',
    label: 'Completo',
    description: 'Análisis live + diagnóstico',
    detail: 'Todo lo anterior + locks bloqueantes, tuple stats, percentiles, replicación. Mayor frecuencia de polling.',
    interval: 30,
  },
];

function isRelational(type) { return RELATIONAL_TYPES.includes(type); }
function isKeyValue(type)   { return KEYVALUE_TYPES.includes(type); }

function dbTypeColor(type) {
  switch (type) {
    case 'redis':   return '#dc2626';
    case 'mysql':   return '#0891b2';
    case 'mariadb': return '#a16207';
    case 'sqlite':  return '#7c3aed';
    case 'mongodb': return '#16a34a';
    default:        return '#2563eb';
  }
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

function fmtTimeShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Enriquece samples con metricas derivadas (TPS, % conexiones, deltas de contadores
// acumulativos). samples llega ordenado DESC (mas reciente primero); se procesa en
// orden cronologico ASC para que los deltas tomen sentido.
function enrichSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return samples;
  const asc = [...samples].reverse();
  const out = [];
  let prev = null;
  for (const s of asc) {
    const e = { ...s };
    if (prev) {
      const dt = (new Date(s.captured_at) - new Date(prev.captured_at)) / 1000;
      if (dt > 0) {
        if (s.transactions_committed != null && prev.transactions_committed != null &&
            s.transactions_rolled_back != null && prev.transactions_rolled_back != null) {
          const totalNow  = Number(s.transactions_committed) + Number(s.transactions_rolled_back);
          const totalPrev = Number(prev.transactions_committed) + Number(prev.transactions_rolled_back);
          if (totalNow >= totalPrev) e._tps = (totalNow - totalPrev) / dt;
          const rb = Number(s.transactions_rolled_back) - Number(prev.transactions_rolled_back);
          const tot = totalNow - totalPrev;
          if (tot > 0 && rb >= 0) e._rollback_pct = (rb / tot) * 100;
        }
        if (s.deadlocks != null && prev.deadlocks != null) {
          const d = Number(s.deadlocks) - Number(prev.deadlocks);
          if (d >= 0) e._deadlocks_delta = d;
        }
        if (s.wal_bytes != null && prev.wal_bytes != null) {
          const w = Number(s.wal_bytes) - Number(prev.wal_bytes);
          if (w >= 0) e._wal_rate = w / dt;
        }
      }
    }
    if (s.connections_total != null && s.max_connections != null && s.max_connections > 0) {
      e._conn_pct = (Number(s.connections_total) / Number(s.max_connections)) * 100;
    }
    out.push(e);
    prev = s;
  }
  return out.reverse(); // volver a DESC para que el resto del codigo no cambie
}

// monotone cubic spline — devuelve un path SVG suavizado a partir de puntos {x, y}.
// Evita oscilaciones (overshoot) que sí tendrían splines naturales/Catmull-Rom.
function monotonePath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const n = pts.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i+1].x - pts[i].x;
    dy[i] = pts[i+1].y - pts[i].y;
    m[i] = dy[i] / (dx[i] || 1);
  }
  const tan = new Array(n).fill(0);
  tan[0] = m[0];
  tan[n-1] = m[n-2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i-1] * m[i] <= 0) tan[i] = 0;
    else tan[i] = (m[i-1] + m[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { tan[i] = 0; tan[i+1] = 0; }
    else {
      const a = tan[i] / m[i], b = tan[i+1] / m[i];
      const h = a*a + b*b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        tan[i] = t * a * m[i];
        tan[i+1] = t * b * m[i];
      }
    }
  }
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const dxi = (pts[i+1].x - pts[i].x) / 3;
    const x1 = pts[i].x + dxi;
    const y1 = pts[i].y + dxi * tan[i];
    const x2 = pts[i+1].x - dxi;
    const y2 = pts[i+1].y - dxi * tan[i+1];
    d += ` C${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)} ${pts[i+1].x.toFixed(2)},${pts[i+1].y.toFixed(2)}`;
  }
  return d;
}

function fmtNum(v, suffix) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (suffix === '%' || suffix === ' %') return `${v.toFixed(1)}%`;
  if (abs >= 1e6) return `${(v/1e6).toFixed(2)}M${suffix || ''}`;
  if (abs >= 1e4) return `${Math.round(v/1000)}k${suffix || ''}`;
  if (abs >= 100) return `${Math.round(v)}${suffix || ''}`;
  if (abs >= 10)  return `${v.toFixed(1)}${suffix || ''}`;
  return `${v.toFixed(2)}${suffix || ''}`;
}

function LineChart({ samples, field, color = '#3b82f6', label = '', scale = 1, suffix = '', height = 140, area = true, smooth = true }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const gradientId = useMemo(
    () => `lc-grad-${field}-${Math.random().toString(36).slice(2, 8)}`,
    [field],
  );

  const points = useMemo(
    () => [...samples].reverse()
      .map(s => ({ v: s[field] != null ? Number(s[field]) * scale : null, t: s.captured_at }))
      .filter(d => d.v != null),
    [samples, field, scale]
  );

  const { yMin, range, current, delta, deltaPct, peak } = useMemo(() => {
    if (points.length === 0) return { yMin: 0, range: 1, current: null, delta: 0, deltaPct: 0, peak: 0 };
    const vals = points.map(p => p.v);
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const span = mx - mn;
    const pad = span === 0 ? Math.max(1, Math.abs(mx) * 0.1) : span * 0.15;
    const cur = vals[vals.length - 1];
    const first = vals[0];
    const d = cur - first;
    const dp = first !== 0 ? (d / Math.abs(first)) * 100 : 0;
    return { yMin: mn - pad, range: (mx + pad) - (mn - pad) || 1, current: cur, delta: d, deltaPct: dp, peak: mx };
  }, [points]);

  // Coordenadas en viewBox 100x52 (8..48 utilizable verticalmente)
  const coords = useMemo(() => {
    if (points.length === 0) return [];
    const maxI = Math.max(points.length - 1, 1);
    return points.map((p, i) => ({
      x: (i / maxI) * 100,
      y: 48 - ((p.v - yMin) / range) * 40,
      v: p.v,
      t: p.t,
    }));
  }, [points, yMin, range]);

  const linePath = useMemo(
    () => smooth ? monotonePath(coords) : coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(''),
    [coords, smooth],
  );

  const areaPath = useMemo(() => {
    if (!area || coords.length < 2) return '';
    return `${linePath} L${coords[coords.length-1].x.toFixed(2)},48 L${coords[0].x.toFixed(2)},48 Z`;
  }, [linePath, coords, area]);

  const yTicks = useMemo(
    () => [1, 0.5, 0].map(r => fmtNum(yMin + range * r, suffix)),
    [yMin, range, suffix]
  );

  const xTicks = useMemo(() => {
    if (points.length === 0) return [];
    const maxI = Math.max(points.length - 1, 1);
    return [0, 0.5, 1].map(r => points[Math.round(r * maxI)]?.t).filter(Boolean).map(fmtTimeShort);
  }, [points]);

  if (points.length < 2) {
    return <div className="empty-chart">Sin historial disponible</div>;
  }

  const activePoint = hoverIndex === null ? null : coords[hoverIndex];
  const setHover = (e) => {
    const b = e.currentTarget.getBoundingClientRect();
    const r = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
    setHoverIndex(Math.round(r * (coords.length - 1)));
  };

  const trendUp = delta > 0;
  const trendColor = Math.abs(deltaPct) < 1 ? '#94a3b8' : trendUp ? '#16a34a' : '#dc2626';
  const trendArrow = Math.abs(deltaPct) < 1 ? '→' : trendUp ? '▲' : '▼';

  return (
    <div className="lc-shell" style={{ '--lc-color': color }}>
      <div className="lc-head">
        <div className="lc-label">
          <i style={{ background: color }} />
          <span>{label}</span>
        </div>
        <div className="lc-stats">
          <strong>{fmtNum(current, suffix)}</strong>
          <span className="lc-delta" style={{ color: trendColor }}>
            {trendArrow} {fmtNum(Math.abs(delta), suffix)}
            {Math.abs(deltaPct) >= 1 && ` (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(0)}%)`}
          </span>
        </div>
      </div>
      <div className="lc-frame">
        <div className="lc-yaxis">{yTicks.map((t, i) => <span key={i}>{t}</span>)}</div>
        <div className="lc-plot" style={{ height }} onMouseMove={setHover} onMouseLeave={() => setHoverIndex(null)}>
          <svg className="lc-svg" viewBox="0 0 100 52" preserveAspectRatio="none">
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={color} stopOpacity="0.32"/>
                <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
              </linearGradient>
            </defs>
            {/* grid lines */}
            <path className="lc-grid" d="M0 8 H100 M0 28 H100 M0 48 H100"/>
            {area && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none"/>}
            <path className="lc-line" d={linePath} style={{ stroke: color }}/>
            {activePoint && (
              <>
                <line className="lc-cursor" x1={activePoint.x} x2={activePoint.x} y1="8" y2="48"/>
                <circle cx={activePoint.x} cy={activePoint.y} r="1.6" style={{ fill: color, stroke: 'white', strokeWidth: 0.6 }}/>
              </>
            )}
          </svg>
          {activePoint && (
            <div className="lc-tip" style={{ left: `${Math.min(Math.max(activePoint.x, 14), 86)}%` }}>
              <strong>{fmtTimeShort(activePoint.t)}</strong>
              <span style={{ color }}>{fmtNum(activePoint.v, suffix)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="lc-xaxis">{xTicks.map((t, i) => <span key={i}>{t}</span>)}</div>
    </div>
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
        {sample._tps != null && (
          <div className="db-metric-tile"><span>TPS</span>
            <strong>{round(sample._tps)}/s</strong></div>
        )}
        {sample._conn_pct != null && (
          <div className="db-metric-tile" title={`Total: ${sample.connections_total} de ${sample.max_connections}`}>
            <span>% Pool</span>
            <strong style={{ color: sample._conn_pct > 85 ? 'var(--red)' : sample._conn_pct > 70 ? 'var(--amber)' : undefined }}>
              {Math.round(sample._conn_pct)}%
            </strong>
          </div>
        )}
        {sample.slow_query_p95_ms != null && (
          <div className="db-metric-tile" title="Percentil 95 de mean_exec_time en pg_stat_statements">
            <span>Latencia p95</span>
            <strong>{round(sample.slow_query_p95_ms)} ms</strong>
          </div>
        )}
        {sample.deadlocks != null && (
          <div className="db-metric-tile" title="Deadlocks acumulados desde el ultimo reset de pg_stat_database">
            <span>Deadlocks</span>
            <strong style={{ color: sample.deadlocks > 0 ? 'var(--red)' : undefined }}>
              {Number(sample.deadlocks).toLocaleString()}
            </strong>
          </div>
        )}
        {sample.temp_bytes != null && sample.temp_bytes > 0 && (
          <div className="db-metric-tile" title="Bytes temporales totales (queries que tocan disco)">
            <span>Temp bytes</span>
            <strong>{bytes(sample.temp_bytes)}</strong>
          </div>
        )}
        {sample.xid_age != null && (
          <div className="db-metric-tile" title="Edad de la transaccion mas vieja (max global). El wraparound ocurre cerca de 2.1B">
            <span>XID age</span>
            <strong style={{ color: xidColor(sample.xid_age) }}>
              {Number(sample.xid_age).toLocaleString()}
            </strong>
          </div>
        )}
        {sample.wal_bytes != null && (
          <div className="db-metric-tile" title="WAL bytes acumulados desde el startup del servidor">
            <span>WAL total</span>
            <strong>{bytes(sample.wal_bytes)}</strong>
          </div>
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
  const [search, setSearch] = useState('');
  const tables  = data?.tables || [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return tables;
    return tables.filter(t => `${t.schema}.${t.table}`.toLowerCase().includes(term));
  }, [tables, search]);
  const maxBytes = tables[0]?.total_bytes || 1;
  const onExportCSV = () => {
    const rows = [
      ['schema', 'table', 'total_bytes', 'index_bytes'],
      ...filtered.map(t => [t.schema, t.table, t.total_bytes, t.index_bytes]),
    ];
    downloadCSV(rows, `table-sizes-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo cargar tamaños de tablas</div>;
  return (
    <div className="db-tblsize-wrap">
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input
          type="search"
          placeholder="Filtrar por nombre…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#64748b' }}>{filtered.length} / {tables.length}</span>
        <button type="button" onClick={onExportCSV} disabled={filtered.length === 0}
          style={{ padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer' }}>
          Exportar CSV
        </button>
      </div>
      <table className="db-live-table">
        <thead><tr><th>Tabla</th><th>Total</th><th>Distribución</th><th>Índices</th></tr></thead>
        <tbody>
          {filtered.map((t, i) => {
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
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('scans');
  const [sortDir, setSortDir] = useState('asc'); // asc para ver primero los sin uso

  const sortBy = (key) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'scans' ? 'asc' : 'desc'); }
  };
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return indexes;
    return indexes.filter(idx => `${idx.schema}.${idx.table}.${idx.index}`.toLowerCase().includes(term));
  }, [indexes, search]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? (av - bv) : (bv - av);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);
  const onExportCSV = () => {
    const rows = [
      ['schema', 'table', 'index', 'scans', 'size_bytes', 'is_unique'],
      ...sorted.map(idx => [idx.schema, idx.table, idx.index, idx.scans, idx.size_bytes, idx.is_unique]),
    ];
    downloadCSV(rows, `index-usage-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };

  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener uso de índices</div>;
  if (indexes.length === 0) return <div className="db-live-empty">Sin índices para mostrar</div>;

  return (
    <div className="db-live-table-wrap">
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input
          type="search"
          placeholder="Filtrar índice/tabla…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#64748b' }}>{sorted.length} / {indexes.length}</span>
        <button type="button" onClick={onExportCSV} disabled={sorted.length === 0}
          style={{ padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer' }}>
          Exportar CSV
        </button>
      </div>
      <table className="db-live-table">
        <thead><tr>
          <SortHeader label="Índice"  sortKey="index"      currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Tabla"   sortKey="table"      currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Scans"   sortKey="scans"      currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Tamaño"  sortKey="size_bytes" currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <th>Tipo</th>
        </tr></thead>
        <tbody>
          {sorted.map((idx, i) => {
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

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, title }) {
  const active = sortKey === currentKey;
  return (
    <th onClick={() => onSort(sortKey)} title={title || `Ordenar por ${label}`}
        style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
      {label}
      <span style={{ marginLeft: 4, color: active ? 'var(--accent, #3b82f6)' : '#94a3b8', fontSize: 10 }}>
        {active ? (currentDir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </th>
  );
}

function SlowQueriesPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/slow-queries`),
    [targetId],
    60_000,
  );
  const [search, setSearch]     = useState('');
  const [sortKey, setSortKey]   = useState('total_ms');
  const [sortDir, setSortDir]   = useState('desc');
  const [modalQuery, setModalQuery] = useState(null);

  const queries = data?.queries || [];

  const sortBy = (key) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return queries;
    return queries.filter(q => (q.query || '').toLowerCase().includes(term));
  }, [queries, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? (av - bv) : (bv - av);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const onExportCSV = () => {
    const header = ['query', 'calls', 'total_ms', 'mean_ms', 'max_ms', 'cache_hit_pct'];
    const rows = [header, ...sorted.map(q => [
      q.query, q.calls, q.total_ms, q.mean_ms, q.max_ms, q.cache_hit_pct,
    ])];
    downloadCSV(rows, `slow-queries-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };

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
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          placeholder="Buscar en queries…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: '1 1 220px', minWidth: 180, padding: '6px 10px',
            border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13,
          }}
        />
        <span style={{ fontSize: 12, color: '#64748b' }}>{sorted.length} / {queries.length}</span>
        <button type="button" onClick={onExportCSV}
          disabled={sorted.length === 0}
          style={{
            padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1',
            borderRadius: 6, background: 'white', cursor: 'pointer',
          }}>Exportar CSV</button>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead><tr>
            <SortHeader label="Query"     sortKey="query"         currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
            <SortHeader label="Calls"     sortKey="calls"         currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
            <SortHeader label="Total"     sortKey="total_ms"      currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
            <SortHeader label="Media"     sortKey="mean_ms"       currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
            <SortHeader label="Máx"       sortKey="max_ms"        currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
            <SortHeader label="Cache hit" sortKey="cache_hit_pct" currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          </tr></thead>
          <tbody>
            {sorted.map((q, i) => (
              <tr key={i}>
                <td className="db-col-query"
                    title="Click para ver query completa"
                    style={{ cursor: 'pointer', textDecoration: 'underline dotted #94a3b8' }}
                    onClick={() => setModalQuery(q)}>
                  {q.query}
                </td>
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
      {modalQuery && (
        <Modal title="Query completa" onClose={() => setModalQuery(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: '#475569' }}>
              <span>Calls: <strong>{modalQuery.calls.toLocaleString()}</strong></span>
              <span>Total: <strong>{formatDuration(Math.round(modalQuery.total_ms))}</strong></span>
              <span>Media: <strong>{formatDuration(Math.round(modalQuery.mean_ms))}</strong></span>
              <span>Máx: <strong>{formatDuration(Math.round(modalQuery.max_ms))}</strong></span>
              <span>Cache hit: <strong>{modalQuery.cache_hit_pct.toFixed(1)}%</strong></span>
            </div>
            <pre style={{
              background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 6,
              fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              maxHeight: '60vh', overflow: 'auto',
            }}>{modalQuery.query}</pre>
            <button type="button"
              onClick={() => { navigator.clipboard?.writeText(modalQuery.query); }}
              style={{
                alignSelf: 'flex-start', padding: '6px 12px', fontSize: 12,
                border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer',
              }}>Copiar query</button>
          </div>
        </Modal>
      )}
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

// ── RedisSlowlogPanel ─────────────────────────────────────────────────────────

function RedisSlowlogPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/redis-slowlog?limit=100`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const [search, setSearch] = useState('');
  const entries = data?.entries || [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter(e => `${e.command} ${e.client_addr || ''} ${e.client_name || ''}`.toLowerCase().includes(term));
  }, [entries, search]);
  const onExport = () => {
    const rows = [
      ['id', 'timestamp', 'duration_micro', 'command', 'client_addr', 'client_name'],
      ...filtered.map(e => [e.id, e.timestamp, e.duration_micro, e.command, e.client_addr, e.client_name]),
    ];
    downloadCSV(rows, `redis-slowlog-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener SLOWLOG (¿permisos / version Redis?)</div>;
  if (entries.length === 0) return <div className="db-live-empty">SLOWLOG vacío — sin comandos lentos registrados</div>;
  return (
    <div className="db-live-table-wrap">
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input type="search" placeholder="Filtrar comando…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}/>
        <span style={{ fontSize: 12, color: '#64748b' }}>{filtered.length} / {entries.length}</span>
        <button type="button" onClick={onExport} disabled={filtered.length === 0}
          style={{ padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer' }}>Exportar CSV</button>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <table className="db-live-table">
        <thead><tr>
          <th>ID</th><th>Hora</th><th>Duración</th><th>Comando</th><th>Cliente</th>
        </tr></thead>
        <tbody>
          {filtered.map((e, i) => (
            <tr key={i}>
              <td className="db-col-pid">{e.id}</td>
              <td className="db-col-time">{new Date(e.timestamp * 1000).toLocaleTimeString()}</td>
              <td className="db-col-dur" style={{ color: e.duration_micro > 100000 ? '#ef4444' : e.duration_micro > 10000 ? '#f59e0b' : undefined }}>
                {e.duration_micro >= 1000 ? `${(e.duration_micro / 1000).toFixed(1)} ms` : `${e.duration_micro} µs`}
              </td>
              <td className="db-col-query" title={e.command} style={{ fontFamily: 'monospace', fontSize: 12 }}>{e.command}</td>
              <td className="db-col-app">{e.client_addr || e.client_name || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── RedisClientsPanel ─────────────────────────────────────────────────────────

function RedisClientsPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/redis-clients`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('idle_sec');
  const [sortDir, setSortDir] = useState('desc');
  const clients = data?.clients || [];
  const sortBy = (k) => {
    if (k === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clients;
    return clients.filter(c => `${c.addr} ${c.name || ''} ${c.cmd || ''} ${c.flags || ''}`.toLowerCase().includes(term));
  }, [clients, search]);
  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0, bv = b[sortKey] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? (av - bv) : (bv - av);
    });
    return arr;
  }, [filtered, sortKey, sortDir]);
  const onExport = () => {
    const rows = [
      ['id', 'addr', 'name', 'age_sec', 'idle_sec', 'db', 'cmd', 'flags', 'sub_count'],
      ...sorted.map(c => [c.id, c.addr, c.name, c.age_sec, c.idle_sec, c.db, c.cmd, c.flags, c.sub_count]),
    ];
    downloadCSV(rows, `redis-clients-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener CLIENT LIST</div>;
  if (clients.length === 0) return <div className="db-live-empty">Sin clientes conectados</div>;
  return (
    <div className="db-live-table-wrap">
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <input type="search" placeholder="Filtrar (addr/name/cmd/flags)…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}/>
        <span style={{ fontSize: 12, color: '#64748b' }}>{sorted.length} / {clients.length}</span>
        <button type="button" onClick={onExport} disabled={sorted.length === 0}
          style={{ padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer' }}>Exportar CSV</button>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <table className="db-live-table">
        <thead><tr>
          <SortHeader label="ID"    sortKey="id"       currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Addr"  sortKey="addr"     currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Name"  sortKey="name"     currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Edad"  sortKey="age_sec"  currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Idle"  sortKey="idle_sec" currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="DB"    sortKey="db"       currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Cmd"   sortKey="cmd"      currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
          <SortHeader label="Flags" sortKey="flags"    currentKey={sortKey} currentDir={sortDir} onSort={sortBy}/>
        </tr></thead>
        <tbody>
          {sorted.map((c, i) => (
            <tr key={i}>
              <td className="db-col-pid">{c.id}</td>
              <td className="db-col-app" style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.addr}</td>
              <td>{c.name || <span className="db-na">—</span>}</td>
              <td className="db-col-pid">{c.age_sec}s</td>
              <td className="db-col-pid" style={{ color: c.idle_sec > 300 ? '#f59e0b' : undefined }}>{c.idle_sec}s</td>
              <td className="db-col-pid">{c.db}</td>
              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.cmd || <span className="db-na">—</span>}</td>
              <td style={{ fontSize: 11, color: '#64748b' }}>{c.flags || <span className="db-na">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── RedisMemoryPanel ──────────────────────────────────────────────────────────

function RedisMemoryPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/redis-memory`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo obtener MEMORY STATS</div>;
  return (
    <div>
      <div className="db-live-head" style={{ marginBottom: 8 }}>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div className="db-metrics-grid">
        <div className="db-metric-tile" title="Memoria total asignada por Redis">
          <span>Total allocated</span><strong>{bytes(data.total_allocated)}</strong>
        </div>
        <div className="db-metric-tile" title="Memoria base al iniciar (overhead del runtime)">
          <span>Startup allocated</span><strong>{bytes(data.startup_allocated)}</strong>
        </div>
        <div className="db-metric-tile" title="Overhead total: bookkeeping + buffers - datos">
          <span>Overhead</span><strong>{bytes(data.overhead_total)}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Keys count</span><strong>{Number(data.keys_count).toLocaleString()}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Buffers clientes</span><strong>{bytes(data.clients_total)}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Buffer AOF</span><strong>{bytes(data.aof_buffer_total)}</strong>
        </div>
        <div className="db-metric-tile">
          <span>Backlog replica</span><strong>{bytes(data.replica_buf)}</strong>
        </div>
        <div className="db-metric-tile" title="Ratio fragmentación RSS/used. Ideal: ~1.0. >1.5 fragmentado">
          <span>Fragmentación</span>
          <strong style={{ color: data.frag_ratio > 2 ? '#ef4444' : data.frag_ratio > 1.5 ? '#f59e0b' : '#22c55e' }}>
            {data.frag_ratio > 0 ? data.frag_ratio.toFixed(2) : '—'}
          </strong>
        </div>
      </div>
      {data.extra && Object.keys(data.extra).length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#64748b' }}>
            Otros campos MEMORY STATS ({Object.keys(data.extra).length})
          </summary>
          <div className="db-live-table-wrap" style={{ marginTop: 8 }}>
            <table className="db-live-table">
              <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
              <tbody>
                {Object.entries(data.extra).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{k}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

// ── BlockingLocksPanel ────────────────────────────────────────────────────────

function BlockingLocksPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/blocking-locks`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const locks = data?.locks || [];
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo cargar locks bloqueantes</div>;
  if (locks.length === 0) {
    return (
      <div className="db-live-empty" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }}/>
        Sin sesiones bloqueadas en este momento
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
    );
  }
  return (
    <div>
      <div className="db-live-head"><RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/></div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead><tr>
            <th>Bloqueada</th><th>Esperando</th><th>Tiempo</th>
            <th>Bloqueada por</th><th>Estado bloqueador</th><th>Lock</th><th>Relación</th>
          </tr></thead>
          <tbody>
            {locks.map((l, i) => (
              <tr key={i}>
                <td className="db-col-pid" title={`User: ${l.blocked_user || '—'} · App: ${l.blocked_app || '—'}`}>
                  PID {l.blocked_pid}
                </td>
                <td className="db-col-query" style={{ maxWidth: 280, fontFamily: 'monospace', fontSize: 11 }}
                    title={l.blocked_query}>{l.blocked_query}</td>
                <td className="db-col-dur" style={{ color: l.blocked_time_ms > 60000 ? '#dc2626' : '#f59e0b', fontWeight: 700 }}>
                  {formatDuration(Math.round(l.blocked_time_ms))}
                </td>
                <td className="db-col-pid" title={`User: ${l.blocking_user || '—'} · App: ${l.blocking_app || '—'}`}>
                  PID {l.blocking_pid}
                </td>
                <td>
                  <span className={`db-state-pill ${l.blocking_state === 'active' ? 'st-active' : 'st-idle'}`}>
                    {l.blocking_state || '—'}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: '#64748b' }}>{l.lock_type || '—'}</td>
                <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{l.relation || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TableIOPanel ──────────────────────────────────────────────────────────────

function TableIOPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/table-io`),
    [targetId],
    60_000,
  );
  const [search, setSearch] = useState('');
  const tables = data?.tables || [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return tables;
    return tables.filter(t => `${t.schema}.${t.table}`.toLowerCase().includes(term));
  }, [tables, search]);
  const onExport = () => {
    const rows = [
      ['schema', 'table', 'heap_read', 'heap_hit', 'idx_read', 'idx_hit', 'hit_ratio_pct'],
      ...filtered.map(t => [t.schema, t.table, t.heap_read, t.heap_hit, t.idx_read, t.idx_hit, t.hit_ratio_pct.toFixed(2)]),
    ];
    downloadCSV(rows, `table-io-${new Date().toISOString().slice(0,16).replace(':','-')}.csv`);
  };
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo cargar I/O por tabla</div>;
  if (tables.length === 0) return <div className="db-live-empty">Sin actividad I/O registrada</div>;
  return (
    <div>
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" placeholder="Filtrar tabla…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}/>
        <span style={{ fontSize: 12, color: '#64748b' }}>{filtered.length} / {tables.length}</span>
        <button type="button" onClick={onExport} disabled={filtered.length === 0}
          style={{ padding: '6px 12px', fontSize: 12, border: '1px solid #cbd5e1', borderRadius: 6, background: 'white', cursor: 'pointer' }}>
          Exportar CSV
        </button>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div className="db-live-table-wrap">
        <table className="db-live-table">
          <thead><tr>
            <th>Tabla</th>
            <th title="Bloques heap leídos del disco">Heap read</th>
            <th title="Bloques heap servidos desde caché">Heap hit</th>
            <th title="Bloques de índice leídos del disco">Idx read</th>
            <th title="Bloques de índice servidos desde caché">Idx hit</th>
            <th>Hit %</th>
          </tr></thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr key={i}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{t.schema}.{t.table}</td>
                <td className="db-col-pid" style={{ color: t.heap_read > 100000 ? '#f59e0b' : undefined }}>
                  {Number(t.heap_read).toLocaleString()}
                </td>
                <td className="db-col-pid">{Number(t.heap_hit).toLocaleString()}</td>
                <td className="db-col-pid">{Number(t.idx_read).toLocaleString()}</td>
                <td className="db-col-pid">{Number(t.idx_hit).toLocaleString()}</td>
                <td style={{ color: t.hit_ratio_pct < 90 ? '#dc2626' : t.hit_ratio_pct < 95 ? '#f59e0b' : '#22c55e', fontWeight: 700 }}>
                  {t.hit_ratio_pct.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── PGSettingsPanel ───────────────────────────────────────────────────────────

function PGSettingsPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/pg-settings`),
    [targetId],
    300_000,
  );
  const [search, setSearch] = useState('');
  const settings = data?.settings || [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return settings;
    return settings.filter(s => `${s.name} ${s.short_desc} ${s.category}`.toLowerCase().includes(term));
  }, [settings, search]);

  // Agrupar por category
  const grouped = useMemo(() => {
    const m = new Map();
    for (const s of filtered) {
      const cat = s.category || 'Otros';
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(s);
    }
    return Array.from(m.entries());
  }, [filtered]);

  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo leer pg_settings</div>;
  return (
    <div>
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="search" placeholder="Filtrar settings…" value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180, padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13 }}/>
        <span style={{ fontSize: 12, color: '#64748b' }}>{filtered.length} / {settings.length}</span>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {grouped.map(([cat, items]) => (
          <div key={cat}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>
              {cat}
            </div>
            <div className="db-live-table-wrap">
              <table className="db-live-table">
                <thead><tr><th>Setting</th><th>Valor</th><th>Descripción</th><th>Source</th></tr></thead>
                <tbody>
                  {items.map(s => (
                    <tr key={s.name}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.name}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {s.value}{s.unit ? ` ${s.unit}` : ''}
                      </td>
                      <td style={{ fontSize: 11, color: '#475569' }}>{s.short_desc || '—'}</td>
                      <td style={{ fontSize: 10, color: '#64748b' }}>{s.source || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── AutovacuumPanel ───────────────────────────────────────────────────────────

function AutovacuumPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/autovacuum`),
    [targetId],
    LIVE_REFRESH_MS,
  );
  const workers = data?.workers || [];
  if (loading && !data) return <Skeleton/>;
  if (!data) return <div className="db-live-err">No se pudo leer estado de autovacuum</div>;
  return (
    <div>
      <div className="db-live-head" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 13 }}>
          <strong>{workers.length}</strong> {workers.length === 1 ? 'worker corriendo' : 'workers corriendo'}
        </span>
        <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>
      </div>
      {workers.length === 0 ? (
        <div className="db-live-empty">Sin workers de autovacuum activos en este momento</div>
      ) : (
        <div className="db-live-table-wrap">
          <table className="db-live-table">
            <thead><tr><th>PID</th><th>Fase</th><th>Relación</th><th>Iniciado</th></tr></thead>
            <tbody>
              {workers.map((w, i) => (
                <tr key={i}>
                  <td className="db-col-pid">{w.pid}</td>
                  <td>{w.phase || '—'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{w.relation || '—'}</td>
                  <td style={{ fontSize: 11, color: '#64748b' }}>{w.started_at ? new Date(w.started_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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

function EngineDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = SUPPORTED_DB_TYPES.find(t => t.value === value) || SUPPORTED_DB_TYPES[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey   = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="db-engine-dd" ref={ref}>
      <button type="button" className="db-engine-dd-trigger"
        onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className={`db-type-icon ${current.tone}`}>{current.icon}</span>
        <span className="db-engine-dd-label">{current.label}</span>
        <span className="db-engine-dd-version">v{current.minVersion}+</span>
        <span className="db-engine-dd-caret" aria-hidden>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul className="db-engine-dd-menu" role="listbox">
          {SUPPORTED_DB_TYPES.map(t => (
            <li key={t.value} role="option" aria-selected={t.value === value}>
              <button type="button"
                className={`db-engine-dd-opt${t.value === value ? ' active' : ''}`}
                onClick={() => { onChange(t.value); setOpen(false); }}>
                <span className={`db-type-icon ${t.tone}`}>{t.icon}</span>
                <span className="db-engine-dd-opt-name">{t.label}</span>
                <span className="db-engine-dd-opt-ver">v{t.minVersion}+</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EngineInfoCard({ type }) {
  const cfg = SUPPORTED_DB_TYPES.find(t => t.value === type);
  if (!cfg) return null;
  return (
    <div className="db-engine-info" style={{ borderLeftColor: dbTypeColor(type) }}>
      <div className="db-engine-info-head">
        <div className="db-engine-info-title">
          <span className={`db-type-icon ${cfg.tone}`}>{cfg.icon}</span>
          <strong>{cfg.label}</strong>
        </div>
        <div className="db-engine-info-versions">
          <span><b>Versión mínima:</b> {cfg.minVersion}</span>
          <span><b>Recomendado:</b> {cfg.recommended}</span>
        </div>
      </div>
      <div className="db-engine-info-hint">{cfg.versionsHint}</div>
      <details className="db-engine-info-metrics">
        <summary>Métricas que se monitorean ({cfg.metrics.length})</summary>
        <ul>
          {cfg.metrics.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      </details>
    </div>
  );
}

function ProfileSelector({ value, onChange }) {
  return (
    <div className="db-profile-grid">
      {MONITORING_PROFILES.map(p => (
        <button key={p.value} type="button"
          className={`db-profile-card${value === p.value ? ' active' : ''}`}
          onClick={() => onChange(p.value)}>
          <div className="db-profile-name">
            {p.label}
            <span className="db-profile-interval">{p.interval}s</span>
          </div>
          <div className="db-profile-desc">{p.description}</div>
          <div className="db-profile-detail">{p.detail}</div>
        </button>
      ))}
    </div>
  );
}

const EMPTY = { name: '', type: 'postgres', dsn: '', params: { profile: 'standard' }, enabled: true, poll_interval_seconds: 60 };

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
    <Drawer
      title={isNew ? 'Agregar base de datos' : 'Editar base de datos'}
      subtitle={isNew ? 'Configura la conexión y comenzaremos a monitorear automáticamente.' : `Editando: ${form.name || 'sin nombre'}`}
      onClose={onClose}
      footer={
        <>
          <button className="db-form-btn" type="button" onClick={onClose}>Cancelar</button>
          <button className="db-form-btn db-form-btn-primary" type="button"
            onClick={() => onSave(form)} disabled={saving || !form.name || !form.dsn}>
            {saving ? 'Guardando…' : isNew ? 'Agregar base de datos' : 'Guardar cambios'}
          </button>
        </>
      }>
      <div className="db-form">

        <div className="db-form-field">
          <span className="db-form-label">Tipo de base de datos</span>
          <EngineDropdown value={form.type} onChange={(v) => set('type', v)}/>
        </div>

        <EngineInfoCard type={form.type}/>

        <div className="db-form-field">
          <span className="db-form-label">Perfil de monitoreo</span>
          <ProfileSelector
            value={form.params?.profile || 'standard'}
            onChange={(p) => {
              setParam('profile', p);
              const cfg = MONITORING_PROFILES.find(x => x.value === p);
              if (cfg) set('poll_interval_seconds', cfg.interval);
            }}/>
        </div>

        <div className="db-form-field">
          <label className="db-form-label" htmlFor="db-f-name">Nombre</label>
          <input id="db-f-name" className="db-form-input" value={form.name}
            onChange={e => set('name', e.target.value)}
            placeholder={
              form.type === 'redis'   ? 'Ej: Redis caché' :
              form.type === 'mysql'   ? 'Ej: Producción MySQL' :
              form.type === 'mariadb' ? 'Ej: Producción MariaDB' :
              form.type === 'sqlite'  ? 'Ej: shortr.db' :
                                        'Ej: Producción PostgreSQL'
            }
            autoFocus/>
        </div>

        {isRelational(form.type) || form.type === 'mongodb' ? (
          <div className="db-form-field">
            <label className="db-form-label" htmlFor="db-f-dsn">
              {form.type === 'sqlite' ? 'Ruta del archivo' : 'URL de conexión'}
              {form.type !== 'sqlite' && <span className="db-form-optional"> — incluye credenciales en la URL</span>}
            </label>
            <input id="db-f-dsn" className="db-form-input db-form-mono" value={form.dsn}
              onChange={e => set('dsn', e.target.value)}
              placeholder={
                form.type === 'mysql'   ? 'mysql://usuario:contraseña@host:3306/nombre_bd' :
                form.type === 'mariadb' ? 'mariadb://usuario:contraseña@host:3306/nombre_bd' :
                form.type === 'sqlite'  ? '/ruta/al/archivo.db (lectura)' :
                form.type === 'mongodb' ? 'mongodb://usuario:contraseña@host:27017/nombre_bd' :
                                          'postgres://usuario:contraseña@host:5432/nombre_bd'
              }
              autoComplete="off" spellCheck={false}/>
            {form.type === 'sqlite' && (
              <span className="db-form-optional" style={{ marginTop: 4, fontSize: 11 }}>
                El archivo debe ser accesible para el backend (montado dentro del contenedor).
              </span>
            )}
            {form.type === 'mongodb' && (
              <span className="db-form-optional" style={{ marginTop: 4, fontSize: 11 }}>
                También soporta mongodb+srv:// (Atlas). Usuario necesita rol clusterMonitor o readAnyDatabase.
              </span>
            )}
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
    </Drawer>
  );
}

// ── InsightsPanel ─────────────────────────────────────────────────────────────

function severityChip(sev) {
  const map = {
    crit: { bg: '#fef2f2', border: '#fecaca', color: '#991b1b', label: 'CRÍTICO' },
    warn: { bg: '#fffbeb', border: '#fde68a', color: '#92400e', label: 'ATENCIÓN' },
    info: { bg: '#eff6ff', border: '#bfdbfe', color: '#1e40af', label: 'INFO' },
  };
  const s = map[sev] || map.info;
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: '.04em', background: s.bg, border: `1px solid ${s.border}`, color: s.color,
    }}>{s.label}</span>
  );
}

function InsightsPanel({ api, targetId }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${targetId}/insights`),
    [targetId],
    300_000, // 5 min — los insights no cambian rápido
  );
  const insights = data?.insights || [];
  if (loading && !data) {
    return <Panel title="Insights"><Skeleton/></Panel>;
  }
  if (!data) {
    return null; // sin datos suficientes — no llenar la UI con ruidos
  }
  return (
    <Panel title={`Insights${insights.length > 0 ? ` (${insights.length})` : ''}`}
      action={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload}/>}>
      {insights.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 13, padding: '6px 2px' }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block',
          }}/>
          Sin hallazgos relevantes en las métricas recientes.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {insights.map((ins, i) => (
            <div key={i} style={{
              padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8,
              background: ins.severity === 'crit' ? '#fef2f2' : ins.severity === 'warn' ? '#fffbeb' : '#f8fafc',
              borderLeft: `4px solid ${ins.severity === 'crit' ? '#dc2626' : ins.severity === 'warn' ? '#f59e0b' : '#3b82f6'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                {severityChip(ins.severity)}
                <strong style={{ fontSize: 13 }}>{ins.title}</strong>
              </div>
              <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.45 }}>{ins.detail}</div>
              {ins.hint && (
                <div style={{
                  marginTop: 6, fontSize: 11, color: '#64748b', fontStyle: 'italic',
                  borderTop: '1px dashed #cbd5e1', paddingTop: 6,
                }}>
                  💡 {ins.hint}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── TrendsPanel ───────────────────────────────────────────────────────────────

const TREND_RANGES = [
  { key: '15m', label: '15 min', minutes: 15 },
  { key: '1h',  label: '1 h',    minutes: 60 },
  { key: '3h',  label: '3 h',    minutes: 180 },
  { key: 'all', label: 'Todo',   minutes: null },
];

function TrendsPanel({ samples, isPG }) {
  const [rangeKey, setRangeKey] = useState('1h');
  const range = TREND_RANGES.find(r => r.key === rangeKey) || TREND_RANGES[1];

  // Span temporal real disponible en las muestras (en minutos)
  const availableSpanMin = useMemo(() => {
    if (samples.length < 2) return 0;
    const newest = new Date(samples[0].captured_at).getTime();
    const oldest = new Date(samples[samples.length - 1].captured_at).getTime();
    return Math.max(0, (newest - oldest) / 60000);
  }, [samples]);

  const filtered = useMemo(() => {
    if (range.minutes == null) return samples;
    const cutoff = Date.now() - range.minutes * 60 * 1000;
    return samples.filter(s => new Date(s.captured_at).getTime() >= cutoff);
  }, [samples, range]);

  const rangeExceedsData = range.minutes != null && availableSpanMin < range.minutes * 0.8 && samples.length >= 2;

  const fmtSpan = (min) => {
    if (min < 1) return 'menos de 1 min';
    if (min < 60) return `${Math.round(min)} min`;
    const h = min / 60;
    if (h < 24) return `${h >= 10 ? Math.round(h) : h.toFixed(1)} h`;
    return `${(h / 24).toFixed(1)} d`;
  };

  const has = (pred) => filtered.some(pred);

  const charts = [
    {
      key: 'connections',
      show: filtered.length >= 2,
      props: {
        field: isPG ? 'connections_total' : 'connected_clients',
        color: isPG ? '#3b82f6' : '#ef4444',
        label: isPG ? 'Conexiones' : 'Clientes',
      },
    },
    {
      key: 'cache',
      show: isPG && has(s => s.cache_hit_ratio != null),
      props: { field: 'cache_hit_ratio', color: '#22c55e', label: 'Cache hit', scale: 100, suffix: '%' },
    },
    {
      key: 'tps',
      show: isPG && has(s => s._tps != null),
      props: { field: '_tps', color: '#8b5cf6', label: 'TPS', suffix: '/s' },
    },
    {
      key: 'pool',
      show: isPG && has(s => s._conn_pct != null),
      props: { field: '_conn_pct', color: '#f59e0b', label: 'Pool conexiones', suffix: '%' },
    },
    {
      key: 'slow',
      show: isPG && has(s => (s.slow_queries ?? 0) > 0),
      props: { field: 'slow_queries', color: '#ef4444', label: 'Queries lentas activas' },
    },
    {
      key: 'p95',
      show: isPG && has(s => s.slow_query_p95_ms != null),
      props: { field: 'slow_query_p95_ms', color: '#0ea5e9', label: 'Latencia p95', suffix: ' ms' },
    },
    {
      key: 'deadlocks',
      show: isPG && has(s => s._deadlocks_delta != null && s._deadlocks_delta > 0),
      props: { field: '_deadlocks_delta', color: '#dc2626', label: 'Deadlocks por intervalo' },
    },
    {
      key: 'dbsize',
      show: isPG && has(s => s.db_size_bytes != null),
      props: { field: 'db_size_bytes', color: '#14b8a6', label: 'Tamaño BD', scale: 1/(1024*1024), suffix: ' MB' },
    },
    {
      key: 'locks',
      show: isPG && has(s => (s.active_locks ?? 0) > 0),
      props: { field: 'active_locks', color: '#a855f7', label: 'Locks en espera' },
    },
  ].filter(c => c.show);

  return (
    <Panel title={`Tendencias${charts.length > 0 ? ` · ${charts.length}` : ''}`}>
      <div className="db-trends-toolbar">
        <span className="range-label">Rango:</span>
        <div className="db-trends-range">
          {TREND_RANGES.map(r => (
            <button key={r.key} type="button"
              className={r.key === rangeKey ? 'active' : ''}
              onClick={() => setRangeKey(r.key)}>{r.label}</button>
          ))}
        </div>
        <span className="db-trends-meta">
          {filtered.length} de {samples.length} {samples.length === 1 ? 'muestra' : 'muestras'}
          {availableSpanMin > 0 && ` · histórico: ${fmtSpan(availableSpanMin)}`}
        </span>
      </div>
      {rangeExceedsData && (
        <div className="db-trends-warn">
          ⚠ Pediste {range.label} pero solo hay {fmtSpan(availableSpanMin)} de datos. Esperá a que se acumulen más muestras o elegí un rango más corto.
        </div>
      )}
      {filtered.length < 2 ? (
        <div className="empty-chart">
          {samples.length < 2
            ? 'Esperando primeras muestras del polling…'
            : `Sin muestras en los últimos ${range.label}. Probá un rango más amplio.`}
        </div>
      ) : (
        <div className="db-trends-grid">
          {charts.map(c => (
            <LineChart key={c.key} samples={filtered} {...c.props}/>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── TargetDetail ──────────────────────────────────────────────────────────────

function TargetDetail({ api, target, onEdit, onDelete, onBack }) {
  const { data, loading, reload, lastUpdated } = useLoad(
    () => api.get(`/api/db-targets/${target.id}/metrics?limit=360`),
    [target.id],
    DB_REFRESH_MS,
  );
  const [tab, setTab] = useState('resumen');
  const samples = useMemo(() => enrichSamples(data?.samples || []), [data]);
  const latest  = samples[0] || null;
  const isPG    = target.type === 'postgres';
  const isRD    = target.type === 'redis';
  const isMY    = target.type === 'mysql' || target.type === 'mariadb';
  const isSL    = target.type === 'sqlite';

  // Tabs disponibles según el tipo
  // Postgres: full feature set (rutas PG-specific funcionan)
  // Redis:    resumen + en-vivo (4 paneles redis) + historial
  // MySQL/MariaDB: resumen + historial — endpoints avanzados no implementados aún
  // SQLite:   resumen + historial — engine embebido sin live ops remotas
  const pgTabs  = ['resumen', 'en-vivo', 'servidor', 'almacenamiento', 'diagnostico', 'historial'];
  const rdTabs  = ['resumen', 'en-vivo', 'historial'];
  const myTabs  = ['resumen', 'historial'];
  const tabs    = isPG ? pgTabs : isRD ? rdTabs : myTabs;

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
        <Database size={17} style={{ color: dbTypeColor(target.type), flexShrink: 0 }}/>
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
          <InsightsPanel api={api} targetId={target.id}/>
          <Panel title="Métricas actuales">
            {loading && !latest ? <Skeleton/> : <MetricsCard target={target} sample={latest}/>}
          </Panel>
          {samples.length >= 3 && (
            <TrendsPanel samples={samples} isPG={isPG}/>
          )}
        </div>
      )}

      {/* ══ EN VIVO ══ */}
      {tab === 'en-vivo' && (
        <div className="db-tab-content">
          {isPG ? (
            <ActiveQueriesPanel api={api} targetId={target.id}/>
          ) : (
            <>
              <Panel title="Info Redis en vivo">
                <RedisLivePanel api={api} targetId={target.id}/>
              </Panel>
              <Panel title="SLOWLOG (comandos lentos)">
                <RedisSlowlogPanel api={api} targetId={target.id}/>
              </Panel>
              <Panel title="Clientes conectados">
                <RedisClientsPanel api={api} targetId={target.id}/>
              </Panel>
              <Panel title="MEMORY STATS">
                <RedisMemoryPanel api={api} targetId={target.id}/>
              </Panel>
            </>
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
          <Panel title="Configuración del servidor">
            <PGSettingsPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="Autovacuum">
            <AutovacuumPanel api={api} targetId={target.id}/>
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
          <Panel title="Locks bloqueantes (pg_blocking_pids)">
            <BlockingLocksPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="I/O por tabla (pg_statio_user_tables)">
            <TableIOPanel api={api} targetId={target.id}/>
          </Panel>
          <Panel title="Queries más lentas (pg_stat_statements)">
            <SlowQueriesPanel api={api} targetId={target.id}/>
          </Panel>
        </div>
      )}

      {/* ══ HISTORIAL ══ */}
      {tab === 'historial' && (
        <div className="db-tab-content">
          {samples.length < 2 ? (
            <div className="db-live-empty"><span>Sin muestras históricas aún — el monitor pollea cada {target.poll_interval_seconds}s.</span></div>
          ) : (
            <Panel title={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                Últimas {Math.min(samples.length, 30)} muestras (polling cada {target.poll_interval_seconds}s)
                <span className="db-help-icon" tabIndex={0}>
                  <HelpCircle size={14}/>
                  <span className="db-help-pop">
                    Cada fila es una <strong>muestra de polling</strong> — el monitor conecta a la BD, mide sus métricas y las guarda.
                    {' '}<strong>Conexión OK</strong> = logró conectar y recopilar métricas.
                    {' '}<strong>Error</strong> = falló la conexión o hubo un error al consultar (hover sobre el mensaje para ver detalle).
                  </span>
                </span>
              </span>
            }>
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
                          <th title="Transacciones por segundo derivado entre samples">TPS</th>
                          <th title="Percentil 95 de mean_exec_time en pg_stat_statements">p95 (ms)</th>
                          <th title="Queries activas con duración >5s al momento del poll">Queries lentas</th>
                          <th title="Deadlocks acumulados desde el reset de pg_stat_database">Deadlocks</th>
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
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {s._tps != null ? round(s._tps) : <span className="db-na">—</span>}
                            </td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {s.slow_query_p95_ms != null ? round(s.slow_query_p95_ms) : <span className="db-na">—</span>}
                            </td>
                            <td style={{ color: (s.slow_queries ?? 0) > 0 ? '#b91c1c' : '#15803d', fontWeight: (s.slow_queries ?? 0) > 0 ? 700 : undefined }}>
                              {s.slow_queries ?? <span className="db-na">—</span>}
                            </td>
                            <td style={{ color: (s.deadlocks ?? 0) > 0 ? '#dc2626' : undefined, fontWeight: (s.deadlocks ?? 0) > 0 ? 700 : undefined }}>
                              {s.deadlocks != null ? Number(s.deadlocks).toLocaleString() : <span className="db-na">—</span>}
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
                      <Database size={15} style={{ color: dbTypeColor(t.type), flexShrink: 0 }}/>
                      <strong>{t.name}</strong>
                      {typeIcon(t.type)}
                      {statusBadge(t)}
                      {!t.enabled && <span className="db-badge db-badge-disabled">Desactivado</span>}
                    </div>
                    <div className="db-card-right" onClick={e => e.stopPropagation()}>
                      {t.sparkline?.length >= 2 && (
                        <Sparkline values={t.sparkline} color={dbTypeColor(t.type)}/>
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
