import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Edit3,
  Eye,
  Gauge,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  MemoryStick,
  Monitor,
  Network,
  RefreshCw,
  Save,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import './styles.css';
import './resources-polish.css';
import {
  AlertList,
  Header,
  IconButton,
  MiniAgentList,
  Panel,
  RefreshMeta,
  Skeleton,
  Status,
  StatusDonut,
  bytes,
  copyTextFallback,
  date,
  humanMinutes,
  percent,
  relativeTime,
  round,
  timeAgo,
  useLoad,
} from './lib/ui';

// Vistas pesadas en chunks separados (React.lazy + Suspense).
const Enrollment = lazy(() => import('./views/Enrollment'));
const SettingsPage = lazy(() => import('./views/SettingsPage'));
const AlertsCenter = lazy(() => import('./views/AlertsCenter'));
const AgentDetail = lazy(() => import('./views/AgentDetail'));
const DatabasesView = lazy(() => import('./views/DatabasesView'));

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const REFRESH_MS       = 60_000; // overview + alertas
const LIST_REFRESH_MS  = 30_000; // lista de agentes
const STATUS_REFRESH_MS = 10_000; // estado/detail del agente
const CHART_REFRESH_MS = 30_000; // historial para graficas

function decodeJWTRole(token) {
  if (!token) return '';
  try {
    const payload = token.split('.')[1];
    if (!payload) return '';
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = JSON.parse(atob(padded));
    return (decoded?.role || '').toLowerCase();
  } catch {
    return '';
  }
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('rm_token') || '');
  const [view, setView] = useState('dashboard');
  const logout = () => {
    localStorage.removeItem('rm_token');
    setToken('');
  };
  if (!token) return <Login onLogin={setToken} />;
  return <Shell token={token} view={view} setView={setView} onLogout={logout} />;
}

function Shell({ token, view, setView, onLogout }) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentsInitialFilter, setAgentsInitialFilter] = useState('all');
  const api = useMemo(() => createApi(token, onLogout), [token, onLogout]);
  const role = useMemo(() => decodeJWTRole(token), [token]);
  const isAdmin = role === 'admin';
  const baseNav = [
    ['dashboard', LayoutDashboard, 'Dashboard'],
    ['agents', Server, 'Equipos'],
    ['databases', Database, 'Bases de datos'],
    ['enroll', KeyRound, 'Alta agente'],
    ['alerts', ShieldAlert, 'Alertas'],
    ['settings', Settings, 'Configuración'],
  ];
  const nav = baseNav.filter(([id]) => id !== 'settings' || isAdmin);
  useEffect(() => {
    if (view === 'settings' && !isAdmin) setView('dashboard');
  }, [view, isAdmin, setView]);
  const navigateTo = (target, opts = {}) => {
    if (target === 'agents') {
      setSelectedAgent(null);
      setAgentsInitialFilter(opts.statusFilter || 'all');
    }
    setView(target);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Monitor size={28} />
          <div><strong>Resource Monitor</strong><span>Observabilidad Windows / Linux</span></div>
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => {
              if (id === 'agents') {
                setSelectedAgent(null);
                setAgentsInitialFilter('all');
              }
              setView(id);
            }}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ManagerUpdateButton api={api} />
          <button className="logout" onClick={onLogout}><LogOut size={18} />Salir</button>
        </div>
      </aside>
      <main>
        <Suspense fallback={<div className="lazy-fallback">Cargando…</div>}>
          {view === 'dashboard' && <Dashboard api={api} navigateTo={navigateTo} />}
          {view === 'agents' && (selectedAgent ? <AgentDetail api={api} agentId={selectedAgent} onBack={() => setSelectedAgent(null)} /> : <Agents api={api} onSelect={setSelectedAgent} initialFilter={agentsInitialFilter} />)}
          {view === 'databases' && <DatabasesView api={api} />}
          {view === 'enroll' && <Enrollment api={api} />}
          {view === 'alerts' && <AlertsCenter api={api} />}
          {view === 'settings' && isAdmin && <SettingsPage api={api} />}
        </Suspense>
      </main>
    </div>
  );
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login invalido');
      localStorage.setItem('rm_token', data.token);
      onLogin(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="login-page">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-mark"><Activity size={34} /></div>
        <h1>Resource Monitor</h1>
        <p className="login-sub">Monitoreo de infraestructura</p>
        <label>Usuario<input value={username} autoComplete="username" placeholder="admin" onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Contraseña<input type="password" autoComplete="current-password" value={password} placeholder="••••••••" onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={loading}>{loading ? 'Entrando…' : 'Iniciar sesión'}</button>
      </form>
    </div>
  );
}

