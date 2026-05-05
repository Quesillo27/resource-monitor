import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertTriangle,
  Copy,
  Cpu,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MemoryStick,
  Monitor,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('rm_token') || '');
  const [view, setView] = useState('dashboard');

  if (!token) {
    return <Login onLogin={setToken} />;
  }

  return (
    <Shell token={token} view={view} setView={setView} onLogout={() => {
      localStorage.removeItem('rm_token');
      setToken('');
    }} />
  );
}

function Shell({ token, view, setView, onLogout }) {
  const [selectedAgent, setSelectedAgent] = useState(null);
  const api = useMemo(() => createApi(token), [token]);

  const nav = [
    ['dashboard', LayoutDashboard, 'Dashboard'],
    ['agents', Server, 'Equipos'],
    ['enroll', KeyRound, 'Alta agente'],
    ['alerts', AlertTriangle, 'Alertas'],
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Monitor size={28} />
          <div>
            <strong>Resource Monitor</strong>
            <span>Windows / Linux</span>
          </div>
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => {
              if (id === 'agents') setSelectedAgent(null);
              setView(id);
            }}>
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <button className="logout" onClick={onLogout}>
          <LogOut size={18} />
          Salir
        </button>
      </aside>
      <main>
        {view === 'dashboard' && <Dashboard api={api} />}
        {view === 'agents' && (
          selectedAgent
            ? <AgentDetail api={api} agentId={selectedAgent} onBack={() => setSelectedAgent(null)} />
            : <Agents api={api} onSelect={setSelectedAgent} />
        )}
        {view === 'enroll' && <Enrollment api={api} />}
        {view === 'alerts' && <Alerts api={api} />}
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
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
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
  const { data, loading, reload } = useLoad(() => api.get('/api/dashboard/summary'), []);
  const stats = data || {};
  return (
    <section>
      <Header title="Dashboard" action={<IconButton icon={RefreshCw} onClick={reload} label="Actualizar" />} />
      {loading && <Skeleton />}
      <div className="kpi-grid">
        <Kpi icon={Server} label="Online" value={stats.online_agents ?? 0} tone="good" />
        <Kpi icon={Monitor} label="Offline" value={stats.offline_agents ?? 0} tone="muted" />
        <Kpi icon={AlertTriangle} label="Alertas activas" value={stats.active_alerts ?? 0} tone="bad" />
        <Kpi icon={Cpu} label="CPU promedio" value={`${round(stats.avg_cpu_percent)}%`} />
        <Kpi icon={MemoryStick} label="RAM promedio" value={`${round(stats.avg_memory_percent)}%`} />
        <Kpi icon={HardDrive} label="Discos criticos" value={stats.critical_disks ?? 0} tone="bad" />
      </div>
    </section>
  );
}

