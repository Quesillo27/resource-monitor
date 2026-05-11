import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Copy,
  Cpu,
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

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const REFRESH_MS       = 60_000; // overview + alertas
const LIST_REFRESH_MS  = 30_000; // lista de agentes
const STATUS_REFRESH_MS = 10_000; // estado/detail del agente
const CHART_REFRESH_MS = 30_000; // historial para graficas

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
  const nav = [
    ['dashboard', LayoutDashboard, 'Dashboard'],
    ['agents', Server, 'Equipos'],
    ['enroll', KeyRound, 'Alta agente'],
    ['alerts', ShieldAlert, 'Alertas'],
    ['settings', Settings, 'Configuración'],
  ];
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
        <button className="logout" onClick={onLogout}><LogOut size={18} />Salir</button>
      </aside>
      <main>
        {view === 'dashboard' && <Dashboard api={api} navigateTo={navigateTo} />}
        {view === 'agents' && (selectedAgent ? <AgentDetail api={api} agentId={selectedAgent} onBack={() => setSelectedAgent(null)} /> : <Agents api={api} onSelect={setSelectedAgent} initialFilter={agentsInitialFilter} />)}
        {view === 'enroll' && <Enrollment api={api} />}
        {view === 'alerts' && <AlertsCenter api={api} />}
        {view === 'settings' && <SettingsPage api={api} />}
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

  const total = (Number(counts.online || 0) + Number(counts.warning || 0) + Number(counts.critical || 0) + Number(counts.offline || 0)) || 1;
  const uptimePct = Math.round((Number(counts.online || 0) / total) * 100);
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
          <small>{counts.online || 0} de {total} online</small>
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

function AgentTags({ api, agentId, initialTags, onUpdate }) {
  const [tags, setTags] = useState(initialTags || []);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTags(initialTags || []);
  }, [JSON.stringify(initialTags)]);

  const addTag = async () => {
    const tag = input.trim().toLowerCase().replace(/\s+/g, '-');
    if (!tag || tags.includes(tag)) { setInput(''); return; }
    const next = [...tags, tag];
    setSaving(true);
    try {
      await api.patch(`/api/agents/${agentId}`, { tags: next });
      setTags(next);
      if (onUpdate) onUpdate(next);
    } finally { setSaving(false); setInput(''); }
  };

  const removeTag = async (t) => {
    const next = tags.filter((x) => x !== t);
    await api.patch(`/api/agents/${agentId}`, { tags: next });
    setTags(next);
    if (onUpdate) onUpdate(next);
  };

  return (
    <div className="agent-tags">
      {tags.map((t) => (
        <span key={t} className="agent-tag removable" onClick={() => removeTag(t)} title="Click para eliminar">
          {t} <span aria-hidden>×</span>
        </span>
      ))}
      <input className="agent-tag-input" value={input} onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
        placeholder="+ tag" disabled={saving} />
    </div>
  );
}

function AgentDetail({ api, agentId, onBack }) {
  const [tab, setTab] = useState('summary');
  const [range, setRange] = useState('1h');
  const [deleting, setDeleting] = useState(false);

  const { data, loading, reload, lastUpdated } = useLoad(async () => {
    const [detail, status] = await Promise.all([
      api.get(`/api/agents/${agentId}`),
      api.get(`/api/agents/${agentId}/status`),
    ]);
    return { ...detail, agent_status: status };
  }, [agentId], STATUS_REFRESH_MS);

  const { data: historyData, loading: historyLoading } = useLoad(
    () => api.get(`/api/agents/${agentId}/history?range=${range}`),
    [agentId, range],
    CHART_REFRESH_MS
  );

  const { data: inventory, reload: reloadInventory } = useLoad(() => api.get(`/api/agents/${agentId}/inventory`), [agentId], 0);
  const agent = data?.agent;
  const disks = sortBy(data?.disks || [], (disk) => disk.used_percent);
  const networks = sortBy(data?.networks || [], (net) => net.up ? 0 : 1);
  const processes = sortBy(data?.processes || [], (proc) => proc.cpu_percent + proc.memory_percent);
  const services = sortBy(data?.services || [], (svc) => svc.status === 'running' ? 0 : 1);
  const alerts = data?.alerts || [];
  async function renameAgent() {
    const nextName = window.prompt('Nuevo nombre del equipo', agent?.name || '');
    if (!nextName || nextName === agent?.name) return;
    await api.patch(`/api/agents/${agentId}`, { name: nextName });
    reload();
  }
  async function deleteAgent() {
    if (!window.confirm('Eliminar este equipo y sus metricas historicas?')) return;
    setDeleting(true);
    try {
      await api.delete(`/api/agents/${agentId}`);
      onBack();
    } catch {
      setDeleting(false);
      alert('Error al eliminar el equipo. Intenta de nuevo.');
    }
  }
  return (
    <section>
      <Header title={agent?.name || 'Equipo'} meta={<div className="actions"><button onClick={onBack} disabled={deleting}>Volver</button><IconButton icon={Edit3} onClick={renameAgent} label="Renombrar" disabled={deleting} /><IconButton icon={Trash2} onClick={deleteAgent} label={deleting ? 'Eliminando…' : 'Eliminar'} disabled={deleting} /><RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} /></div>} />
      {agent && (
        <>
          <div className="detail-head"><Status status={agent.status} /><span>{data.status_reason}</span><span>{agent.hostname}</span><span>{agent.os}</span><span>{agent.arch}</span></div>
          <AgentTags api={api} agentId={agentId} initialTags={agent.tags || []} />
          <div className="tab-row">
            {['summary', 'resources', 'disks', 'network', 'processes', 'services', 'alerts', 'rules', 'hardware', 'software'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{tabLabel(item)}</button>)}
          </div>
          {tab === 'summary' && <SummaryTab agent={agent} status={data.agent_status} disks={disks} networks={networks} services={services} alerts={alerts} />}
          {tab === 'resources' && <ResourcesTab agent={agent} history={historyData} historyLoading={historyLoading} disks={disks} networks={networks} range={range} setRange={setRange} />}
          {tab === 'disks' && <DisksTable disks={disks} />}
          {tab === 'network' && <NetworkTable networks={networks} />}
          {tab === 'processes' && <ProcessesTable processes={processes} />}
          {tab === 'services' && <ServicesTable services={services} />}
          {tab === 'alerts' && <AlertList alerts={alerts} api={api} onChange={reload} />}
          {tab === 'rules' && <AgentRulesTab api={api} agentId={agentId} />}
          {tab === 'hardware' && <HardwareTab hardware={inventory?.hardware} onRefresh={reloadInventory} />}
          {tab === 'software' && <SoftwareTab software={inventory?.software} onRefresh={reloadInventory} />}
        </>
      )}
    </section>
  );
}

function SummaryTab({ agent, status, disks, networks, services, alerts }) {
  return (
    <>
      <div className="kpi-grid compact">
        <Kpi icon={Cpu} label="CPU actual" value={percent(agent.cpu_percent)} />
        <Kpi icon={MemoryStick} label="RAM actual" value={percent(agent.memory_used_percent)} />
        <Kpi icon={HardDrive} label="Discos" value={disks.length} />
        <Kpi icon={Network} label="Interfaces" value={networks.length} />
        <Kpi icon={Settings} label="Servicios caidos" value={services.filter((s) => s.status !== 'running').length} tone="bad" />
        <Kpi icon={AlertTriangle} label="Alertas activas" value={alerts.length} tone="bad" />
      </div>
      {status && <div className="diagnostic-band"><span>Ultima metrica: {date(status.last_metric_at)}</span><span>Ultimo heartbeat: {date(status.last_seen_at)}</span><span>Offline despues de: {status.offline_after_seconds}s</span></div>}
      <Panel title="Diagnostico del agente">
        <div className="ops-grid">
          <code>resource-monitor-agent status --config /etc/resource-monitor-agent/config.json</code>
          <code>resource-monitor-agent doctor --config /etc/resource-monitor-agent/config.json</code>
          <code>journalctl -u resource-monitor-agent -f</code>
          <code>Get-Service resource-monitor-agent</code>
        </div>
      </Panel>
    </>
  );
}

const DISK_COLORS = ['#2563eb', '#059669', '#f59e0b', '#dc2626'];