function Dashboard({ api, navigateTo }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/dashboard/overview'), [], REFRESH_MS);
  const { data: tagsData } = useLoad(() => api.get('/api/tags'), [], 0);
  const [tagFilter, setTagFilter] = useState('');
  const overview = data || {};
  const stats = overview.summary || overview;
  const counts = overview.status_counts || overview.status_distribution || {};
  const trends = overview.trends_24h || {};
  const capacity = overview.capacity || {};
  const osDist = overview.os_distribution || {};
  const heatmap = overview.heatmap_24h || [];
  const dbSummary = overview.db_summary || {};
  const availableTags = tagsData?.tags || [];

  const filterByTag = (list) => {
    if (!tagFilter || !Array.isArray(list)) return list || [];
    return list.filter((a) => Array.isArray(a.tags) && a.tags.includes(tagFilter));
  };
  const topCpu = filterByTag(overview.top_cpu || []);
  const topRam = filterByTag(overview.top_memory || []);
  const staleAgents = filterByTag(overview.stale_agents || []);
  const recentAlerts = tagFilter
    ? (overview.recent_alerts || []).filter((al) => Array.isArray(al.tags) && al.tags.includes(tagFilter))
    : (overview.recent_alerts || []);

  // "Online" = todo lo que reporta heartbeat (online + warning + critical).
  // Tener alertas no quita que el agente este vivo; solo offline resta uptime.
  const onlineLike = Number(counts.online || 0) + Number(counts.warning || 0) + Number(counts.critical || 0);
  const total = (onlineLike + Number(counts.offline || 0)) || 1;
  const uptimePct = Math.round((onlineLike / total) * 100);
  const alertsTrend = trends.alerts || [];
  const alertsTrendDelta = alertsTrend.length >= 2
    ? alertsTrend.slice(-3).reduce((a, b) => a + b, 0) - alertsTrend.slice(0, 3).reduce((a, b) => a + b, 0)
    : 0;
  const ramUsedPct = capacity.ram_total_bytes ? (Number(capacity.ram_used_bytes || 0) / Number(capacity.ram_total_bytes)) * 100 : 0;
  const diskUsedPct = capacity.disk_total_bytes ? (Number(capacity.disk_used_bytes || 0) / Number(capacity.disk_total_bytes)) * 100 : 0;

  return (
    <section>
      <Header title="Dashboard operativo" meta={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />} />

      {availableTags.length > 0 && (
        <div className="dashboard-filterbar">
          <span>Filtrar por grupo:</span>
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">Todos</option>
            {availableTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {tagFilter && <span className="filter-hint">Listas filtradas; KPIs muestran totales globales.</span>}
        </div>
      )}

      <div className="dash-hero-grid">
        <article className={`dash-hero-card tone-${stats.critical_agents ? 'critical' : stats.warning_agents ? 'warning' : 'online'}`}>
          <span>Uptime cluster</span>
          <strong>{uptimePct}%</strong>
          <small>{onlineLike} de {total} online</small>
          <StatusDonut counts={counts} />
        </article>
        <article className="dash-hero-card">
          <span>Tendencia alertas (24h)</span>
          <strong>{stats.active_alerts || 0}<small className={alertsTrendDelta > 0 ? 'tone-bad' : alertsTrendDelta < 0 ? 'tone-good' : ''}>
            {alertsTrendDelta > 0 ? `↑ +${alertsTrendDelta}` : alertsTrendDelta < 0 ? `↓ ${alertsTrendDelta}` : '— estable'}
          </small></strong>
          <Sparkline points={alertsTrend} color="#ef4444" width={180} height={40} />
        </article>
        <button className="dash-hero-card clickable" onClick={() => navigateTo('agents', { statusFilter: 'critical' })}>
          <span>Equipos críticos</span>
          <strong className="tone-bad">{stats.critical_agents || 0}</strong>
          <small>Click para ver listado</small>
        </button>
      </div>

      <div className="kpi-grid">
        <KpiClick icon={Server} label="Online" value={stats.online_agents ?? 0} tone="good" onClick={() => navigateTo('agents', { statusFilter: 'online' })} />
        <KpiClick icon={Monitor} label="Offline" value={stats.offline_agents ?? 0} tone="muted" onClick={() => navigateTo('agents', { statusFilter: 'offline' })} />
        <KpiClick icon={AlertTriangle} label="Alertas activas" value={stats.active_alerts ?? 0} tone="bad" sparkline={trends.alerts} sparkColor="#ef4444" onClick={() => navigateTo('alerts')} />
        <KpiClick icon={Cpu} label="CPU promedio" value={`${round(stats.avg_cpu_percent)}%`} sparkline={trends.cpu} sparkColor="#3b82f6" />
        <KpiClick icon={MemoryStick} label="RAM promedio" value={`${round(stats.avg_memory_percent)}%`} sparkline={trends.memory} sparkColor="#a855f7" />
        <KpiClick icon={HardDrive} label="Discos críticos" value={stats.critical_disks ?? 0} tone="bad" onClick={() => navigateTo('alerts')} />
        <KpiClick icon={Settings} label="Servicios caídos" value={stats.services_down ?? 0} tone="bad" onClick={() => navigateTo('alerts')} />
        {dbSummary.total > 0 && (
          <KpiClick icon={Database} label="BD con error" value={dbSummary.error ?? 0} tone={dbSummary.error > 0 ? 'bad' : 'good'} onClick={() => navigateTo('databases')} />
        )}
      </div>

      <div className="dashboard-grid">
        <Panel title="Top CPU"><BarAgentList agents={topCpu} metric="cpu_percent" color="#3b82f6" onSelect={(a) => navigateTo('agents')} /></Panel>
        <Panel title="Top RAM"><BarAgentList agents={topRam} metric="memory_used_percent" color="#a855f7" onSelect={(a) => navigateTo('agents')} /></Panel>
        <Panel title="Equipos sin métrica reciente"><MiniAgentList agents={staleAgents} empty="Sin equipos vencidos" /></Panel>
        <Panel title="Últimas alertas"><AlertList alerts={recentAlerts} compact api={api} onChange={reload} /></Panel>
      </div>

      <div className="dashboard-grid">
        <Panel title="Capacidad cluster">
          <CapacityPanel ramUsedPct={ramUsedPct} ramUsed={capacity.ram_used_bytes} ramTotal={capacity.ram_total_bytes}
                         diskUsedPct={diskUsedPct} diskUsed={capacity.disk_used_bytes} diskTotal={capacity.disk_total_bytes} diskFree={capacity.disk_free_bytes} />
        </Panel>
        <Panel title="Distribución por OS">
          <OsDistribution dist={osDist} />
        </Panel>
        <Panel title="Heatmap alertas (7d, hora del día)">
          <Heatmap buckets={heatmap} />
        </Panel>
      </div>

      {dbSummary.total > 0 && (
        <div className="dashboard-grid">
          <Panel title="Bases de datos monitoreadas">
            <DBSummaryPanel summary={dbSummary} onNavigate={() => navigateTo('databases')} />
          </Panel>
        </div>
      )}
    </section>
  );
}

function KpiClick({ icon: Icon, label, value, tone = '', sparkline, sparkColor = '#3b82f6', onClick }) {
  const Tag = onClick ? 'button' : 'article';
  return (
    <Tag className={`kpi ${tone} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <Icon size={22} />
      <span>{label}</span>
      <strong>{value}</strong>
      {sparkline && sparkline.length >= 2 && (
        <div className="kpi-spark"><Sparkline points={sparkline} color={sparkColor} width={120} height={28} /></div>
      )}
    </Tag>
  );
}

function DBSummaryPanel({ summary, onNavigate }) {
  const total   = summary.total || 0;
  const ok      = summary.ok || 0;
  const err     = summary.error || 0;
  const noData  = (summary.enabled || 0) - ok - err;
  const pgCount = summary.pg_count || 0;
  const rdCount = summary.redis_count || 0;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{total}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 }}>Total</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: '#15803d', lineHeight: 1 }}>{ok}</div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 }}>OK</div>
        </div>
        {err > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#b91c1c', lineHeight: 1 }}>{err}</div>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 }}>Error</div>
          </div>
        )}
        {noData > 0 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#94a3b8', lineHeight: 1 }}>{noData}</div>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 3 }}>Sin datos</div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 8 }}>
        {pgCount > 0 && <span style={{ padding: '3px 10px', borderRadius: 5, background: '#dbeafe', color: '#1e40af', fontSize: 12, fontWeight: 700 }}>PostgreSQL ×{pgCount}</span>}
        {rdCount > 0 && <span style={{ padding: '3px 10px', borderRadius: 5, background: '#fee2e2', color: '#991b1b', fontSize: 12, fontWeight: 700 }}>Redis ×{rdCount}</span>}
      </div>
      <button onClick={onNavigate} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 7, border: '1.5px solid #e2e8f0', background: '#f8fafc', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#475569' }}>
        Ver detalle →
      </button>
    </div>
  );
}

function BarAgentList({ agents, metric, color, onSelect }) {
  if (!agents || !agents.length) return <p className="empty-panel">Sin datos</p>;
  return (
    <div className="bar-list">
      {agents.map((agent) => {
        const value = Number(agent[metric] || 0);
        const pct = Math.max(0, Math.min(100, value));
        const tone = pct >= 90 ? '#ef4444' : pct >= 75 ? '#f59e0b' : color;
        return (
          <button key={agent.id} className="bar-row" onClick={() => onSelect && onSelect(agent)}>
            <div className="bar-row-head">
              <strong>{agent.name}</strong>
              <span>{percent(value)}</span>
            </div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${pct}%`, background: tone }} /></div>
          </button>
        );
      })}
    </div>
  );
}