function Agents({ api, onSelect }) {
  const [query, setQuery] = useState('');
  const { data, loading, reload } = useLoad(() => api.get(`/api/agents?q=${encodeURIComponent(query)}`), [query]);
  const agents = data?.agents || [];

  return (
    <section>
      <Header title="Equipos" action={<IconButton icon={RefreshCw} onClick={reload} label="Actualizar" />} />
      <div className="toolbar">
        <Search size={18} />
        <input placeholder="Buscar por nombre o hostname" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {loading && <Skeleton />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Equipo</th><th>Estado</th><th>OS</th><th>CPU</th><th>RAM</th><th>Ultima conexion</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id} onClick={() => onSelect(agent.id)}>
                <td><strong>{agent.name}</strong><span>{agent.hostname}</span></td>
                <td><Status status={agent.status} /></td>
                <td>{agent.os}</td>
                <td>{percent(agent.cpu_percent)}</td>
                <td>{percent(agent.memory_used_percent)}</td>
                <td>{date(agent.last_seen_at)}</td>
              </tr>
            ))}
            {!agents.length && <tr><td colSpan="6" className="empty">Sin equipos registrados</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AgentDetail({ api, agentId, onBack }) {
  const { data, loading, reload } = useLoad(async () => {
    const [detail, status] = await Promise.all([
      api.get(`/api/agents/${agentId}`),
      api.get(`/api/agents/${agentId}/status`),
    ]);
    return { ...detail, agent_status: status };
  }, [agentId]);
  const agent = data?.agent;
  const agentStatus = data?.agent_status;
  const disks = data?.disks || [];
  const history = data?.history || [];
  return (
    <section>
      <Header title={agent?.name || 'Equipo'} action={<div className="actions"><button onClick={onBack}>Volver</button><IconButton icon={RefreshCw} onClick={reload} label="Actualizar" /></div>} />
      {loading && <Skeleton />}
      {agent && (
        <>
          <div className="detail-head">
            <Status status={agent.status} />
            <span>{agent.hostname}</span>
            <span>{agent.os}</span>
            <span>{agent.arch}</span>
            <span>{date(agent.last_seen_at)}</span>
          </div>
          <div className="kpi-grid compact">
            <Kpi icon={Cpu} label="CPU" value={percent(agent.cpu_percent)} />
            <Kpi icon={MemoryStick} label="RAM" value={percent(agent.memory_used_percent)} />
            <Kpi icon={HardDrive} label="Discos" value={disks.length} />
          </div>
          {agentStatus && (
            <div className="diagnostic-band">
              <span>Ultima metrica: {date(agentStatus.last_metric_at)}</span>
              <span>Alertas activas: {agentStatus.active_alerts}</span>
              <span>Offline despues de: {agentStatus.offline_after_seconds}s</span>
            </div>
          )}
          <div className="chart-band">
            <h2>Historico 24h</h2>
            <HistoryChart points={history} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Disco</th><th>Mount</th><th>FS</th><th>Uso</th><th>Libre</th></tr></thead>
              <tbody>
                {disks.map((disk) => (
                  <tr key={`${disk.name}-${disk.mountpoint}`}>
                    <td>{disk.name}</td>
                    <td>{disk.mountpoint}</td>
                    <td>{disk.filesystem}</td>
                    <td><Usage value={disk.used_percent} /></td>
                    <td>{bytes(disk.free_bytes)}</td>
                  </tr>
                ))}
                {!disks.length && <tr><td colSpan="5" className="empty">Sin muestras de disco</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function Enrollment({ api }) {
  const [serverUrl, setServerUrl] = useState(API_BASE);
  const [agentName, setAgentName] = useState('');
  const [installStyle, setInstallStyle] = useState('linux');
  const [releaseVersion, setReleaseVersion] = useState('latest');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  async function createToken(event) {
    event.preventDefault();
    setLoading(true);
    try {
      const data = await api.post('/api/enrollment-tokens', {
        name: agentName || 'Alta agente',
        ttl_hours: 24,
        server_url: serverUrl,
        agent_name: agentName,
        install_style: installStyle,
        release_version: releaseVersion,
      });
      setResult(data);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <Header title="Alta de agente" />
      <form className="enroll-form" onSubmit={createToken}>
        <label>URL del servidor<input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} /></label>
        <label>Nombre del equipo<input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Opcional" /></label>
        <label>Version del agente<input value={releaseVersion} onChange={(e) => setReleaseVersion(e.target.value)} placeholder="latest" /></label>
        <div className="segmented">
          <button type="button" className={installStyle === 'linux' ? 'selected' : ''} onClick={() => setInstallStyle('linux')}>Linux</button>
          <button type="button" className={installStyle === 'windows' ? 'selected' : ''} onClick={() => setInstallStyle('windows')}>Windows</button>
        </div>
        <button className="primary" disabled={loading}>{loading ? 'Generando...' : 'Generar token'}</button>
      </form>
      {result && (
        <div className="install-result">
          <div className="install-meta">
            <strong>Token valido hasta {date(result.expires_at)}</strong>
            <span>Version: {result.release_version || releaseVersion || 'latest'} - Ejecutar como administrador/root.</span>
          </div>
          <CommandBlock title="Linux systemd" command={result.linux_install_command || result.install_command} />
          <CommandBlock title="Windows PowerShell" command={result.windows_install_command || result.install_command} />
        </div>
      )}
    </section>
  );
}

function CommandBlock({ title, command }) {
  return (
    <div className="command-box">
      <div>
        <span>{title}</span>
        <code>{command}</code>
      </div>
      <IconButton icon={Copy} label={`Copiar ${title}`} onClick={() => navigator.clipboard?.writeText(command)} />
    </div>
  );
}

function Alerts({ api }) {
  const { data, loading, reload } = useLoad(() => api.get('/api/alerts'), []);
  const alerts = data?.alerts || [];
  return (
    <section>
      <Header title="Alertas" action={<IconButton icon={RefreshCw} onClick={reload} label="Actualizar" />} />
      {loading && <Skeleton />}
      <div className="alert-list">
        {alerts.map((alert) => (
          <article className={`alert-card ${alert.severity}`} key={alert.id}>
            <AlertTriangle size={20} />
            <div>
              <strong>{alert.message}</strong>
              <span>{alert.agent_name} - {alert.severity} - {date(alert.opened_at)}</span>
            </div>
          </article>
        ))}
        {!alerts.length && <p className="empty-panel">Sin alertas activas</p>}
      </div>
    </section>
  );
}

function Header({ title, action }) {
  return <header className="page-header"><h1>{title}</h1>{action}</header>;
}

function Kpi({ icon: Icon, label, value, tone = '' }) {
  return <article className={`kpi ${tone}`}><Icon size={22} /><span>{label}</span><strong>{value}</strong></article>;
}

function Status({ status }) {
  return <span className={`status ${status}`}>{status}</span>;
}

function Usage({ value }) {
  return <div className="usage"><span style={{ width: `${Math.min(value || 0, 100)}%` }} /><strong>{round(value)}%</strong></div>;
}

function HistoryChart({ points }) {
  if (!points.length) return <div className="empty-chart">Sin historial</div>;
  const cpu = polyline(points.map((p) => p.cpu_percent));
  const mem = polyline(points.map((p) => p.memory_used_percent));
  return (
    <svg className="chart" viewBox="0 0 100 46" preserveAspectRatio="none" aria-label="Historico CPU y RAM">
      <path d="M0 40 H100" />
      <polyline points={cpu} className="cpu-line" />
      <polyline points={mem} className="mem-line" />
    </svg>
  );
}

function polyline(values) {
  const max = Math.max(values.length - 1, 1);
  return values.map((value, index) => {
    const x = (index / max) * 100;
    const y = 44 - (Math.max(0, Math.min(value || 0, 100)) / 100) * 40;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function IconButton({ icon: Icon, label, onClick }) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick}><Icon size={18} /></button>;
}

function Skeleton() {
  return <div className="skeleton" />;
}

function useLoad(loader, deps) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((next) => alive && setData(next))
      .catch((err) => console.error(err))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [...deps, version]);
  return { data, loading, reload: () => setVersion((v) => v + 1) };
}

function createApi(token) {
  return {
    get: (path) => request(path, { method: 'GET' }, token),
    post: (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) }, token),
  };
}

async function request(path, options, token) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

createRoot(document.getElementById('root')).render(<App />);