function ResourcesTab({ agent, history, historyLoading = false, disks: currentDisks = [], networks: currentNetworks = [], range, setRange }) {
  const rawMetrics = history?.metrics || [];
  const rawNetwork = history?.network || history?.networks || [];
  const rawDiskHistory = history?.disks || [];
  const diskNames = [...new Set(rawDiskHistory.map((d) => d.mountpoint || d.name))].slice(0, 4);

  const grid = generateTimeGrid(range);
  const metrics = padHistoryToGrid(rawMetrics, grid, ['cpu_percent', 'memory_used_percent', 'swap_used_percent', 'gateway_latency_ms']);
  const network = padHistoryToGrid(rawNetwork, grid, ['bytes_recv_per_sec', 'bytes_sent_per_sec']);
  const disksForChart = pivotDisks(rawDiskHistory, diskNames, grid);

  const latestMetric = lastItem(rawMetrics) || {};
  const latestNetwork = lastItem(rawNetwork) || {};
  const latestDisks = latestDiskValues(rawDiskHistory);
  const busiestDisk = [...(currentDisks.length ? currentDisks : latestDisks)].sort((a, b) => Number(b.used_percent || 0) - Number(a.used_percent || 0))[0];
  const totalDiskBytes = currentDisks.reduce((sum, disk) => sum + Number(disk.total_bytes || 0), 0);
  const usedDiskBytes = currentDisks.reduce((sum, disk) => sum + Number(disk.used_bytes || 0), 0);
  return (
    <>
      <div className="chart-toolbar">
        <div><h2>Historico de recursos</h2><span>Pasa el mouse para ver fecha y valor exacto.</span></div>
        <div className="segmented">
          {['1h', '6h', '12h', '24h', '7d', '30d'].map((item) => (
            <button key={item} className={range === item ? 'selected' : ''} onClick={() => setRange(item)}>{item}</button>
          ))}
        </div>
      </div>
      <div className="resource-console">
        <Panel title="Informacion del servidor">
          <div className="server-facts">
            <span><strong>Equipo</strong>{agent?.hostname || agent?.name || 'n/a'}</span>
            <span><strong>SO</strong>{agent?.os || 'n/a'} {agent?.arch || ''}</span>
            <span><strong>Uptime</strong>{duration(agent?.uptime_seconds)}</span>
            <span><strong>Ultima metrica</strong>{date(agent?.last_metric_at)}</span>
          </div>
        </Panel>
        <Panel title="Memoria y almacenamiento">
          <div className="resource-rings">
            <Ring label="RAM" value={latestMetric.memory_used_percent} main={bytes(latestMetric.memory_used_bytes)} total={bytes(latestMetric.memory_total_bytes)} color="#38bdf8" />
            <Ring label="Swap" value={latestMetric.swap_used_percent} main={bytes(latestMetric.swap_used_bytes)} total={bytes(latestMetric.swap_total_bytes)} color="#fb7185" />
            <Ring label="Disco" value={totalDiskBytes ? (usedDiskBytes / totalDiskBytes) * 100 : busiestDisk?.used_percent} main={bytes(usedDiskBytes || busiestDisk?.used_bytes)} total={bytes(totalDiskBytes || busiestDisk?.total_bytes)} color="#72d572" />
          </div>
        </Panel>
        <Panel title="Estadisticas de red">
          <div className="network-stats">
            <span><small>Recibido ahora</small><strong>{rate(latestNetwork.bytes_recv_per_sec)}</strong></span>
            <span><small>Enviado ahora</small><strong>{rate(latestNetwork.bytes_sent_per_sec)}</strong></span>
            <span><small>Interfaces</small><strong>{currentNetworks.length || 'n/a'}</strong></span>
          </div>
        </Panel>
      </div>
      <div className={`chart-grid${historyLoading ? ' chart-loading' : ''}`}>
        <ChartPanel title="CPU / RAM / Swap" subtitle="Porcentaje de consumo" unit="%">
          <LineChart points={metrics} grid={grid} series={[["CPU", "cpu_percent", "#3b82f6"], ["RAM", "memory_used_percent", "#a855f7"], ["Swap", "swap_used_percent", "#f59e0b"]]} max={100} />
        </ChartPanel>
        <ChartPanel title="Red" subtitle="Velocidad recibida / enviada" unit="B/s">
          <LineChart points={network} grid={grid} series={[["Recibido", "bytes_recv_per_sec", "#ec4899"], ["Enviado", "bytes_sent_per_sec", "#06b6d4"]]} formatter={rate} />
        </ChartPanel>
        <ChartPanel title="Latencia al gateway" subtitle="Latencia promedio al gateway" unit="ms">
          <LineChart points={metrics} grid={grid} series={[["Latencia GW", "gateway_latency_ms", "#10b981"]]} formatter={(v) => v != null ? `${Number(v).toFixed(1)} ms` : '—'} />
        </ChartPanel>
        {diskNames.length > 0 && (
          <ChartPanel title="Uso de disco" subtitle="% usado por unidad / mount" unit="%">
            <LineChart points={disksForChart} grid={grid} series={diskNames.map((name, i) => [name, name, DISK_COLORS[i % DISK_COLORS.length]])} max={100} />
          </ChartPanel>
        )}
      </div>
    </>
  );
}