function CapacityPanel({ ramUsedPct, ramUsed, ramTotal, diskUsedPct, diskUsed, diskTotal, diskFree }) {
  return (
    <div className="capacity-grid">
      <div>
        <div className="cap-row"><span>RAM</span><strong>{percent(ramUsedPct)}</strong></div>
        <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, ramUsedPct)}%`, background: ramUsedPct >= 85 ? '#ef4444' : '#a855f7' }} /></div>
        <small>{bytes(ramUsed)} / {bytes(ramTotal)}</small>
      </div>
      <div>
        <div className="cap-row"><span>Disco</span><strong>{percent(diskUsedPct)}</strong></div>
        <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, diskUsedPct)}%`, background: diskUsedPct >= 85 ? '#ef4444' : '#3b82f6' }} /></div>
        <small>{bytes(diskUsed)} / {bytes(diskTotal)} · libre {bytes(diskFree)}</small>
      </div>
    </div>
  );
}

function OsDistribution({ dist }) {
  const entries = Object.entries(dist || {}).filter(([, v]) => v > 0);
  if (!entries.length) return <p className="empty-panel">Sin datos</p>;
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const palette = { linux: '#22c55e', windows: '#3b82f6', macos: '#a855f7', otro: '#64748b', desconocido: '#94a3b8' };
  return (
    <div className="os-dist">
      {entries.map(([os, count]) => (
        <div key={os} className="os-row">
          <div className="os-row-head"><span style={{ background: palette[os] || '#64748b' }} className="os-dot" /><strong>{os}</strong><span>{count}</span></div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(count / total) * 100}%`, background: palette[os] || '#64748b' }} /></div>
        </div>
      ))}
    </div>
  );
}

function Heatmap({ buckets }) {
  if (!buckets || !buckets.length) return <p className="empty-panel">Sin alertas en los últimos 7 días</p>;
  const max = Math.max(...buckets, 1);
  return (
    <div className="heatmap">
      {buckets.map((count, hour) => {
        const intensity = count / max;
        const bg = count === 0 ? '#1f2937' : `rgba(239, 68, 68, ${0.2 + intensity * 0.8})`;
        return (
          <div key={hour} className="heat-cell" title={`${String(hour).padStart(2, '0')}:00 — ${count} alertas`} style={{ background: bg }}>
            <span>{hour}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Sparkline helpers ────────────────────────────────────────────────────────
function Sparkline({ points, color = '#3b82f6', width = 80, height = 28 }) {
  if (!points || points.length < 2) return <span style={{ color: '#6b7280', fontSize: '11px' }}>—</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pts = points.map((v, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const sparklineCache = {};

function useSparkline(agentId, api) {
  const [data, setData] = useState(sparklineCache[agentId] || null);
  const load = useCallback(async () => {
    if (sparklineCache[agentId]) { setData(sparklineCache[agentId]); return; }
    try {
      const res = await api.get(`/api/agents/${agentId}/history?range=24h`);
      const points = (res.metrics || []).map((m) => m.cpu_percent || 0);
      const step = Math.max(1, Math.floor(points.length / 40));
      const sampled = points.filter((_, i) => i % step === 0);
      sparklineCache[agentId] = sampled;
      setData(sampled);
    } catch { /* silencioso */ }
  }, [agentId, api]);
  return { data, load };
}

function AgentRow({ agent, api, onSelect, latestVersion, onUpdated }) {
  const { data: sparkPoints, load } = useSparkline(agent.id, api);
  const sparkColor = agent.status === 'critical' ? '#ef4444' : agent.status === 'warning' ? '#f59e0b' : '#3b82f6';
  const alerts = agent.active_alerts ?? 0;
  const [updating, setUpdating] = useState(false);
  const currentVersion = agent.agent_version || '—';
  const needsUpdate = latestVersion && agent.agent_version && agent.agent_version !== latestVersion;
  const lastCmd = agent.last_command || null;
  const cmdActive = lastCmd && (lastCmd.status === 'pending' || lastCmd.status === 'delivered');
  const cmdFailed = lastCmd && lastCmd.status === 'failed';
  const cmdRecentSuccess = lastCmd && lastCmd.status === 'completed';

  async function triggerUpdate(e) {
    e.stopPropagation();
    if (!window.confirm(`¿Actualizar agente "${agent.name}" de ${currentVersion} a ${latestVersion}?`)) return;
    setUpdating(true);
    try {
      await api.post(`/api/agents/${agent.id}/commands`, { command: 'update' });
      onUpdated && onUpdated();
    } catch (err) {
      window.alert(`Error: ${err.message}`);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <tr onMouseEnter={load} className="agent-row" onClick={() => onSelect(agent.id)}>
      <td className="agent-cell-name"><strong>{agent.name}</strong><span>{agent.hostname}</span></td>
      <td><Status status={agent.status} /></td>
      <td className="agent-cell-os hide-md">{agent.os}</td>
      <td>{percent(agent.cpu_percent)}</td>
      <td>{percent(agent.memory_used_percent)}</td>
      <td className="hide-md">{agent.disk_count ?? 0}</td>
      <td>{alerts > 0 ? <span className="alert-count">{alerts}</span> : <span className="text-muted">0</span>}</td>
      <td className="hide-lg">
        <div className="tag-cell">
          {(agent.tags || []).map((t) => <span key={t} className="agent-tag">{t}</span>)}
        </div>
      </td>
      <td className="hide-md">
        <div className="version-cell">
          <code className={needsUpdate ? 'version-old' : ''}>{currentVersion}</code>
          {cmdActive && (
            <span className={`cmd-badge cmd-${lastCmd.status}`} title={`comando ${lastCmd.command} desde ${date(lastCmd.created_at)}`}>
              <span className="cmd-spinner" /> {lastCmd.command} {lastCmd.status === 'pending' ? 'pendiente' : 'ejecutando'}
            </span>
          )}
          {/* Solo mostrar el badge de fallo si la versión sigue desactualizada.
              Si el agente ya alcanzó la latest, el fallo histórico deja de ser relevante. */}
          {cmdFailed && needsUpdate && (
            <span className="cmd-badge cmd-failed" title={lastCmd.error || 'fallo'}>
              ✗ {lastCmd.command} falló
            </span>
          )}
          {cmdRecentSuccess && !needsUpdate && (
            <span className="cmd-badge cmd-completed" title={`completado ${date(lastCmd.completed_at)}`}>
              ✓ {lastCmd.command} OK
            </span>
          )}
          {needsUpdate && !cmdActive && (
            <button
              className="btn-update"
              disabled={updating}
              onClick={triggerUpdate}
              title={cmdFailed ? `Reintentar update a ${latestVersion} (último error: ${lastCmd.error || 'desconocido'})` : `Actualizar a ${latestVersion}`}
            >
              {updating ? '…' : cmdFailed ? '↻ reintentar' : '↑ actualizar'}
            </button>
          )}
        </div>
      </td>
      <td className="text-muted hide-md">{date(agent.last_metric_at)}</td>
      <td className="text-muted hide-lg">{date(agent.last_seen_at)}</td>
      <td className="agent-cell-spark hide-md"><Sparkline points={sparkPoints} color={sparkColor} /></td>
    </tr>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

function Agents({ api, onSelect, initialFilter = 'all' }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialFilter);
  const [tagFilter, setTagFilter] = useState('');
  const [osFilter, setOsFilter] = useState('');
  const { data: tagsData } = useLoad(() => api.get('/api/tags'), [], 0);
  const { data: versionData } = useLoad(() => api.get('/api/agent/version').catch(() => ({})), [], 0);
  const latestVersion = versionData?.version || '';
  const availableTags = tagsData?.tags || [];
  const { data, loading, reload, lastUpdated } = useLoad(() => {
    let url = `/api/agents?q=${encodeURIComponent(query)}`;
    if (tagFilter) url += `&tag=${encodeURIComponent(tagFilter)}`;
    return api.get(url);
  }, [query, tagFilter], LIST_REFRESH_MS);
  const agents = data?.agents || [];
  const osOptions = useMemo(() => {
    const seen = new Set();
    agents.forEach((a) => { if (a.os) seen.add(a.os.split(' ')[0]); });
    return Array.from(seen).sort();
  }, [agents]);
  const filtered = (statusFilter === 'all' ? agents : agents.filter((agent) => agent.status === statusFilter))
    .filter((a) => !osFilter || (a.os && a.os.toLowerCase().includes(osFilter.toLowerCase())));
  const counts = agents.reduce((acc, agent) => ({ ...acc, [agent.status]: (acc[agent.status] || 0) + 1 }), {});
  return (
    <section>
      <Header title="Equipos monitoreados" meta={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />} />
      <div className="agent-tools">
        <div className="toolbar"><Search size={18} /><input placeholder="Buscar por nombre o hostname" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="filter-row">
          {['all', 'online', 'warning', 'critical', 'offline'].map((status) => (
            <button key={status} className={statusFilter === status ? 'selected' : ''} onClick={() => setStatusFilter(status)}>
              {status === 'all' ? 'Todos' : status}<span>{status === 'all' ? agents.length : counts[status] || 0}</span>
            </button>
          ))}
          {availableTags.length > 0 && (
            <select className="filter-select" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
              <option value="">Todos los grupos</option>
              {availableTags.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          {osOptions.length > 1 && (
            <select className="filter-select" value={osFilter} onChange={(e) => setOsFilter(e.target.value)}>
              <option value="">Todos los OS</option>
              {osOptions.map((os) => <option key={os} value={os}>{os}</option>)}
            </select>
          )}
        </div>
      </div>
      {latestVersion && (
        <div className="version-banner">
          Última versión disponible del agente: <strong>{latestVersion}</strong>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Equipo</th><th>Estado</th><th className="hide-md">OS</th><th>CPU</th><th>RAM</th><th className="hide-md">Discos</th><th>Alertas</th><th className="hide-lg">Grupos</th><th className="hide-md">Versión</th><th className="hide-md">Ultima metrica</th><th className="hide-lg">Heartbeat</th><th className="hide-md">CPU 24h</th></tr></thead>
          <tbody>
            {filtered.map((agent) => (
              <AgentRow key={agent.id} agent={agent} api={api} onSelect={onSelect} latestVersion={latestVersion} onUpdated={reload} />
            ))}
            {!filtered.length && <tr><td colSpan="12" className="empty">Sin equipos registrados</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ManagerUpdateButton({ api }) {
  const [status, setStatus] = useState({ state: 'idle' });
  const [version, setVersion] = useState(null);
  const [busy, setBusy] = useState(false);

  // Polling combinado: estado del update + info de versión (current vs latest).
  useEffect(() => {
    let alive = true;
    const tick = () => {
      api.get('/api/manager/update/status').then((s) => alive && setStatus(s || { state: 'idle' })).catch(() => {});
      api.get('/api/manager/version').then((v) => alive && setVersion(v)).catch(() => {});
    };
    tick();
    const active = ['pulling', 'building_backend', 'building_frontend', 'restarting'].includes(status.state);
    const period = active ? 2000 : 30_000;
    const timer = setInterval(tick, period);
    return () => { alive = false; clearInterval(timer); };
  }, [status.state]);

  const labels = {
    pulling: 'Descargando código…',
    building_backend: 'Compilando backend…',
    building_frontend: 'Compilando frontend…',
    restarting: 'Reiniciando…',
    done: '✓ Actualizado',
    failed: '✗ Falló',
  };
  const isActive = ['pulling', 'building_backend', 'building_frontend', 'restarting'].includes(status.state);
  const updateAvailable = !!version?.update_available;

  async function trigger() {
    if (isActive) return;
    const msg = `Actualizar el manager?\n\nEsto hará: git pull → rebuild backend+frontend → reinicio.\nEl manager va a estar inaccesible ~30s mientras reinicia.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await api.post('/api/manager/update', {});
      setStatus({ state: 'pulling' });
    } catch (err) {
      window.alert(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  // Caso 1: update activo (pulling/building/restarting) o reciente fallido →
  // mostrar siempre con su estado. 'done' NO entra acá: cae al caso 3
  // (mostrar versión) porque ya quedó al día.
  if (isActive || status.state === 'failed') {
    return (
      <button
        className="logout manager-update"
        onClick={trigger}
        disabled={isActive || busy}
        title={status.state === 'failed' && status.error ? `Último intento: ${status.error}` : (status.to ? `${status.from || '?'} → ${status.to}` : '')}
      >
        <Download size={18} />
        {labels[status.state] || status.state}
      </button>
    );
  }

  // Construye etiqueta de versión actual reutilizable (caso 2 y 3).
  const verLabel = version?.version && version.version !== 'unknown'
    ? `${version.version}${version.current && version.current !== 'unknown' ? ` (${version.current})` : ''}`
    : (version?.current && version.current !== 'unknown' ? version.current : 'manager');

  // Caso 2: hay update disponible → mostrar versión actual + botón clickable.
  if (updateAvailable) {
    const behindNum = typeof version?.behind === 'number' ? version.behind : null;
    const behindLabel = behindNum !== null ? ` (${behindNum} commit${behindNum === 1 ? '' : 's'} atrás)` : '';
    const title = `${version?.current || 'unknown'} → ${version?.latest || '?'}${behindLabel}`;
    return (
      <div className="manager-version-update">
        <span className="manager-version-current" title="Versión actualmente corriendo">{verLabel}</span>
        <button
          className="logout manager-update"
          onClick={trigger}
          disabled={busy}
          title={title}
        >
          <Download size={18} />
          ↓ Actualizar manager
        </button>
      </div>
    );
  }

  // Caso 3: al día → solo mostrar versión actual, sin botón.
  return (
    <div className="manager-version" title="Manager al día. Esta zona muestra el botón solo cuando hay update disponible.">
      {verLabel}
    </div>
  );
}

function createApi(token, onUnauthorized) {
  return {
    get: (path) => request(path, { method: 'GET' }, token, onUnauthorized),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }, token, onUnauthorized),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }, token, onUnauthorized),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }, token, onUnauthorized),
    delete: (path) => request(path, { method: 'DELETE' }, token, onUnauthorized),
  };
}

// Cache por URL+method para soportar respuestas 304 (Not Modified) del backend.
// Si el server devuelve 304, retornamos la misma referencia del último payload,
// lo que permite a React saltarse el re-render (bail-out por identidad).
const responseCache = new Map();

function cacheKey(method, path) {
  return `${(method || 'GET').toUpperCase()} ${path}`;
}

async function request(path, options, token, onUnauthorized) {
  const method = (options && options.method) || 'GET';
  const key = cacheKey(method, path);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const cached = responseCache.get(key);
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 304 && cached) return cached.data;
  if (res.status === 401) onUnauthorized?.();
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  const etag = res.headers.get('ETag');
  if (etag && method === 'GET') responseCache.set(key, { etag, data });
  return data;
}

function sortBy(items, score) {
  return [...items].sort((a, b) => score(b) - score(a));
}



createRoot(document.getElementById('root')).render(<App />);
