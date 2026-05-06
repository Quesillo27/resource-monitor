import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Edit3,
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
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
const REFRESH_MS = 60000;

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
  const api = useMemo(() => createApi(token, onLogout), [token, onLogout]);
  const nav = [
    ['dashboard', LayoutDashboard, 'Dashboard'],
    ['agents', Server, 'Equipos'],
    ['enroll', KeyRound, 'Alta agente'],
    ['alerts', ShieldAlert, 'Alertas'],
  ];
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
              if (id === 'agents') setSelectedAgent(null);
              setView(id);
            }}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={onLogout}><LogOut size={18} />Salir</button>
      </aside>
      <main>
        {view === 'dashboard' && <Dashboard api={api} />}
        {view === 'agents' && (selectedAgent ? <AgentDetail api={api} agentId={selectedAgent} onBack={() => setSelectedAgent(null)} /> : <Agents api={api} onSelect={setSelectedAgent} />)}
        {view === 'enroll' && <Enrollment api={api} />}
        {view === 'alerts' && <AlertsCenter api={api} />}
      </main>
    </div>
  );
}

function Login({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
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
        <label>Usuario<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>Contrasena<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary" disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</button>
      </form>
    </div>
  );
}

function Dashboard({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/dashboard/overview'), [], REFRESH_MS);
  const overview = data || {};
  const stats = overview.summary || overview;
  const counts = overview.status_counts || overview.status_distribution || {};
  return (
    <section>
      <Header title="Dashboard operativo" meta={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />} />
      <div className="health-hero">
        <div>
          <span>Salud global</span>
          <strong>{stats.critical_agents ? 'Atencion critica' : stats.warning_agents ? 'Con advertencias' : 'Operando normal'}</strong>
          <p>{stats.total_agents || 0} equipos monitoreados, {stats.active_alerts || 0} alertas activas</p>
        </div>
        <StatusDonut counts={counts} />
      </div>
      <div className="kpi-grid">
        <Kpi icon={Server} label="Online" value={stats.online_agents ?? 0} tone="good" />
        <Kpi icon={Monitor} label="Offline" value={stats.offline_agents ?? 0} tone="muted" />
        <Kpi icon={AlertTriangle} label="Alertas" value={stats.active_alerts ?? 0} tone="bad" />
        <Kpi icon={Cpu} label="CPU promedio" value={`${round(stats.avg_cpu_percent)}%`} />
        <Kpi icon={MemoryStick} label="RAM promedio" value={`${round(stats.avg_memory_percent)}%`} />
        <Kpi icon={Network} label="Trafico red" value={bytes(stats.network_total_bytes)} />
        <Kpi icon={HardDrive} label="Discos criticos" value={stats.critical_disks ?? 0} tone="bad" />
        <Kpi icon={Settings} label="Servicios caidos" value={stats.services_down ?? 0} tone="bad" />
      </div>
      <div className="dashboard-grid">
        <Panel title="Top CPU"><MiniAgentList agents={overview.top_cpu || []} metric="cpu_percent" /></Panel>
        <Panel title="Top RAM"><MiniAgentList agents={overview.top_memory || []} metric="memory_used_percent" /></Panel>
        <Panel title="Equipos sin metrica reciente"><MiniAgentList agents={overview.stale_agents || []} empty="Sin equipos vencidos" /></Panel>
        <Panel title="Ultimas alertas"><AlertList alerts={overview.recent_alerts || []} compact /></Panel>
      </div>
    </section>
  );
}

function Agents({ api, onSelect }) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get(`/api/agents?q=${encodeURIComponent(query)}`), [query], REFRESH_MS);
  const agents = data?.agents || [];
  const filtered = statusFilter === 'all' ? agents : agents.filter((agent) => agent.status === statusFilter);
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
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Equipo</th><th>Estado</th><th>OS</th><th>CPU</th><th>RAM</th><th>Discos</th><th>Alertas</th><th>Ultima metrica</th><th>Heartbeat</th></tr></thead>
          <tbody>
            {filtered.map((agent) => (
              <tr key={agent.id} onClick={() => onSelect(agent.id)}>
                <td><strong>{agent.name}</strong><span>{agent.hostname}</span></td>
                <td><Status status={agent.status} /></td>
                <td>{agent.os}</td>
                <td>{percent(agent.cpu_percent)}</td>
                <td>{percent(agent.memory_used_percent)}</td>
                <td>{agent.disk_count ?? 0}</td>
                <td>{agent.active_alerts ?? 0}</td>
                <td>{date(agent.last_metric_at)}</td>
                <td>{date(agent.last_seen_at)}</td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan="9" className="empty">Sin equipos registrados</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AgentDetail({ api, agentId, onBack }) {
  const [tab, setTab] = useState('summary');
  const [range, setRange] = useState('24h');
  const { data, loading, reload, lastUpdated } = useLoad(async () => {
    const [detail, status, history] = await Promise.all([
      api.get(`/api/agents/${agentId}`),
      api.get(`/api/agents/${agentId}/status`),
      api.get(`/api/agents/${agentId}/history?range=${range}`),
    ]);
    return { ...detail, agent_status: status, range_history: history };
  }, [agentId, range], REFRESH_MS);
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
    await api.delete(`/api/agents/${agentId}`);
    onBack();
  }
  return (
    <section>
      <Header title={agent?.name || 'Equipo'} meta={<div className="actions"><button onClick={onBack}>Volver</button><IconButton icon={Edit3} onClick={renameAgent} label="Renombrar" /><IconButton icon={Trash2} onClick={deleteAgent} label="Eliminar" /><RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} /></div>} />
      {agent && (
        <>
          <div className="detail-head"><Status status={agent.status} /><span>{data.status_reason}</span><span>{agent.hostname}</span><span>{agent.os}</span><span>{agent.arch}</span></div>
          <div className="tab-row">
            {['summary', 'resources', 'disks', 'network', 'processes', 'services', 'alerts'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{tabLabel(item)}</button>)}
          </div>
          {tab === 'summary' && <SummaryTab agent={agent} status={data.agent_status} disks={disks} networks={networks} services={services} alerts={alerts} />}
          {tab === 'resources' && <ResourcesTab history={data.range_history} range={range} setRange={setRange} />}
          {tab === 'disks' && <DisksTable disks={disks} />}
          {tab === 'network' && <NetworkTable networks={networks} />}
          {tab === 'processes' && <ProcessesTable processes={processes} />}
          {tab === 'services' && <ServicesTable services={services} />}
          {tab === 'alerts' && <AlertList alerts={alerts} />}
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

function ResourcesTab({ history, range, setRange }) {
  const metrics = history?.metrics || [];
  const network = history?.networks || [];
  const disks = history?.disks || [];
  const diskNames = [...new Set(disks.map((d) => d.mountpoint))].slice(0, 4);
  return (
    <>
      <div className="chart-toolbar">
        <div><h2>Historico de recursos</h2><span>CPU, RAM, swap, red y discos con rango agregado</span></div>
        <div className="segmented">{['24h', '7d', '30d'].map((item) => <button key={item} className={range === item ? 'selected' : ''} onClick={() => setRange(item)}>{item}</button>)}</div>
      </div>
      <div className="chart-grid">
        <Panel title="CPU / RAM / Swap"><LineChart points={metrics} series={[["CPU %", "cpu_percent", "#1f6feb"], ["RAM %", "memory_used_percent", "#8b5cf6"], ["Swap %", "swap_used_percent", "#f59f00"]]} max={100} /></Panel>
        <Panel title="Red enviada / recibida"><LineChart points={network} series={[["Recibido", "bytes_recv", "#0f766e"], ["Enviado", "bytes_sent", "#dc2626"]]} formatter={bytes} /></Panel>
        <Panel title="Uso de disco por mount"><LineChart points={pivotDisks(disks, diskNames)} series={diskNames.map((name, index) => [name, name, ['#1f6feb', '#16a34a', '#f59f00', '#dc2626'][index]])} max={100} /></Panel>
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
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function createToken(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const data = await api.post('/api/enrollment-tokens', { name: agentName || 'Alta agente', ttl_hours: 24, server_url: serverUrl, download_url: downloadUrl, agent_name: agentName, install_style: platform, release_version: 'latest', profile, services, interval: Number(interval) });
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
      <div className="wizard">
        <form className="enroll-form" onSubmit={createToken}>
          <WizardStep index="1" title="Plataforma"><div className="segmented"><button type="button" className={platform === 'linux' ? 'selected' : ''} onClick={() => setPlatform('linux')}>Linux</button><button type="button" className={platform === 'windows' ? 'selected' : ''} onClick={() => setPlatform('windows')}>Windows</button></div></WizardStep>
          <WizardStep index="2" title="Conectividad"><label>URL API<input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} /></label><label>URL descargas LAN<input value={downloadUrl} onChange={(e) => setDownloadUrl(e.target.value)} /></label></WizardStep>
          <WizardStep index="3" title="Perfil"><label>Nombre del equipo<input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Opcional" /></label><div className="form-grid"><label>Perfil<select value={profile} onChange={(e) => setProfile(e.target.value)}><option value="balanced">balanced</option><option value="minimal">minimal</option></select></label><label>Intervalo<input type="number" min="30" value={interval} onChange={(e) => setIntervalValue(e.target.value)} /></label></div><label>Servicios criticos<input value={services} onChange={(e) => setServices(e.target.value)} placeholder="nginx,postgres,sqlservr" /></label></WizardStep>
          {error && <p className="form-error">{error}</p>}
          <button className="primary" disabled={loading}>{loading ? 'Generando...' : 'Generar token y comando'}</button>
        </form>
        <Panel title="Verificacion esperada">
          <div className="check-list"><span><CheckCircle2 size={18} /> Descarga desde LAN</span><span><CheckCircle2 size={18} /> Registro con token unico</span><span><CheckCircle2 size={18} /> Servicio activo</span><span><CheckCircle2 size={18} /> Primera metrica en menos de 60s</span></div>
        </Panel>
      </div>
      {result && <div className="install-result"><div className="install-meta"><strong>Token valido hasta {date(result.expires_at)}</strong><span>{result.token}</span></div><CommandBlock title="Linux systemd" command={result.linux_install_command || result.install_command} /><CommandBlock title="Windows PowerShell admin" command={result.windows_install_command || result.install_command} /></div>}
    </section>
  );
}

function AlertsCenter({ api }) {
  const [tab, setTab] = useState('alerts');
  return (
    <section>
      <Header title="Alertas" />
      <div className="tab-row"><button className={tab === 'alerts' ? 'selected' : ''} onClick={() => setTab('alerts')}>Alertas activas</button><button className={tab === 'smtp' ? 'selected' : ''} onClick={() => setTab('smtp')}>SMTP</button></div>
      {tab === 'alerts' ? <Alerts api={api} /> : <SMTPSettings api={api} />}
    </section>
  );
}

function Alerts({ api }) {
  const { data, loading, reload, lastUpdated } = useLoad(() => api.get('/api/alerts'), [], REFRESH_MS);
  return <Panel title="Alertas web" action={<RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} />}><AlertList alerts={data?.alerts || []} /></Panel>;
}

function SMTPSettings({ api }) {
  const { data, reload } = useLoad(() => api.get('/api/alert-settings/smtp'), [], 0);
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  useEffect(() => { if (data && !form) setForm({ ...data, password: '' }); }, [data, form]);
  if (!form) return <Skeleton />;
  const set = (key, value) => setForm((next) => ({ ...next, [key]: value }));
  async function save() {
    const saved = await api.put('/api/alert-settings/smtp', { ...form, port: Number(form.port), cooldown_minutes: Number(form.cooldown_minutes) });
    setForm({ ...saved, password: '' });
    setMessage('Configuracion guardada');
    reload();
  }
  async function test() {
    await api.post('/api/alert-settings/smtp/test', { ...form, port: Number(form.port), cooldown_minutes: Number(form.cooldown_minutes) });
    setMessage('Correo de prueba enviado');
  }
  return (
    <Panel title="Configuracion SMTP" action={<div className="actions"><IconButton icon={Send} label="Probar SMTP" onClick={test} /><IconButton icon={Mail} label="Guardar SMTP" onClick={save} /></div>}>
      <div className="smtp-grid">
        <label><span><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Habilitar correos</span></label>
        <label>Host<input value={form.host} onChange={(e) => set('host', e.target.value)} /></label>
        <label>Puerto<input type="number" value={form.port} onChange={(e) => set('port', e.target.value)} /></label>
        <label>Usuario<input value={form.username} onChange={(e) => set('username', e.target.value)} /></label>
        <label>Contrasena<input type="password" value={form.password} placeholder="Mantener actual si se deja vacia" onChange={(e) => set('password', e.target.value)} /></label>
        <label>Remitente<input value={form.from_address} onChange={(e) => set('from_address', e.target.value)} /></label>
        <label>Destinatarios<input value={form.to_addresses} onChange={(e) => set('to_addresses', e.target.value)} placeholder="ops@empresa.com,infra@empresa.com" /></label>
        <label>Cooldown minutos<input type="number" value={form.cooldown_minutes} onChange={(e) => set('cooldown_minutes', e.target.value)} /></label>
        <label><span><input type="checkbox" checked={form.use_tls} onChange={(e) => set('use_tls', e.target.checked)} /> TLS directo</span></label>
        <label><span><input type="checkbox" checked={form.use_starttls} onChange={(e) => set('use_starttls', e.target.checked)} /> STARTTLS</span></label>
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

function Status({ status }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function StatusDonut({ counts }) {
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0) || 1;
  return <div className="status-donut"><Gauge size={42} /><span>{Math.round((Number(counts.online || 0) / total) * 100)}%</span><small>online</small></div>;
}

function MiniAgentList({ agents, metric, empty = 'Sin datos' }) {
  if (!agents.length) return <p className="empty-panel">{empty}</p>;
  return <div className="mini-list">{agents.map((agent) => <div key={agent.id}><strong>{agent.name}</strong><span>{metric ? percent(agent[metric]) : date(agent.last_metric_at)}</span></div>)}</div>;
}

function AlertList({ alerts, compact = false }) {
  if (!alerts.length) return <p className="empty-panel">Sin alertas activas</p>;
  return <div className={`alert-list ${compact ? 'compact' : ''}`}>{alerts.map((alert) => <article className={`alert-card ${alert.severity}`} key={alert.id}><AlertTriangle size={20} /><div><strong>{alert.message}</strong><span>{alert.agent_name} - {alert.severity} - {date(alert.opened_at)}</span></div></article>)}</div>;
}

function DisksTable({ disks }) {
  return <DataTable empty="Sin muestras de disco" columns={['Unidad / Disco', 'Mount', 'FS', 'Total', 'Usado', 'Libre', 'Uso']} rows={disks.map((d) => [diskLabel(d), d.mountpoint, d.filesystem, bytes(d.total_bytes), bytes(d.used_bytes), bytes(d.free_bytes), <Usage value={d.used_percent} />])} />;
}

function NetworkTable({ networks }) {
  return <DataTable empty="Sin muestras de red" columns={['Interfaz', 'Estado', 'Recibido', 'Enviado']} rows={networks.map((n) => [n.name, n.up ? 'up' : 'down', bytes(n.bytes_recv), bytes(n.bytes_sent)])} />;
}

function ProcessesTable({ processes }) {
  return <DataTable empty="Sin procesos destacados" columns={['Proceso', 'PID', 'CPU', 'RAM']} rows={processes.map((p) => [p.name, p.pid, percent(p.cpu_percent), percent(p.memory_percent)])} />;
}

function ServicesTable({ services }) {
  return <DataTable empty="Sin servicios configurados" columns={['Servicio', 'Estado']} rows={services.map((s) => [s.name, s.status])} />;
}

function DataTable({ columns, rows, empty }) {
  return <div className="table-wrap"><table><thead><tr>{columns.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={columns.length} className="empty">{empty}</td></tr>}</tbody></table></div>;
}

function Usage({ value }) {
  return <div className="usage"><span style={{ width: `${Math.min(value || 0, 100)}%` }} /><strong>{round(value)}%</strong></div>;
}

function LineChart({ points, series, max, formatter }) {
  if (!points?.length) return <div className="empty-chart">Sin historial para este rango</div>;
  const chartMax = max || Math.max(1, ...series.flatMap(([, key]) => points.map((p) => Number(p[key] || 0))));
  return (
    <div>
      <div className="legend">{series.map(([label,, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
      <svg className="chart" viewBox="0 0 100 46" preserveAspectRatio="none">
        <path d="M0 40 H100" />
        {series.map(([label, key, color]) => <polyline key={label} points={polyline(points.map((p) => Number(p[key] || 0)), chartMax)} style={{ stroke: color }} />)}
      </svg>
      <div className="chart-scale"><span>0</span><span>{formatter ? formatter(chartMax) : `${round(chartMax)}%`}</span></div>
    </div>
  );
}

function polyline(values, maxValue) {
  const maxIndex = Math.max(values.length - 1, 1);
  return values.map((value, index) => `${((index / maxIndex) * 100).toFixed(2)},${(44 - (Math.max(0, value) / maxValue) * 40).toFixed(2)}`).join(' ');
}

function pivotDisks(disks, names) {
  const byTime = {};
  disks.forEach((disk) => {
    const key = disk.captured_at;
    byTime[key] = byTime[key] || { captured_at: key };
    if (names.includes(disk.mountpoint)) byTime[key][disk.mountpoint] = disk.used_percent;
  });
  return Object.values(byTime);
}

function WizardStep({ index, title, children }) {
  return <div className="wizard-step"><strong>{index}</strong><div><h2>{title}</h2>{children}</div></div>;
}

function CommandBlock({ title, command }) {
  return <div className="command-box"><div><span>{title}</span><code>{command}</code></div><IconButton icon={Copy} label={`Copiar ${title}`} onClick={() => navigator.clipboard?.writeText(command)} /></div>;
}

function IconButton({ icon: Icon, label, onClick }) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick}><Icon size={18} /></button>;
}

function RefreshMeta({ lastUpdated, loading, onRefresh }) {
  return <div className="refresh-meta"><span>{loading ? 'Actualizando...' : `Actualizado ${relativeTime(lastUpdated)}`}</span><IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar" /></div>;
}

function Skeleton() {
  return <div className="skeleton" />;
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

async function request(path, options, token, onUnauthorized) {
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function sortBy(items, score) {
  return [...items].sort((a, b) => score(b) - score(a));
}

function tabLabel(item) {
  return ({ summary: 'Resumen', resources: 'Recursos', disks: 'Discos', network: 'Red', processes: 'Procesos', services: 'Servicios', alerts: 'Alertas' })[item] || item;
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

function defaultDownloadUrl(apiBase) {
  try {
    const parsed = new URL(apiBase);
    parsed.port = '3000';
    parsed.pathname = '/downloads';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return 'http://localhost:3000/downloads';
  }
}

createRoot(document.getElementById('root')).render(<App />);