function Enrollment({ api }) {
  const [serverUrl, setServerUrl] = useState(API_BASE);
  const [downloadUrl, setDownloadUrl] = useState(() => defaultDownloadUrl(API_BASE));
  const [platform, setPlatform] = useState('linux');
  const [agentName, setAgentName] = useState('');
  const [profile, setProfile] = useState('balanced');
  const [interval, setIntervalValue] = useState(60);
  const [services, setServices] = useState('');
  const [ttl, setTtl] = useState(24);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function createToken(event) {
    event.preventDefault();
    setError('');
    const trimmedServer = serverUrl.trim();
    if (!trimmedServer) {
      setError('La URL del servidor API es obligatoria');
      return;
    }
    if (!/^https?:\/\//i.test(trimmedServer)) {
      setError('La URL del servidor debe iniciar con http:// o https://');
      return;
    }
    const intervalNum = Number(interval);
    if (!intervalNum || intervalNum < 30 || intervalNum > 3600) {
      setError('El intervalo debe estar entre 30 y 3600 segundos');
      return;
    }
    setLoading(true);
    try {
      const data = await api.post('/api/enrollment-tokens', {
        name: agentName || 'Alta agente',
        ttl_hours: Number(ttl),
        server_url: trimmedServer,
        download_url: downloadUrl.trim(),
        agent_name: agentName.trim(),
        install_style: platform,
        release_version: 'latest',
        profile,
        services: services.trim(),
        interval: intervalNum,
      });
      setResult(data);
    } catch (err) {
      setError(err.message || 'No se pudo generar el token');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <Header title="Alta de agente" />
      <div className="enroll-layout">
        <div className="enroll-form-card">
          <form className="enroll-form" onSubmit={createToken}>
            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">1</span>Plataforma de destino</div>
              <div className="platform-grid">
                {[['linux', '🐧', 'Linux', 'Debian, Ubuntu, RHEL, Alpine'],['windows', '🪟', 'Windows', 'Windows 10/11, Server 2016+']].map(([val, icon, label, sub]) => (
                  <button key={val} type="button" className={`platform-card ${platform === val ? 'selected' : ''}`} onClick={() => setPlatform(val)}>
                    <span className="platform-icon">{icon}</span>
                    <strong>{label}</strong>
                    <span className="platform-sub">{sub}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">2</span>Identidad del equipo</div>
              <div className="enroll-fields">
                <label>Nombre del equipo <span className="field-hint">opcional — se usa como hostname si se omite</span>
                  <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="ej. servidor-web-01" />
                </label>
                <div className="form-grid">
                  <label>Perfil de recolección
                    <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                      <option value="balanced">Balanceado — CPU, RAM, disco, red, procesos</option>
                      <option value="minimal">Mínimo — solo CPU, RAM y disco</option>
                      <option value="full">Full — todo + temperaturas (20 procesos)</option>
                    </select>
                  </label>
                  <label>Intervalo (segundos)
                    <input type="number" min="30" max="3600" value={interval} onChange={(e) => setIntervalValue(e.target.value)} />
                  </label>
                </div>
                <label>Servicios críticos a monitorear <span className="field-hint">separados por coma</span>
                  <input value={services} onChange={(e) => setServices(e.target.value)} placeholder="nginx, postgres, sqlservr" />
                </label>
              </div>
            </div>

            <div className="enroll-section">
              <div className="enroll-section-title"><span className="enroll-step">3</span>Conectividad</div>
              <div className="enroll-fields">
                <label>URL del servidor API <span className="field-hint">accesible desde el equipo destino</span>
                  <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://monitor.empresa.com" />
                </label>
                <label>URL de descarga del agente <span className="field-hint">puede ser URL LAN para instalaciones internas</span>
                  <input value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} placeholder="https://monitor.empresa.com/downloads" />
                </label>
                <label>Validez del token
                  <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
                    <option value="1">1 hora</option>
                    <option value="8">8 horas</option>
                    <option value="24">24 horas</option>
                    <option value="72">72 horas</option>
                  </select>
                </label>
              </div>
            </div>

            {error && <p className="form-error">{error}</p>}
            <button className="primary enroll-submit" disabled={loading}>
              {loading ? 'Generando token...' : 'Generar token e instrucciones de instalación'}
            </button>
          </form>
        </div>

        <div className="enroll-sidebar">
          <div className="enroll-info-card">
            <h3>Proceso de instalación</h3>
            <ol className="enroll-steps-list">
              <li><strong>Copia el comando</strong> generado</li>
              <li><strong>Ejecútalo</strong> en el equipo destino como administrador</li>
              <li><strong>El agente se registra</strong> automáticamente con el token</li>
              <li><strong>Aparece en el dashboard</strong> en menos de 60 segundos</li>
            </ol>
          </div>
          <div className="enroll-info-card">
            <h3>El agente recopila</h3>
            <ul className="enroll-feature-list">
              <li>CPU, RAM, swap en tiempo real</li>
              <li>Todos los discos y particiones</li>
              <li>Interfaces de red activas</li>
              <li>Top 10 procesos por consumo</li>
              <li>Estado de servicios configurados</li>
              <li>Inventario de hardware y software (24h)</li>
            </ul>
          </div>
          <div className="enroll-info-card warning-card">
            <h3>⚠️ Conectividad LAN</h3>
            <p>Si instalas en una red local, la URL del servidor debe incluir el puerto correcto. Por ejemplo: <code>http://192.168.1.10:3010</code></p>
          </div>
        </div>
      </div>

      {result && <EnrollResult result={result} platform={platform} />}
    </section>
  );
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

function SettingsPage({ api }) {
  const [tab, setTab] = useState('users');
  return (
    <section>
      <Header title="Configuración" />
      <div className="tab-row">
        <button className={tab === 'users' ? 'selected' : ''} onClick={() => setTab('users')}>Usuarios</button>
        <button className={tab === 'system' ? 'selected' : ''} onClick={() => setTab('system')}>Sistema</button>
      </div>
      {tab === 'users' && <UsersPanel api={api} />}
      {tab === 'system' && <SystemPanel api={api} />}
    </section>
  );
}

function UsersPanel({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/users'), [], 0);
  const [draft, setDraft] = useState({ username: '', password: '', role: 'operator', active: true });
  const [editing, setEditing] = useState(null);
  const [pwModal, setPwModal] = useState(null);
  const [message, setMessage] = useState(null);

  const users = data?.users || [];
  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  async function createUser() {
    if (!draft.username.trim() || !draft.password.trim()) {
      setMessage({ type: 'err', text: 'Usuario y contraseña son obligatorios' });
      return;
    }
    if (draft.password.length < 8) {
      setMessage({ type: 'err', text: 'La contraseña debe tener al menos 8 caracteres' });
      return;
    }
    try {
      await api.post('/api/users', draft);
      setDraft({ username: '', password: '', role: 'operator', active: true });
      setMessage({ type: 'ok', text: 'Usuario creado' });
      reload();
    } catch (e) {
      setMessage({ type: 'err', text: e.message });
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      await api.patch(`/api/users/${editing.id}`, { username: editing.username, role: editing.role, active: editing.active });
      setEditing(null);
      setMessage({ type: 'ok', text: 'Usuario actualizado' });
      reload();
    } catch (e) {
      setMessage({ type: 'err', text: e.message });
    }
  }

  async function savePassword() {
    if (!pwModal || !pwModal.password) return;
    if (pwModal.password.length < 8) {
      setMessage({ type: 'err', text: 'La contraseña debe tener al menos 8 caracteres' });
      return;
    }
    try {
      await api.post(`/api/users/${pwModal.id}/password`, { password: pwModal.password });
      setPwModal(null);
      setMessage({ type: 'ok', text: 'Contraseña actualizada' });
    } catch (e) {
      setMessage({ type: 'err', text: e.message });
    }
  }

  async function removeUser(u) {
    if (u.username === 'admin') return;
    if (!window.confirm(`¿Eliminar al usuario "${u.username}"? Esta acción no se puede deshacer.`)) return;
    try {
      await api.delete(`/api/users/${u.id}`);
      setMessage({ type: 'ok', text: `Usuario "${u.username}" eliminado` });
      reload();
    } catch (e) {
      setMessage({ type: 'err', text: e.message });
    }
  }

  return (
    <Panel title="Usuarios y permisos" action={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />}>
      <p className="panel-hint">Roles: <strong>admin</strong> gestiona todo, <strong>operator</strong> opera reglas y agentes, <strong>viewer</strong> solo lectura.</p>

      <div className="user-create">
        <input placeholder="Usuario" value={draft.username} onChange={(e) => setField('username', e.target.value)} />
        <input type="password" placeholder="Contraseña (≥ 8 caracteres)" value={draft.password} onChange={(e) => setField('password', e.target.value)} />
        <select value={draft.role} onChange={(e) => setField('role', e.target.value)}>
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
        <label className="user-active-toggle"><input type="checkbox" checked={draft.active} onChange={(e) => setField('active', e.target.checked)} /> Activo</label>
        <IconButton icon={Save} label="Crear usuario" onClick={createUser} />
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Creado</th><th>Actualizado</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.username}</strong></td>
                <td><span className={`role-badge ${u.role}`}>{u.role}</span></td>
                <td>{u.active ? <span className="status online">activo</span> : <span className="status offline">inactivo</span>}</td>
                <td className="text-muted">{date(u.created_at)}</td>
                <td className="text-muted">{date(u.updated_at)}</td>
                <td>
                  <div className="actions">
                    <IconButton icon={Edit3} label="Editar" onClick={() => setEditing({ ...u })} />
                    <IconButton icon={KeyRound} label="Cambiar contraseña" onClick={() => setPwModal({ id: u.id, username: u.username, password: '' })} />
                    {u.username !== 'admin' && (
                      <IconButton icon={Trash2} label="Eliminar" onClick={() => removeUser(u)} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan="6" className="empty">Sin usuarios registrados</td></tr>}
          </tbody>
        </table>
      </div>

      {message && <p className={`status-msg ${message.type}`}>{message.text}</p>}

      {editing && (
        <Modal title={`Editar ${editing.username}`} onClose={() => setEditing(null)}>
          <div className="form-grid">
            <label>Usuario<input value={editing.username} onChange={(e) => setEditing({ ...editing, username: e.target.value })} /></label>
            <label>Rol
              <select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option value="admin">admin</option>
                <option value="operator">operator</option>
                <option value="viewer">viewer</option>
              </select>
            </label>
            <label className="user-active-toggle"><input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Activo</label>
          </div>
          <div className="actions modal-actions">
            <button onClick={() => setEditing(null)}>Cancelar</button>
            <button className="primary" onClick={saveEdit}>Guardar</button>
          </div>
        </Modal>
      )}

      {pwModal && (
        <Modal title={`Cambiar contraseña — ${pwModal.username}`} onClose={() => setPwModal(null)}>
          <label>Nueva contraseña <span className="field-hint">mínimo 8 caracteres</span>
            <input type="password" autoFocus value={pwModal.password} onChange={(e) => setPwModal({ ...pwModal, password: e.target.value })} />
          </label>
          <div className="actions modal-actions">
            <button onClick={() => setPwModal(null)}>Cancelar</button>
            <button className="primary" onClick={savePassword}>Actualizar</button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

function SystemPanel({ api }) {
  const { data: version } = useLoad(() => api.get('/api/agent/version').catch(() => ({})), [], 0);
  return (
    <Panel title="Información del sistema">
      <div className="system-grid">
        <div className="system-card">
          <span className="system-label">Versión del agente</span>
          <strong>{version?.version || 'desconocida'}</strong>
          <small>Versión disponible para agentes nuevos</small>
        </div>
        <div className="system-card">
          <span className="system-label">Canales de notificación</span>
          <strong>SMTP y Telegram</strong>
          <small>Configura desde la pestaña Alertas → SMTP / Telegram</small>
        </div>
        <div className="system-card">
          <span className="system-label">Reglas de alertas</span>
          <strong>Globales y por equipo</strong>
          <small>Configura desde Alertas → Reglas (globales) o desde el detalle del equipo</small>
        </div>
      </div>
    </Panel>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar">×</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function AlertsCenter({ api }) {
  const [tab, setTab] = useState('alerts');
  return (
    <section>
      <Header title="Alertas" />
      <div className="tab-row">
        <button className={tab === 'alerts' ? 'selected' : ''} onClick={() => setTab('alerts')}>Alertas activas</button>
        <button className={tab === 'stats' ? 'selected' : ''} onClick={() => setTab('stats')}>Estadísticas</button>
        <button className={tab === 'timeline' ? 'selected' : ''} onClick={() => setTab('timeline')}>Timeline</button>
        <button className={tab === 'rules' ? 'selected' : ''} onClick={() => setTab('rules')}>Reglas</button>
        <button className={tab === 'smtp' ? 'selected' : ''} onClick={() => setTab('smtp')}>SMTP</button>
        <button className={tab === 'telegram' ? 'selected' : ''} onClick={() => setTab('telegram')}>Telegram</button>
      </div>
      {tab === 'alerts' && <Alerts api={api} />}
      {tab === 'stats' && <AlertStats api={api} />}
      {tab === 'timeline' && <AlertTimeline api={api} />}
      {tab === 'rules' && <AlertRulesPanel api={api} />}
      {tab === 'smtp' && <SMTPSettings api={api} />}
      {tab === 'telegram' && <TelegramSettings api={api} />}
    </section>
  );
}

function AlertStats({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/alerts/stats'), [], 0);
  const rows = data?.stats || [];
  return (
    <Panel title="Estadísticas por agente" action={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />}>
      {rows.length === 0 ? (
        <p className="empty-panel">Sin historial de alertas</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Agente</th>
              <th>Alertas activas</th>
              <th>Críticas (total)</th>
              <th>Warnings (total)</th>
              <th>Última alerta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={row.active_count > 0 ? { background: 'rgba(220,38,38,0.08)', color: 'var(--red, #dc2626)' } : {}}>
                <td>{row.agent_name}</td>
                <td>{row.active_count}</td>
                <td>{row.critical_total}</td>
                <td>{row.warning_total}</td>
                <td>{row.last_alert_at ? timeAgo(row.last_alert_at) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function AlertTimeline({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/alerts?active=false'), [], 0);
  const alerts = (data?.alerts || []).slice(0, 50);
  return (
    <Panel title="Timeline de alertas" action={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />}>
      {alerts.length === 0 ? (
        <p className="empty-panel">Sin historial de alertas</p>
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => {
            let duration = null;
            if (alert.resolved_at) {
              const diffMs = new Date(alert.resolved_at).getTime() - new Date(alert.opened_at).getTime();
              const diffMins = Math.floor(diffMs / 60000);
              duration = diffMins < 60 ? `${diffMins}m` : `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
            }
            return (
              <article className={`alert-card sev-${alert.severity}`} key={alert.id}>
                <AlertTriangle size={18} style={{ color: alert.severity === 'critical' ? '#dc2626' : '#d97706' }} />
                <div>
                  <strong>{alert.agent_name} · {alert.metric || alert.message}</strong>
                  <span>
                    {timeAgo(alert.opened_at)}
                    {duration && <> · Resuelta en {duration}</>}
                    {alert.active && <> · <span className="sev-badge critical">ACTIVA</span></>}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function Alerts({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/alerts'), [], REFRESH_MS);
  const alerts = data?.alerts || [];
  const unseenCount = alerts.filter((a) => !a.seen_at).length;
  async function markAll() {
    if (!unseenCount) return;
    await api.post('/api/alerts/seen-all', {});
    reload();
  }
  return (
    <Panel
      title={`Alertas activas${unseenCount ? ` · ${unseenCount} sin ver` : ''}`}
      action={
        <div className="actions">
          {unseenCount > 0 && <IconButton icon={Eye} label="Marcar todas vistas" onClick={markAll} />}
          <RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />
        </div>
      }
    >
      <AlertList alerts={alerts} api={api} onChange={reload} />
    </Panel>
  );
}

function SMTPSettings({ api }) {
  const { data, reload } = useLoad(() => api.get('/api/alert-settings/smtp'), [], 0);
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { if (data && !form) setForm({ ...data, password: '' }); }, [data, form]);
  if (!form) return <Skeleton />;
  const set = (key, value) => setForm((next) => ({ ...next, [key]: value }));
  async function save() {
    const cooldown = Math.max(1, parseInt(form.cooldown_minutes, 10) || 30);
    const saved = await api.put('/api/alert-settings/smtp', { ...form, port: Number(form.port) || 587, cooldown_minutes: cooldown });
    setForm({ ...saved, password: '' });
    setMessage('Configuracion guardada');
    reload();
  }
  async function test() {
    const cooldown = Math.max(1, parseInt(form.cooldown_minutes, 10) || 30);
    await api.post('/api/alert-settings/smtp/test', { ...form, port: Number(form.port) || 587, cooldown_minutes: cooldown });
    setMessage('Correo de prueba enviado');
  }
  return (
    <Panel title="Configuracion SMTP" action={<div className="actions"><IconButton icon={Send} label="Probar SMTP" onClick={test} /><IconButton icon={Mail} label="Guardar SMTP" onClick={save} /></div>}>
      <div className="smtp-grid">
        <label><span><input type="checkbox" checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Habilitar correos</span></label>
        <label>Host<input value={form.host} onChange={(e) => set('host', e.target.value)} /></label>
        <label>Puerto<input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} /></label>
        <label>Usuario<input value={form.username} onChange={(e) => set('username', e.target.value)} /></label>
        <label>Contrasena<input type="password" value={form.password} placeholder="Mantener actual si se deja vacia" onChange={(e) => set('password', e.target.value)} /></label>
        <label>Remitente<input value={form.from_address} onChange={(e) => set('from_address', e.target.value)} /></label>
        <label>Destinatarios<input value={form.to_addresses} onChange={(e) => set('to_addresses', e.target.value)} placeholder="ops@empresa.com,infra@empresa.com" /></label>
        <label>Cooldown minutos<input type="number" min="1" value={form.cooldown_minutes} onChange={(e) => set('cooldown_minutes', e.target.value)} /></label>
        <label><span><input type="checkbox" checked={!!form.use_tls} onChange={(e) => set('use_tls', e.target.checked)} /> TLS directo</span></label>
        <label><span><input type="checkbox" checked={!!form.use_starttls} onChange={(e) => set('use_starttls', e.target.checked)} /> STARTTLS</span></label>
      </div>
      {message && <p className="success-text">{message}</p>}
    </Panel>
  );
}

function TelegramSettings({ api }) {
  const { data, reload } = useLoad(() => api.get('/api/settings/telegram'), [], 0);
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { if (data && !form) setForm({ ...data, bot_token: '' }); }, [data, form]);
  if (!form) return <Skeleton />;
  const set = (key, value) => setForm((next) => ({ ...next, [key]: value }));
  async function save() {
    const cooldown = Math.max(1, parseInt(form.cooldown_minutes, 10) || 30);
    const saved = await api.put('/api/settings/telegram', { ...form, cooldown_minutes: cooldown });
    setForm({ ...saved, bot_token: '' });
    setMessage('Configuracion guardada');
    reload();
  }
  async function test() {
    const cooldown = Math.max(1, parseInt(form.cooldown_minutes, 10) || 30);
    await api.post('/api/settings/telegram/test', { ...form, cooldown_minutes: cooldown });
    setMessage('Mensaje de prueba enviado');
  }
  return (
    <Panel title="Configuracion Telegram" action={<div className="actions"><IconButton icon={Send} label="Probar Telegram" onClick={test} /><IconButton icon={Bell} label="Guardar Telegram" onClick={save} /></div>}>
      <div className="smtp-grid">
        <label><span><input type="checkbox" checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Habilitar Telegram</span></label>
        <label>Bot Token<input type="password" value={form.bot_token} placeholder="Mantener actual si se deja vacio" onChange={(e) => set('bot_token', e.target.value)} /></label>
        <label>Chat IDs<input value={form.chat_ids} onChange={(e) => set('chat_ids', e.target.value)} placeholder="-100123456789,@canal" /></label>
        <label>Modo parse
          <select value={form.parse_mode || 'HTML'} onChange={(e) => set('parse_mode', e.target.value)}>
            <option value="HTML">HTML</option>
            <option value="Markdown">Markdown</option>
            <option value="MarkdownV2">MarkdownV2</option>
          </select>
        </label>
        <label>Cooldown minutos<input type="number" min="1" value={form.cooldown_minutes} onChange={(e) => set('cooldown_minutes', e.target.value)} /></label>
      </div>
      {message && <p className="success-text">{message}</p>}
    </Panel>
  );
}

const METRIC_LABELS = { cpu: 'CPU', ram: 'RAM', disk_used_percent: 'Disco', network_recv_mbps: 'Red recv', network_sent_mbps: 'Red sent', agent_offline_minutes: 'Sin conexion' };
const METRIC_UNITS = { cpu: '%', ram: '%', disk_used_percent: '%', network_recv_mbps: 'Mbps', network_sent_mbps: 'Mbps', agent_offline_minutes: 'min' };

function AlertRulesPanel({ api }) {
  const [rules, setRules] = useState(null);
  const [smtpOk, setSmtpOk] = useState(false);
  const [telegramOk, setTelegramOk] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/api/alert-rules/defaults'),
      api.get('/api/alert-settings/smtp'),
      api.get('/api/settings/telegram'),
    ]).then(([rulesData, smtp, tg]) => {
      if (!alive) return;
      setRules(rulesData.rules || []);
      setSmtpOk(!!(smtp.enabled && smtp.host));
      setTelegramOk(!!(tg.enabled && tg.chat_ids));
    }).catch(console.error);
    return () => { alive = false; };
  }, []);

  if (!rules) return <Skeleton />;

  const setRule = (idx, key, value) =>
    setRules((prev) => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));

  async function save() {
    const validated = rules.map((r) => ({
      ...r,
      threshold: parseFloat(r.threshold) || 0,
      duration_samples: Math.max(1, parseInt(r.duration_samples, 10) || 2),
      cooldown_minutes: Math.max(1, parseInt(r.cooldown_minutes, 10) || 30),
    }));
    try {
      const saved = await api.put('/api/alert-rules/defaults', { rules: validated });
      setRules(saved.rules || []);
      setMessage('Reglas guardadas');
    } catch (e) {
      setMessage('Error: ' + e.message);
    }
  }

  return (
    <Panel title="Reglas globales de alerta" action={<IconButton icon={Save} label="Guardar reglas" onClick={save} />}>
      {!smtpOk && <p className="warn-inline">SMTP no habilitado — activa SMTP en la pestaña SMTP para usar notificaciones por email</p>}
      {!telegramOk && <p className="warn-inline">Telegram no habilitado — configura Telegram en la pestaña Telegram para usar notificaciones por Telegram</p>}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Metrica</th>
              <th>Severidad</th>
              <th>Umbral</th>
              <th>Muestras</th>
              <th>Cooldown (min)</th>
              <th>Activa</th>
              <th>Email</th>
              <th>Telegram</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule, i) => (
              <tr key={`${rule.metric}-${rule.resource_key}-${rule.severity}`}>
                <td>{METRIC_LABELS[rule.metric] || rule.metric}{rule.resource_key ? ` (${rule.resource_key})` : ''}</td>
                <td><span className={`sev-badge ${rule.severity}`}>{rule.severity}</span></td>
                <td>
                  <input type="number" min="0" step="any" value={rule.threshold}
                    onChange={(e) => setRule(i, 'threshold', e.target.value)} style={{ width: '70px' }} />
                  <small style={{ marginLeft: '4px', color: 'var(--muted, #64748b)' }}>{METRIC_UNITS[rule.metric] || ''}</small>
                </td>
                <td>
                  <input type="number" min="1" max="20" value={rule.duration_samples}
                    onChange={(e) => setRule(i, 'duration_samples', e.target.value)} style={{ width: '55px' }} />
                </td>
                <td>
                  <input type="number" min="1" value={rule.cooldown_minutes}
                    onChange={(e) => setRule(i, 'cooldown_minutes', e.target.value)} style={{ width: '65px' }} />
                </td>
                <td><input type="checkbox" checked={!!rule.enabled} onChange={(e) => setRule(i, 'enabled', e.target.checked)} /></td>
                <td>
                  <input type="checkbox" checked={!!rule.notify_email}
                    disabled={!smtpOk}
                    title={smtpOk ? '' : 'Configura y activa SMTP primero'}
                    onChange={(e) => setRule(i, 'notify_email', e.target.checked)} />
                </td>
                <td>
                  <input type="checkbox" checked={!!rule.notify_telegram}
                    disabled={!telegramOk}
                    title={telegramOk ? '' : 'Configura y activa Telegram primero'}
                    onChange={(e) => setRule(i, 'notify_telegram', e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {message && <p className="success-text">{message}</p>}
    </Panel>
  );
}

function Header({ title, meta }) {
  return <header className="page-header"><div><h1>{title}</h1></div>{meta}</header>;
}

function Panel({ title, action, children }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

function Kpi({ icon: Icon, label, value, tone = '' }) {
  return <article className={`kpi ${tone}`}><Icon size={22} /><span>{label}</span><strong>{value}</strong></article>;
}

function MetricTile({ label, value, hint, tone = '' }) {
  return <article className={`metric-tile ${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>;
}

function Ring({ label, value, main, total, color }) {
  const safeValue = Math.max(0, Math.min(Number(value || 0), 100));
  return (
    <div className="ring-card">
      <div className="ring" style={{ background: `conic-gradient(${color} ${safeValue * 3.6}deg, #d9dee6 0deg)` }}>
        <span>{round(safeValue)}%</span>
      </div>
      <strong>{label}</strong>
      <small>{main || '0 B'} / {total || '0 B'}</small>
    </div>
  );
}

function ChartPanel({ title, subtitle, unit, children }) {
  return (
    <section className="panel chart-panel">
      <div className="panel-head chart-head">
        <div><h2>{title}</h2><span>{subtitle}</span></div>
        <small>{unit}</small>
      </div>
      {children}
    </section>
  );
}

function Status({ status }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function StatusDonut({ counts }) {
  const online = Number(counts.online || 0);
  const warning = Number(counts.warning || 0);
  const critical = Number(counts.critical || 0);
  const offline = Number(counts.offline || 0);
  const total = online + warning + critical + offline || 1;
  const pct = Math.round((online / total) * 100);
  const tone = critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'online';
  return (
    <div className={`status-donut tone-${tone}`}>
      <Gauge size={36} />
      <span>{pct}%</span>
      <small>{online} de {total} online</small>
    </div>
  );
}

function MiniAgentList({ agents, metric, empty = 'Sin datos' }) {
  if (!agents.length) return <p className="empty-panel">{empty}</p>;
  return <div className="mini-list">{agents.map((agent) => <div key={agent.id}><strong>{agent.name}</strong><span>{metric ? percent(agent[metric]) : date(agent.last_metric_at)}</span></div>)}</div>;
}

const RULE_GROUPS = [
  { metric: 'cpu', title: 'CPU', unit: '%', icon: Cpu },
  { metric: 'ram', title: 'Memoria RAM', unit: '%', icon: MemoryStick },
  { metric: 'network_recv_mbps', title: 'Red recibida', unit: 'Mbps', icon: Network },
  { metric: 'network_sent_mbps', title: 'Red enviada', unit: 'Mbps', icon: Network },
  { metric: 'agent_offline_minutes', title: 'Conexión perdida', unit: 'min', icon: ShieldAlert },
];

function AgentRulesTab({ api, agentId }) {
  const [rules, setRules] = useState(null);
  const [smtpOk, setSmtpOk] = useState(false);
  const [telegramOk, setTelegramOk] = useState(false);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadAll = () => {
    let alive = true;
    Promise.all([
      api.get(`/api/agents/${agentId}/alert-rules`),
      api.get('/api/alert-settings/smtp'),
      api.get('/api/settings/telegram'),
    ]).then(([rulesData, smtp, tg]) => {
      if (!alive) return;
      setRules(rulesData.rules || []);
      setSmtpOk(!!(smtp.enabled && smtp.host));
      setTelegramOk(!!(tg.enabled && tg.chat_ids));
    }).catch((e) => alive && setMessage({ type: 'err', text: 'Error cargando reglas: ' + e.message }));
    return () => { alive = false; };
  };

  useEffect(loadAll, [agentId]);

  if (!rules) return <Skeleton />;

  const setRule = (id, key, value) =>
    setRules((prev) => prev.map((r) => r.id === id ? { ...r, [key]: value } : r));

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const payload = rules.map((r) => ({
        ...r,
        threshold: parseFloat(r.threshold) || 0,
        duration_samples: Math.max(1, parseInt(r.duration_samples, 10) || 2),
        cooldown_minutes: Math.max(1, parseInt(r.cooldown_minutes, 10) || 30),
      }));
      const saved = await api.put(`/api/agents/${agentId}/alert-rules`, { rules: payload });
      setRules(saved.rules || []);
      setMessage({ type: 'ok', text: 'Reglas guardadas correctamente' });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error: ' + e.message });
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!window.confirm('¿Restaurar reglas globales? Esto eliminará todas las personalizaciones de este equipo.')) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.post(`/api/agents/${agentId}/alert-rules/reset`, {});
      const fresh = await api.get(`/api/agents/${agentId}/alert-rules`);
      setRules(fresh.rules || []);
      setMessage({ type: 'ok', text: 'Reglas restauradas a defaults globales' });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error: ' + e.message });
    } finally {
      setSaving(false);
    }
  }

  const diskRules = rules.filter((r) => r.metric === 'disk_used_percent');
  const diskKeys = [...new Set(diskRules.map((r) => r.resource_key))];
  const overrideCount = rules.filter((r) => r.source === 'agent').length;

  return (
    <Panel
      title="Reglas de alertas"
      action={
        <div className="actions">
          <IconButton icon={RefreshCw} label="Restaurar" onClick={reset} disabled={saving} />
          <IconButton icon={Save} label={saving ? 'Guardando…' : 'Guardar reglas'} onClick={save} disabled={saving} />
        </div>
      }
    >
      <p className="panel-hint">
        Personaliza umbrales y notificaciones para este equipo. Las reglas que no modifiques heredan los valores globales.
        {overrideCount > 0 && <> · <strong>{overrideCount}</strong> regla{overrideCount !== 1 ? 's' : ''} personalizada{overrideCount !== 1 ? 's' : ''}.</>}
      </p>

      {!smtpOk && <p className="warn-inline">SMTP no configurado — actívalo en pestaña SMTP para usar notificaciones por email</p>}
      {!telegramOk && <p className="warn-inline">Telegram no configurado — actívalo en pestaña Telegram para usar notificaciones</p>}

      <div className="rules-grid">
        {RULE_GROUPS.map((group) => {
          const groupRules = rules.filter((r) => r.metric === group.metric).sort((a, b) => a.severity === 'critical' ? 1 : -1);
          if (groupRules.length === 0) return null;
          const Icon = group.icon;
          return (
            <article key={group.metric} className="rules-card">
              <header className="rules-card-head"><Icon size={16} /><h3>{group.title}</h3></header>
              {groupRules.map((rule) => (
                <RuleRow key={rule.id} rule={rule} unit={group.unit} smtpOk={smtpOk} telegramOk={telegramOk} onChange={(k, v) => setRule(rule.id, k, v)} />
              ))}
            </article>
          );
        })}
      </div>

      {diskRules.length > 0 && (
        <article className="rules-card rules-disk-card">
          <header className="rules-card-head"><HardDrive size={16} /><h3>Discos por unidad / mount</h3></header>
          <div className="table-wrap">
            <table className="rules-disk-table">
              <thead>
                <tr>
                  <th>Recurso</th>
                  <th>Uso</th>
                  <th>Warning</th>
                  <th>Critical</th>
                  <th>Activa</th>
                  <th>Email</th>
                  <th>Telegram</th>
                </tr>
              </thead>
              <tbody>
                {diskKeys.map((key) => {
                  const warn = diskRules.find((r) => r.resource_key === key && r.severity === 'warning');
                  const crit = diskRules.find((r) => r.resource_key === key && r.severity === 'critical');
                  const usage = warn?.current_value ?? crit?.current_value;
                  return (
                    <tr key={key || 'default'}>
                      <td className="rules-disk-key"><strong>{key || 'Default'}</strong></td>
                      <td>{usage != null ? <span className="usage-pill">{Number(usage).toFixed(1)}%</span> : '—'}</td>
                      <td><input type="number" min="0" max="100" value={warn?.threshold ?? ''} onChange={(e) => warn && setRule(warn.id, 'threshold', e.target.value)} disabled={!warn} /></td>
                      <td><input type="number" min="0" max="100" value={crit?.threshold ?? ''} onChange={(e) => crit && setRule(crit.id, 'threshold', e.target.value)} disabled={!crit} /></td>
                      <td>
                        <input type="checkbox" checked={!!(warn?.enabled || crit?.enabled)} onChange={(e) => {
                          if (warn) setRule(warn.id, 'enabled', e.target.checked);
                          if (crit) setRule(crit.id, 'enabled', e.target.checked);
                        }} />
                      </td>
                      <td><input type="checkbox" checked={!!crit?.notify_email} disabled={!smtpOk || !crit} title={smtpOk ? 'Notificar critical por email' : 'Configura SMTP primero'} onChange={(e) => crit && setRule(crit.id, 'notify_email', e.target.checked)} /></td>
                      <td><input type="checkbox" checked={!!crit?.notify_telegram} disabled={!telegramOk || !crit} title={telegramOk ? 'Notificar critical por telegram' : 'Configura Telegram primero'} onChange={(e) => crit && setRule(crit.id, 'notify_telegram', e.target.checked)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      )}

      <footer className="rules-help">
        <div><strong>Duración</strong><span>Muestras consecutivas sobre umbral antes de abrir alerta.</span></div>
        <div><strong>Cooldown</strong><span>Minutos mínimos entre re-notificaciones del mismo canal.</span></div>
        <div><strong>Source</strong><span>Reglas con badge "agent" están personalizadas para este equipo.</span></div>
      </footer>

      {message && <p className={`status-msg ${message.type}`}>{message.text}</p>}
    </Panel>
  );
}

function RuleRow({ rule, unit, smtpOk, telegramOk, onChange }) {
  return (
    <div className="rule-row">
      <div className="rule-meta">
        <span className={`sev-badge ${rule.severity}`}>{rule.severity}</span>
        {rule.source === 'agent' && <span className="rule-source" title="Override personalizado para este equipo">custom</span>}
      </div>
      <div className="rule-fields">
        <label className="rule-field">
          <span>Umbral ({unit})</span>
          <input type="number" min="0" step="any" value={rule.threshold} onChange={(e) => onChange('threshold', e.target.value)} />
          {rule.current_value != null && <small className="rule-current">actual: {Number(rule.current_value).toFixed(1)}{unit}</small>}
        </label>
        <label className="rule-field">
          <span>Duración</span>
          <input type="number" min="1" max="20" value={rule.duration_samples} onChange={(e) => onChange('duration_samples', e.target.value)} />
        </label>
        <label className="rule-field">
          <span>Cooldown (min)</span>
          <input type="number" min="1" value={rule.cooldown_minutes} onChange={(e) => onChange('cooldown_minutes', e.target.value)} />
        </label>
      </div>
      <div className="rule-toggles">
        <label className="rule-toggle"><input type="checkbox" checked={!!rule.enabled} onChange={(e) => onChange('enabled', e.target.checked)} /> Activa</label>
        <label className={`rule-toggle email ${smtpOk ? '' : 'disabled'}`} title={smtpOk ? '' : 'Configura SMTP primero'}>
          <input type="checkbox" checked={!!rule.notify_email} disabled={!smtpOk} onChange={(e) => onChange('notify_email', e.target.checked)} /> Email
        </label>
        <label className={`rule-toggle telegram ${telegramOk ? '' : 'disabled'}`} title={telegramOk ? '' : 'Configura Telegram primero'}>
          <input type="checkbox" checked={!!rule.notify_telegram} disabled={!telegramOk} onChange={(e) => onChange('notify_telegram', e.target.checked)} /> Telegram
        </label>
      </div>
    </div>
  );
}

function AlertList({ alerts, compact = false, api = null, onChange = null }) {
  if (!alerts.length) return <p className="empty-panel">Sin alertas activas ✓</p>;
  async function markSeen(id) {
    if (!api) return;
    await api.post(`/api/alerts/${id}/seen`, {});
    onChange && onChange();
  }
  const fmt = (v, u) => v == null ? '—' : `${Number(v).toFixed(1)}${(u || '').trim()}`;
  return (
    <div className={`alert-list ${compact ? 'compact' : ''}`}>
      {alerts.map((alert) => (
        <article className={`alert-card sev-${alert.severity} ${alert.seen_at ? 'is-seen' : ''}`} key={alert.id}>
          <AlertTriangle size={18} />
          <div className="alert-body">
            <div className="alert-headline">
              <span className={`sev-badge ${alert.severity}`}>{alert.severity}</span>
              <strong>{alert.agent_name}</strong>
              {alert.resource_key && <span className="alert-resource">{alert.resource_key}</span>}
              {!alert.active && <span className="sev-badge resolved">resuelta</span>}
              {alert.seen_at && <span className="sev-badge seen">vista</span>}
            </div>
            <p className="alert-message">{alert.message}</p>
            {(alert.observed_value != null || alert.threshold_value != null) && (
              <div className="alert-values">
                <span>Valor: <strong>{fmt(alert.observed_value, alert.unit)}</strong></span>
                <span>Umbral: <strong>{fmt(alert.threshold_value, alert.unit)}</strong></span>
                {alert.duration_samples > 0 && <span>Muestras: <strong>{alert.duration_samples}</strong></span>}
              </div>
            )}
            <div className="alert-meta">
              <span>{timeAgo(alert.opened_at)}</span>
              {alert.notify_email && <span title="Notifica por email">· ✉ email</span>}
              {alert.notify_telegram && <span title="Notifica por telegram">· ✈ telegram</span>}
              {api && !alert.seen_at && (
                <button className="link-btn" onClick={() => markSeen(alert.id)}>Marcar vista</button>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

function DisksTable({ disks }) {
  return <DataTable empty="Sin muestras de disco" columns={['Unidad / Disco', 'Mount', 'FS', 'Total', 'Usado', 'Libre', 'Uso']} rows={disks.map((d) => [diskLabel(d), d.mountpoint, d.filesystem, bytes(d.total_bytes), bytes(d.used_bytes), bytes(d.free_bytes), <Usage value={d.used_percent} />])} />;
}

function NetworkTable({ networks }) {
  return <DataTable empty="Sin muestras de red" columns={['Interfaz', 'Estado', 'Recibido', 'Enviado']} rows={networks.map((n) => [n.name, <span className={`net-state ${n.up ? 'up' : 'down'}`}>{n.up ? '● up' : '○ down'}</span>, bytes(n.bytes_recv), bytes(n.bytes_sent)])} />;
}

function ProcessesTable({ processes }) {
  return <DataTable empty="Sin procesos destacados" columns={['Proceso', 'PID', 'CPU', 'RAM']} rows={processes.map((p) => [p.name, p.pid, percent(p.cpu_percent), percent(p.memory_percent)])} />;
}

function ServicesTable({ services }) {
  return <DataTable empty="Sin servicios configurados" columns={['Servicio', 'Estado']} rows={services.map((s) => [s.name, <span className={`svc-state ${s.status === 'running' ? 'ok' : 'err'}`}>{s.status}</span>])} />;
}

function DataTable({ columns, rows, empty }) {
  return <div className="table-wrap"><table><thead><tr>{columns.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={columns.length} className="empty">{empty}</td></tr>}</tbody></table></div>;
}

function HardwareTab({ hardware, onRefresh }) {
  if (!hardware) return <EmptyState icon="🖥️" title="Sin datos de hardware" subtitle="El agente enviará el inventario de hardware en su próxima sincronización (24h)." />;
  const rows = [
    ['CPU', hardware.cpu_model || '—'],
    ['Fabricante', hardware.cpu_vendor || '—'],
    ['Núcleos físicos', hardware.cpu_cores_physical || '—'],
    ['Núcleos lógicos', hardware.cpu_cores_logical || '—'],
    ['Frecuencia base', hardware.cpu_mhz ? `${hardware.cpu_mhz.toFixed(0)} MHz` : '—'],
    ['RAM total', hardware.memory_total_gb ? `${hardware.memory_total_gb.toFixed(1)} GB` : '—'],
    ['Arquitectura', hardware.arch || '—'],
    ['Kernel', hardware.kernel_version || '—'],
    ['Virtualización', hardware.virtualization || 'Ninguna detectada'],
    ['Capturado', hardware.captured_at ? new Date(hardware.captured_at).toLocaleString() : '—'],
  ];
  return (
    <div>
      {onRefresh && (
        <div className="actions" style={{ marginBottom: 12 }}>
          <IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar inventario" />
        </div>
      )}
      <div className="hw-grid">
        {rows.map(([label, value]) => (
          <div key={label} className="hw-row">
            <span className="hw-label">{label}</span>
            <span className="hw-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SoftwareTab({ software, onRefresh }) {
  const [q, setQ] = useState('');
  if (!software) return <EmptyState icon="📦" title="Sin inventario de software" subtitle="El agente enviará el inventario en su próxima sincronización (24h)." />;
  const filtered = q ? software.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || (s.publisher || '').toLowerCase().includes(q.toLowerCase())) : software;
  return (
    <div>
      <div className="sw-search">
        {onRefresh && <IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar inventario" />}
        <input className="sw-input" placeholder={`Buscar en ${software.length} programas...`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <DataTable
        empty="Sin resultados"
        columns={['Programa', 'Versión', 'Editor']}
        rows={filtered.map((s) => [s.name, s.version || '—', s.publisher || '—'])}
      />
    </div>
  );
}

function Usage({ value }) {
  return <div className="usage"><span style={{ width: `${Math.min(value || 0, 100)}%` }} /><strong>{round(value)}%</strong></div>;
}

function generateTimeGrid(range) {
  const now = Date.now();
  const cfg = {
    '1h':  { ms:      60 * 60 * 1000, step:      60 * 1000 },
    '6h':  { ms:  6 * 60 * 60 * 1000, step:  5 * 60 * 1000 },
    '12h': { ms: 12 * 60 * 60 * 1000, step:  5 * 60 * 1000 },
    '24h': { ms: 24 * 60 * 60 * 1000, step:  5 * 60 * 1000 },
    '7d':  { ms:  7 * 24 * 60 * 60 * 1000, step: 60 * 60 * 1000 },
    '30d': { ms: 30 * 24 * 60 * 60 * 1000, step: 6 * 60 * 60 * 1000 },
  };
  const { ms, step } = cfg[range] || cfg['24h'];
  const start = now - ms;
  const grid = [];
  for (let t = start; t <= now + step; t += step) {
    grid.push(Math.floor(t / step) * step);
  }
  return grid;
}

function padHistoryToGrid(data, grid, keys) {
  if (!grid?.length) return [];
  const emptyRow = (tsMs) => {
    const row = { captured_at: new Date(tsMs).toISOString() };
    keys.forEach((k) => { row[k] = null; });
    return row;
  };
  if (!data?.length) return grid.map(emptyRow);
  const stepMs = grid.length > 1 ? grid[1] - grid[0] : 60000;
  const byBucket = {};
  data.forEach((p) => {
    const t = new Date(p.captured_at).getTime();
    const bucket = Math.round(t / stepMs) * stepMs;
    byBucket[bucket] = p;
  });
  return grid.map((tsMs) => {
    const match = byBucket[tsMs];
    if (match) return { ...match, captured_at: new Date(tsMs).toISOString() };
    return emptyRow(tsMs);
  });
}

function LineChart({ points, grid, series, max, formatter }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const displayPoints = (points?.length ? points : grid)?.map((p) => (typeof p === 'string' ? { captured_at: p } : p)) || [];
  if (!displayPoints.length) return <div className="empty-chart">Sin historial disponible</div>;

  const hasAnyData = series.some(([, key]) => displayPoints.some((p) => p[key] != null));
  const chartMax = max || Math.max(1, ...series.flatMap(([, key]) => displayPoints.map((p) => p[key] != null ? Number(p[key]) : 0)));
  const activePoint = hoverIndex === null ? null : displayPoints[hoverIndex];
  const activeX = hoverIndex === null ? 0 : displayPoints.length > 1 ? (hoverIndex / (displayPoints.length - 1)) * 100 : 0;
  const yTicks = axisTicks(chartMax, formatter);
  const xTicks = timeTicks(displayPoints);
  const setHover = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setHoverIndex(Math.round(ratio * (displayPoints.length - 1)));
  };
  return (
    <div className="chart-shell">
      <div className="legend">{series.map(([label,, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
      <div className="chart-frame">
        <div className="chart-axis y-axis">{yTicks.map((tick, index) => <span key={`${tick}-${index}`}>{tick}</span>)}</div>
        <div className="chart-plot" onMouseMove={setHover} onMouseLeave={() => setHoverIndex(null)}>
          <svg className="chart" viewBox="0 0 100 52" preserveAspectRatio="none">
            <path d="M0 8 H100" /><path d="M0 18 H100" /><path d="M0 28 H100" /><path d="M0 38 H100" /><path d="M0 48 H100" />
            {activePoint && <line className="chart-cursor" x1={activeX} x2={activeX} y1="8" y2="48" />}
            {hasAnyData && series.map(([label, key, color]) => (
              <path key={label} className="chart-line" d={polylinePath(displayPoints, key, chartMax)} style={{ stroke: color }} />
            ))}
            {activePoint && series.map(([label, key, color]) => {
              if (activePoint[key] == null) return null;
              const y = 48 - (Math.max(0, Number(activePoint[key])) / chartMax) * 40;
              return <circle key={`${label}-dot`} cx={activeX} cy={y} r="1.4" style={{ fill: color, stroke: 'none' }} />;
            })}
          </svg>
          {!hasAnyData && <div className="chart-no-data">Sin datos en este rango</div>}
          {activePoint && (
            <div className="chart-tooltip" style={{ left: `${Math.min(Math.max(activeX, 12), 88)}%` }}>
              <strong>{timeLabel(activePoint.captured_at)}</strong>
              {series.map(([label, key, color]) => (
                <span key={label}><i style={{ background: color }} />{label}
                  <b>{activePoint[key] != null ? (formatter ? formatter(activePoint[key]) : `${round(activePoint[key])}%`) : '—'}</b>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="chart-scale">{xTicks.map((tick, index) => <span key={`${tick}-${index}`}>{tick}</span>)}</div>
    </div>
  );
}

function axisTicks(maxValue, formatter) {
  return [1, 0.75, 0.5, 0.25, 0].map((ratio) => formatter ? formatter(maxValue * ratio) : `${round(maxValue * ratio)}%`);
}

function timeTicks(points) {
  if (!points?.length) return [];
  const maxIndex = Math.max(points.length - 1, 1);
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => points[Math.round(ratio * maxIndex)]).filter(Boolean).map((point) => timeLabel(point.captured_at));
}

function polylinePath(points, key, maxValue) {
  let d = '';
  const maxIndex = Math.max(points.length - 1, 1);
  let penUp = true;
  points.forEach((p, index) => {
    if (p[key] == null) { penUp = true; return; }
    const x = ((index / maxIndex) * 100).toFixed(2);
    const y = (48 - (Math.max(0, Number(p[key])) / maxValue) * 40).toFixed(2);
    d += penUp ? `M${x},${y}` : `L${x},${y}`;
    penUp = false;
  });
  return d;
}

function pivotDisks(disks, names, grid) {
  const emptyRow = (tsMs) => {
    const row = { captured_at: new Date(tsMs).toISOString() };
    names.forEach((n) => { row[n] = null; });
    return row;
  };
  const stepMs = grid?.length > 1 ? grid[1] - grid[0] : 60000;
  const byBucket = {};
  disks.forEach((disk) => {
    const t = new Date(disk.captured_at).getTime();
    const bucket = Math.round(t / stepMs) * stepMs;
    byBucket[bucket] = byBucket[bucket] || { _ts: bucket };
    const name = disk.mountpoint || disk.name;
    if (names.includes(name)) byBucket[bucket][name] = disk.used_percent;
  });
  if (!grid?.length) {
    return Object.values(byBucket).map((r) => {
      const row = { captured_at: new Date(r._ts).toISOString() };
      names.forEach((n) => { row[n] = r[n] ?? null; });
      return row;
    }).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  }
  return grid.map((tsMs) => {
    const r = byBucket[tsMs];
    if (!r) return emptyRow(tsMs);
    const row = { captured_at: new Date(tsMs).toISOString() };
    names.forEach((n) => { row[n] = r[n] ?? null; });
    return row;
  });
}

function latestDiskValues(disks) {
  const latest = {};
  disks.forEach((disk) => {
    const key = disk.mountpoint || disk.name;
    if (!key) return;
    if (!latest[key] || new Date(disk.captured_at || 0) >= new Date(latest[key].captured_at || 0)) latest[key] = disk;
  });
  return Object.values(latest);
}

function lastItem(items) {
  return items?.length ? items[items.length - 1] : null;
}

function timeLabel(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return 'n/a';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function toneFor(value, warning, critical) {
  const numeric = Number(value || 0);
  if (numeric >= critical) return 'bad';
  if (numeric >= warning) return 'warn';
  return 'good';
}

function rate(value) {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let next = Number(value || 0);
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 ? 0 : next >= 100 ? 0 : next >= 10 ? 1 : 2;
  return `${next.toFixed(decimals)} ${units[unit]}`;
}

function WizardStep({ index, title, children }) {
  return <div className="wizard-step"><strong>{index}</strong><div><h2>{title}</h2>{children}</div></div>;
}

function EnrollResult({ result, platform }) {
  const [showOther, setShowOther] = useState(false);
  const isLinux = platform === 'linux';
  const primaryTitle = isLinux ? 'Linux systemd' : 'Windows PowerShell admin';
  const primaryCmd = isLinux ? (result.linux_install_command || result.install_command) : (result.windows_install_command || result.install_command);
  const otherTitle = isLinux ? 'Windows PowerShell admin' : 'Linux systemd';
  const otherCmd = isLinux ? (result.windows_install_command || result.install_command) : (result.linux_install_command || result.install_command);
  return (
    <div className="install-result">
      <div className="install-meta">
        <strong>Token válido hasta {date(result.expires_at)}</strong>
        <span className="token-value">{result.token}</span>
      </div>
      <CommandBlock title={primaryTitle} command={primaryCmd} />
      <button type="button" className="link-btn" onClick={() => setShowOther(!showOther)}>
        {showOther ? '▲ Ocultar' : '▼ Ver comando ' + otherTitle}
      </button>
      {showOther && <CommandBlock title={otherTitle} command={otherCmd} />}
    </div>
  );
}

function CommandBlock({ title, command }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    setError(false);
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
        ok = true;
      } else {
        // Fallback para contextos sin Clipboard API (HTTP, iframes, navegadores viejos)
        const ta = document.createElement('textarea');
        ta.value = command;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setError(true);
      setTimeout(() => setError(false), 2500);
    }
  }
  return (
    <div className="command-box">
      <div className="command-content">
        <span className="command-title">{title}</span>
        <code>{command}</code>
      </div>
      <button
        className={`copy-btn ${copied ? 'copied' : ''} ${error ? 'failed' : ''}`}
        title="Copiar"
        aria-label="Copiar comando"
        onClick={copy}
      >
        <Copy size={16} />
        {error ? 'Error' : copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

function IconButton({ icon: Icon, label, onClick }) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick}><Icon size={18} /></button>;
}

function RefreshMeta({ lastUpdated, loading, onRefresh }) {
  return <div className="refresh-meta"><span>{loading ? 'Actualizando...' : `Actualizado ${relativeTime(lastUpdated)}`}</span><IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar" /></div>;
}

function Skeleton() {
  return <div className="skeleton-wrap"><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '85%' }} /></div>;
}

function EmptyState({ icon: Icon = Server, title, subtitle }) {
  return (
    <div className="empty-state">
      <Icon size={40} strokeWidth={1.2} />
      <strong>{title}</strong>
      {subtitle && <span>{subtitle}</span>}
    </div>
  );
}

function useLoad(loader, deps, refreshMs = 0) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      setLoading(true);
      loader().then((next) => {
        if (alive) {
          setData(next);
          setLastUpdated(new Date());
        }
      }).catch((err) => console.error(err)).finally(() => alive && setLoading(false));
    };
    load();
    const timer = refreshMs ? setInterval(load, refreshMs) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [...deps, version]);
  return { data, loading, lastUpdated, reload: () => setVersion((v) => v + 1) };
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

function tabLabel(item) {
  return ({ summary: 'Resumen', resources: 'Recursos', disks: 'Discos', network: 'Red', processes: 'Procesos', services: 'Servicios', alerts: 'Alertas', rules: 'Reglas', hardware: 'Hardware', software: 'Software' })[item] || item;
}

function round(value) {
  return Number(value || 0).toFixed(1);
}

function percent(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${round(value)}%`;
}

function date(value) {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

function relativeTime(value) {
  if (!value) return 'pendiente';
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds}s`;
  return `hace ${Math.round(seconds / 60)}m`;
}

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = Number(value || 0);
  let unit = 0;
  while (next > 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function diskLabel(disk) {
  if (!disk?.name && !disk?.mountpoint) return 'n/a';
  if (/^[A-Z]:\\?$/i.test(disk.mountpoint || '')) return disk.mountpoint.replace(/\\?$/, '');
  if (/^[A-Z]:/i.test(disk.name || '')) return disk.name.slice(0, 2);
  return disk.name || disk.mountpoint;
}

function defaultDownloadUrl(_apiBase) {
  return `${window.location.origin}/downloads`;
}

createRoot(document.getElementById('root')).render(<App />);
