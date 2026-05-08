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
import './resources-polish.css';

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
  const { data: inventory } = useLoad(() => api.get(`/api/agents/${agentId}/inventory`), [agentId], 0);
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
            {['summary', 'resources', 'disks', 'network', 'processes', 'services', 'alerts', 'hardware', 'software'].map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{tabLabel(item)}</button>)}
          </div>
          {tab === 'summary' && <SummaryTab agent={agent} status={data.agent_status} disks={disks} networks={networks} services={services} alerts={alerts} />}
          {tab === 'resources' && <ResourcesTab agent={agent} history={data.range_history} disks={disks} networks={networks} range={range} setRange={setRange} />}
          {tab === 'disks' && <DisksTable disks={disks} />}
          {tab === 'network' && <NetworkTable networks={networks} />}
          {tab === 'processes' && <ProcessesTable processes={processes} />}
          {tab === 'services' && <ServicesTable services={services} />}
          {tab === 'alerts' && <AlertList alerts={alerts} />}
          {tab === 'hardware' && <HardwareTab hardware={inventory?.hardware} />}
          {tab === 'software' && <SoftwareTab software={inventory?.software} />}
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

function ResourcesTab({ agent, history, disks: currentDisks = [], networks: currentNetworks = [], range, setRange }) {
  const metrics = history?.metrics || [];
  const network = history?.network || history?.networks || [];
  const diskHistory = history?.disks || [];
  const diskNames = [...new Set(diskHistory.map((d) => d.mountpoint || d.name))].slice(0, 4);
  const latestMetric = lastItem(metrics) || {};
  const latestNetwork = lastItem(network) || {};
  const latestDisks = latestDiskValues(diskHistory);
  const busiestDisk = [...(currentDisks.length ? currentDisks : latestDisks)].sort((a, b) => Number(b.used_percent || 0) - Number(a.used_percent || 0))[0];
  const totalDiskBytes = currentDisks.reduce((sum, disk) => sum + Number(disk.total_bytes || 0), 0);
  const usedDiskBytes = currentDisks.reduce((sum, disk) => sum + Number(disk.used_bytes || 0), 0);
  return (
    <>
      <div className="chart-toolbar">
        <div><h2>Historico de recursos</h2><span>Pasa el mouse por una linea para ver fecha, serie y valor exacto del punto.</span></div>
        <div className="segmented">{['24h', '7d', '30d'].map((item) => <button key={item} className={range === item ? 'selected' : ''} onClick={() => setRange(item)}>{item}</button>)}</div>
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
      <div className="chart-grid">
        <ChartPanel
          title="CPU / RAM / Swap"
          subtitle="Porcentaje de consumo por punto"
          unit="%"
        >
          <LineChart points={metrics} series={[["CPU", "cpu_percent", "#2563eb"], ["RAM", "memory_used_percent", "#7c3aed"], ["Swap", "swap_used_percent", "#d97706"]]} max={100} />
        </ChartPanel>
        <ChartPanel
          title="Red"
          subtitle="Velocidad estimada recibida/enviada"
          unit="B/s"
        >
          <LineChart points={network} series={[["Recibido", "bytes_recv_per_sec", "#fb5b7b"], ["Enviado", "bytes_sent_per_sec", "#38a3ff"]]} formatter={rate} />
        </ChartPanel>
        <ChartPanel
          title="Uso de disco por unidad o mount"
          subtitle="Porcentaje usado por filesystem"
          unit="%"
        >
          <LineChart points={pivotDisks(diskHistory, diskNames)} series={diskNames.map((name, index) => [name, name, ['#2563eb', '#059669', '#d97706', '#dc2626'][index]])} max={100} />
        </ChartPanel>
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
    setLoading(true);
    setError('');
    try {
      const data = await api.post('/api/enrollment-tokens', {
        name: agentName || 'Alta agente',
        ttl_hours: Number(ttl),
        server_url: serverUrl,
        download_url: downloadUrl,
        agent_name: agentName,
        install_style: platform,
        release_version: 'latest',
        profile,
        services,
        interval: Number(interval),
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

function AlertList({ alerts, compact = false }) {
  if (!alerts.length) return <p className="empty-panel">Sin alertas activas ✓</p>;
  return (
    <div className={`alert-list ${compact ? 'compact' : ''}`}>
      {alerts.map((alert) => (
        <article className={`alert-card sev-${alert.severity}`} key={alert.id}>
          <AlertTriangle size={18} />
          <div>
            <strong>{alert.message}</strong>
            <span>{alert.agent_name} · <span className={`sev-badge ${alert.severity}`}>{alert.severity}</span> · {date(alert.opened_at)}</span>
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

function HardwareTab({ hardware }) {
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
    <div className="hw-grid">
      {rows.map(([label, value]) => (
        <div key={label} className="hw-row">
          <span className="hw-label">{label}</span>
          <span className="hw-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

function SoftwareTab({ software }) {
  const [q, setQ] = useState('');
  if (!software) return <EmptyState icon="📦" title="Sin inventario de software" subtitle="El agente enviará el inventario en su próxima sincronización (24h)." />;
  const filtered = q ? software.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()) || (s.publisher || '').toLowerCase().includes(q.toLowerCase())) : software;
  return (
    <div>
      <div className="sw-search">
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

function LineChart({ points, series, max, formatter }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  if (!points?.length) return <div className="empty-chart">Sin historial para este rango</div>;
  const chartMax = max || Math.max(1, ...series.flatMap(([, key]) => points.map((p) => Number(p[key] || 0))));
  const activeIndex = hoverIndex;
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeX = activeIndex === null ? 0 : points.length > 1 ? (activeIndex / (points.length - 1)) * 100 : 0;
  const yTicks = axisTicks(chartMax, formatter);
  const xTicks = timeTicks(points);
  const setHover = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setHoverIndex(Math.round(ratio * (points.length - 1)));
  };
  return (
    <div className="chart-shell">
      <div className="legend">{series.map(([label,, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
      <div className="chart-frame">
        <div className="chart-axis y-axis">{yTicks.map((tick, index) => <span key={`${tick}-${index}`}>{tick}</span>)}</div>
        <div className="chart-plot" onMouseMove={setHover} onMouseLeave={() => setHoverIndex(null)}>
          <svg className="chart" viewBox="0 0 100 52" preserveAspectRatio="none">
            <path d="M0 8 H100" />
            <path d="M0 18 H100" />
            <path d="M0 28 H100" />
            <path d="M0 38 H100" />
            <path d="M0 48 H100" />
            {activePoint && <line className="chart-cursor" x1={activeX} x2={activeX} y1="8" y2="48" />}
            {series.map(([label, key, color]) => <polyline key={label} points={polyline(points.map((p) => Number(p[key] || 0)), chartMax)} style={{ stroke: color }} />)}
            {activePoint && series.map(([label, key, color]) => {
              const value = Number(activePoint?.[key] || 0);
              const y = 48 - (Math.max(0, value) / chartMax) * 40;
              return <circle key={`${label}-dot`} cx={activeX} cy={y} r="1.1" style={{ fill: color }} />;
            })}
          </svg>
          {activePoint && (
            <div className="chart-tooltip" style={{ left: `${Math.min(Math.max(activeX, 12), 88)}%` }}>
              <strong>{timeLabel(activePoint.captured_at)}</strong>
              {series.map(([label, key, color]) => <span key={label}><i style={{ background: color }} />{label}<b>{formatter ? formatter(activePoint[key]) : `${round(activePoint[key])}%`}</b></span>)}
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

function polyline(values, maxValue) {
  const maxIndex = Math.max(values.length - 1, 1);
  return values.map((value, index) => `${((index / maxIndex) * 100).toFixed(2)},${(48 - (Math.max(0, value) / maxValue) * 40).toFixed(2)}`).join(' ');
}

function pivotDisks(disks, names) {
  const byTime = {};
  disks.forEach((disk) => {
    const key = disk.captured_at;
    byTime[key] = byTime[key] || { captured_at: key };
    const name = disk.mountpoint || disk.name;
    if (names.includes(name)) byTime[key][name] = disk.used_percent;
  });
  return Object.values(byTime);
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
  function copy() {
    navigator.clipboard?.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="command-box">
      <div className="command-content">
        <span className="command-title">{title}</span>
        <code>{command}</code>
      </div>
      <button className={`copy-btn ${copied ? 'copied' : ''}`} title="Copiar" aria-label="Copiar comando" onClick={copy}>
        <Copy size={16} />
        {copied ? 'Copiado' : 'Copiar'}
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
  return ({ summary: 'Resumen', resources: 'Recursos', disks: 'Discos', network: 'Red', processes: 'Procesos', services: 'Servicios', alerts: 'Alertas', hardware: 'Hardware', software: 'Software' })[item] || item;
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
    parsed.port = '';
    parsed.pathname = '/downloads';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return `${window.location.origin}/downloads`;
  }
}

createRoot(document.getElementById('root')).render(<App />);
