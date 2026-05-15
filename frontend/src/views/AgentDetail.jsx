import React, { memo, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Edit3,
  Eye,
  EyeOff,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Save,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import {
  AlertList,
  ChartPanel,
  EmptyState,
  Header,
  IconButton,
  Kpi,
  Panel,
  RefreshMeta,
  Ring,
  Skeleton,
  Status,
  copyTextFallback,
  date,
  percent,
  relativeTime,
  round,
  useLoad,
} from '../lib/ui';

const STATUS_REFRESH_MS = 10_000;
const CHART_REFRESH_MS = 30_000;

const OS_LABEL = { linux: 'Linux', windows: 'Windows', darwin: 'macOS' };
const DISK_COLORS = ['#2563eb', '#059669', '#f59e0b', '#dc2626'];

const RULE_GROUPS = [
  { metric: 'cpu', title: 'CPU', unit: '%', icon: Cpu },
  { metric: 'ram', title: 'Memoria RAM', unit: '%', icon: MemoryStick },
  { metric: 'network_recv_mbps', title: 'Red recibida', unit: 'Mbps', icon: Network },
  { metric: 'network_sent_mbps', title: 'Red enviada', unit: 'Mbps', icon: Network },
  { metric: 'agent_offline_minutes', title: 'Conexión perdida', unit: 'min', icon: ShieldAlert },
];

function detectOS(rawOs) {
  const s = (rawOs || '').toLowerCase();
  if (s.includes('windows')) return 'windows';
  if (s.includes('darwin') || s.includes('mac')) return 'darwin';
  return 'linux';
}

function agentCommands(os) {
  if (os === 'windows') {
    return [
      { cmd: 'Get-Service resource-monitor-agent', desc: 'Estado del servicio (Running / Stopped) y modo de arranque.' },
      { cmd: 'Get-EventLog -LogName Application -Source resource-monitor-agent -Newest 50', desc: 'Últimos 50 eventos del agente en el Event Viewer (errores, panics, restarts).' },
      { cmd: '& "C:\\Program Files\\resource-monitor-agent\\resource-monitor-agent.exe" status --config "C:\\ProgramData\\resource-monitor-agent\\config.json"', desc: 'Reporte del agente: versión, URL del manager, último heartbeat OK/fallo.' },
      { cmd: '& "C:\\Program Files\\resource-monitor-agent\\resource-monitor-agent.exe" doctor --config "C:\\ProgramData\\resource-monitor-agent\\config.json"', desc: 'Diagnóstico full: conectividad, permisos, validación de config y prueba de envío.' },
    ];
  }
  if (os === 'darwin') {
    return [
      { cmd: 'sudo launchctl print system/com.resourcemonitor.agent', desc: 'Estado del daemon launchd: corriendo, PID, exit codes, último restart.' },
      { cmd: "log show --predicate 'process == \"resource-monitor-agent\"' --info --last 10m", desc: 'Logs del unified log de los últimos 10 minutos filtrados por el proceso.' },
      { cmd: 'sudo /usr/local/bin/resource-monitor-agent status --config /usr/local/etc/resource-monitor-agent/config.json', desc: 'Reporte del agente: versión, URL del manager, último heartbeat OK/fallo.' },
      { cmd: 'sudo /usr/local/bin/resource-monitor-agent doctor --config /usr/local/etc/resource-monitor-agent/config.json', desc: 'Diagnóstico full: conectividad, permisos, validación de config y prueba de envío.' },
    ];
  }
  return [
    { cmd: 'sudo systemctl status resource-monitor-agent', desc: 'Estado del servicio (activo, desde cuándo, PID y últimas líneas de log).' },
    { cmd: 'sudo journalctl -u resource-monitor-agent -f --since "10 min ago"', desc: 'Logs en vivo de los últimos 10 minutos (Ctrl+C para salir).' },
    { cmd: 'sudo /usr/local/bin/resource-monitor-agent status --config /etc/resource-monitor-agent/config.json', desc: 'Reporte del agente: versión, URL del manager, último heartbeat OK/fallo.' },
    { cmd: 'sudo /usr/local/bin/resource-monitor-agent doctor --config /etc/resource-monitor-agent/config.json', desc: 'Diagnóstico full: conectividad, permisos, validación de config y prueba de envío.' },
  ];
}

function pickTone(value, warn = 75, crit = 90) {
  const v = Number(value || 0);
  if (v >= crit) return 'bad';
  if (v >= warn) return 'warn';
  return '';
}

function tabLabel(item) {
  return ({ summary: 'Resumen', resources: 'Recursos', disks: 'Discos', network: 'Red', processes: 'Procesos', services: 'Servicios', alerts: 'Alertas', rules: 'Reglas', hardware: 'Hardware', software: 'Software' })[item] || item;
}

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = Number(value || 0);
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function diskLabel(disk) {
  if (/^[A-Z]:/i.test(disk.name || '')) return disk.name.slice(0, 2);
  return disk.name || disk.mountpoint;
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return 'n/a';
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function timeLabel(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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

function lastItem(items) {
  return items?.length ? items[items.length - 1] : null;
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

function axisTicks(maxValue, formatter) {
  return [1, 0.75, 0.5, 0.25, 0].map((ratio) => formatter ? formatter(maxValue * ratio) : `${round(maxValue * ratio)}%`);
}

function timeTicks(points) {
  if (!points?.length) return [];
  const maxIndex = Math.max(points.length - 1, 1);
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => points[Math.round(ratio * maxIndex)]).filter(Boolean).map((point) => timeLabel(point.captured_at));
}

// LineChart memoizado: evita re-renders cuando padre re-renderiza por polling
// pero points/series/grid no cambiaron por identidad. Los cálculos pesados
// (chartMax, paths SVG, ticks) van en useMemo para que tampoco se recalculen.
const LineChart = memo(function LineChart({ points, grid, series, max, formatter }) {
  const [hoverIndex, setHoverIndex] = useState(null);
  const displayPoints = useMemo(
    () => (points?.length ? points : grid)?.map((p) => (typeof p === 'string' ? { captured_at: p } : p)) || [],
    [points, grid]
  );
  const hasAnyData = useMemo(
    () => series.some(([, key]) => displayPoints.some((p) => p[key] != null)),
    [displayPoints, series]
  );
  const chartMax = useMemo(
    () => max || Math.max(1, ...series.flatMap(([, key]) => displayPoints.map((p) => p[key] != null ? Number(p[key]) : 0))),
    [displayPoints, series, max]
  );
  const seriesPaths = useMemo(
    () => series.map(([label, key, color]) => ({ label, key, color, d: polylinePath(displayPoints, key, chartMax) })),
    [displayPoints, series, chartMax]
  );
  const yTicks = useMemo(() => axisTicks(chartMax, formatter), [chartMax, formatter]);
  const xTicks = useMemo(() => timeTicks(displayPoints), [displayPoints]);

  if (!displayPoints.length) return <div className="empty-chart">Sin historial disponible</div>;

  const activePoint = hoverIndex === null ? null : displayPoints[hoverIndex];
  const activeX = hoverIndex === null ? 0 : displayPoints.length > 1 ? (hoverIndex / (displayPoints.length - 1)) * 100 : 0;
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
            {hasAnyData && seriesPaths.map(({ label, color, d }) => (
              <path key={label} className="chart-line" d={d} style={{ stroke: color }} />
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
});

function CommandLine({ cmd, desc }) {
  const [state, setState] = useState('idle');
  async function doCopy() {
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(cmd);
        ok = true;
      } catch {
        ok = copyTextFallback(cmd);
      }
    } else {
      ok = copyTextFallback(cmd);
    }
    setState(ok ? 'ok' : 'err');
    setTimeout(() => setState('idle'), 1800);
  }
  const cls = state === 'ok' ? 'cmd-copy ok' : state === 'err' ? 'cmd-copy err' : 'cmd-copy';
  const title = state === 'ok' ? 'Copiado' : state === 'err' ? 'No se pudo copiar (selecciona y Ctrl+C)' : 'Copiar al portapapeles';
  return (
    <div className="cmd-item">
      {desc && <p className="cmd-desc">{desc}</p>}
      <div className="cmd-row">
        <code>{cmd}</code>
        <button type="button" className={cls} onClick={doCopy} title={title} aria-label={title}>
          {state === 'ok' ? <CheckCircle2 size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
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

function AgentProfileControl({ api, agentId, initialProfile, onChanged }) {
  const [profile, setProfile] = useState(initialProfile || 'balanced');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { setProfile(initialProfile || 'balanced'); }, [initialProfile]);
  async function change(next) {
    setSaving(true);
    setMsg('');
    try {
      await api.put(`/api/agents/${agentId}/profile`, { profile: next });
      setProfile(next);
      setMsg('Actualizado');
      setTimeout(() => setMsg(''), 3000);
      if (onChanged) onChanged(next);
    } catch (e) {
      setMsg('Error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <span className="interval-pill" title="Perfil de recolección del agente">
      <select value={profile} disabled={saving} onChange={(e) => change(e.target.value)} aria-label="Perfil de recolección">
        <option value="minimal">Minimal</option>
        <option value="balanced">Balanced</option>
        <option value="full">Full</option>
      </select>
      {msg && <span className="interval-pill-msg">{msg}</span>}
    </span>
  );
}

function AgentIntervalControl({ api, agentId, initialSeconds, compact = false }) {
  const [seconds, setSeconds] = useState(initialSeconds || 60);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { setSeconds(initialSeconds || 60); }, [initialSeconds]);
  async function change(next) {
    const value = parseInt(next, 10);
    if (![15, 30, 60].includes(value)) return;
    setSaving(true);
    setMsg('');
    try {
      await api.put(`/api/agents/${agentId}/interval`, { seconds: value });
      setSeconds(value);
      setMsg(`Intervalo: ${value}s — se aplica en el próximo heartbeat`);
      setTimeout(() => setMsg(''), 3500);
    } catch (e) {
      setMsg('Error: ' + e.message);
    } finally {
      setSaving(false);
    }
  }
  if (compact) {
    return (
      <span className="interval-pill" title="Intervalo de muestreo del agente">
        <Clock size={14} />
        <select value={seconds} disabled={saving} onChange={(e) => change(e.target.value)} aria-label="Intervalo de muestreo">
          <option value={15}>15s</option>
          <option value={30}>30s</option>
          <option value={60}>60s</option>
        </select>
        {msg && <span className="interval-pill-msg">{msg}</span>}
      </span>
    );
  }
  return (
    <div className="agent-interval-control">
      <label>
        <strong>Intervalo de muestreo:</strong>
        <select value={seconds} disabled={saving} onChange={(e) => change(e.target.value)}>
          <option value={15}>15 segundos</option>
          <option value={30}>30 segundos</option>
          <option value={60}>60 segundos</option>
        </select>
      </label>
      {msg && <span className="interval-msg">{msg}</span>}
    </div>
  );
}

function Usage({ value }) {
  return <div className="usage"><span style={{ width: `${Math.min(value || 0, 100)}%` }} /><strong>{round(value)}%</strong></div>;
}

function DataTable({ columns, rows, empty }) {
  return <div className="table-wrap"><table><thead><tr>{columns.map((col) => <th key={col}>{col}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}{!rows.length && <tr><td colSpan={columns.length} className="empty">{empty}</td></tr>}</tbody></table></div>;
}

function DisksTable({ disks }) {
  return <DataTable empty="Sin muestras de disco" columns={['Unidad / Disco', 'Mount', 'FS', 'Total', 'Usado', 'Libre', 'Uso']} rows={disks.map((d) => [diskLabel(d), d.mountpoint, d.filesystem, bytes(d.total_bytes), bytes(d.used_bytes), bytes(d.free_bytes), <Usage value={d.used_percent} />])} />;
}

function NetworkTable({ networks }) {
  return <DataTable empty="Sin muestras de red" columns={['Interfaz', 'Estado', 'Recibido', 'Enviado']} rows={networks.map((n) => [n.name, <span className={`net-state ${n.up ? 'up' : 'down'}`}>{n.up ? '● up' : '○ down'}</span>, bytes(n.bytes_recv), bytes(n.bytes_sent)])} />;
}

function NetworkTab({ api, agentId, fallbackNetworks }) {
  const [networks, setNetworks] = useState(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    try {
      const data = await api.get(`/api/agents/${agentId}/networks?include_inactive=${includeHidden}`);
      setNetworks(Array.isArray(data?.networks) ? data.networks : []);
    } catch (e) {
      setMessage({ type: 'err', text: 'Error cargando interfaces: ' + e.message });
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [agentId, includeHidden]);

  async function reconcile() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.post(`/api/agents/${agentId}/networks/reconcile`, {});
      await load();
      setMessage({ type: 'ok', text: `Validado: ${result.active ?? 0} activas, ${result.hidden ?? 0} ocultas.` });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error al validar: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  async function hide(name) {
    setBusy(true);
    setMessage(null);
    try {
      await api.put(`/api/agents/${agentId}/networks/hide`, { name });
      await load();
    } catch (e) {
      setMessage({ type: 'err', text: 'Error al ocultar: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  async function restore(name) {
    setBusy(true);
    setMessage(null);
    try {
      await api.put(`/api/agents/${agentId}/networks/restore`, { name });
      await load();
    } catch (e) {
      setMessage({ type: 'err', text: 'Error al restaurar: ' + e.message });
    } finally {
      setBusy(false);
    }
  }

  if (networks === null && fallbackNetworks) {
    // primer render: mostrar fallback de la pagina padre mientras cargamos
    return (
      <div className="network-tab">
        <div className="network-toolbar">
          <span>Cargando interfaces…</span>
        </div>
        <NetworkTable networks={fallbackNetworks} />
      </div>
    );
  }

  const list = networks || [];

  return (
    <div className="network-tab">
      <div className="network-toolbar">
        <div className="network-toolbar-info">
          <strong>Interfaces de red</strong>
          <span>{list.length} {list.length === 1 ? 'interfaz' : 'interfaces'}{includeHidden ? ' (incluyendo ocultas)' : ' activas'}</span>
        </div>
        <div className="network-toolbar-actions">
          <label className="toggle-inline">
            <input type="checkbox" checked={includeHidden} disabled={busy} onChange={(e) => setIncludeHidden(e.target.checked)} />
            <span>Mostrar ocultas</span>
          </label>
          <button type="button" className="btn-secondary" onClick={reconcile} disabled={busy}>
            <RefreshCw size={14} /> {busy ? 'Validando…' : 'Validar interfaces'}
          </button>
        </div>
      </div>
      {message && <p className={`form-msg ${message.type}`}>{message.text}</p>}
      <DataTable
        empty="Sin interfaces para mostrar"
        columns={['Interfaz', 'Estado', 'Recibido', 'Enviado', 'Visibilidad']}
        rows={list.map((n) => [
          n.name,
          <span className={`net-state ${n.up ? 'up' : 'down'}`}>{n.up ? '● up' : '○ down'}</span>,
          bytes(n.bytes_recv),
          bytes(n.bytes_sent),
          n.hidden ? (
            <button type="button" className="icon-btn" title="Restaurar interfaz" disabled={busy} onClick={() => restore(n.name)}>
              <Eye size={14} /> Restaurar
            </button>
          ) : (
            <button type="button" className="icon-btn danger" title="Ocultar interfaz" disabled={busy} onClick={() => hide(n.name)}>
              <EyeOff size={14} /> Ocultar
            </button>
          ),
        ])}
      />
    </div>
  );
}

function ProcessesTable({ processes, isOffline = false, lastSeenAt = null }) {
  return (
    <>
      {isOffline && (
        <div className="offline-banner" role="status">
          <strong>Equipo offline</strong>
          <span>Procesos congelados al ultimo contacto{lastSeenAt ? ` (${date(lastSeenAt)})` : ''}. Pueden no reflejar el estado real del equipo.</span>
        </div>
      )}
      <DataTable empty="Sin procesos destacados" columns={['Proceso', 'PID', 'CPU', 'RAM']} rows={processes.map((p) => [p.name, p.pid, percent(p.cpu_percent), percent(p.memory_percent)])} />
    </>
  );
}

function ServicesTable({ services }) {
  return <DataTable empty="Sin servicios reportados aún" columns={['Servicio', 'Estado']} rows={services.map((s) => [s.name, <span className={`svc-state ${s.status === 'running' ? 'ok' : 'err'}`}>{s.status}</span>])} />;
}

function ServicesTab({ api, agentId, services }) {
  const [configured, setConfigured] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async () => {
    try {
      const data = await api.get(`/api/agents/${agentId}/services-config`);
      setConfigured(Array.isArray(data?.services) ? data.services : []);
    } catch (e) {
      setMessage({ type: 'err', text: 'Error cargando configuración: ' + e.message });
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [agentId]);

  async function addService() {
    const name = draft.trim();
    if (!name) return;
    if (configured?.includes(name)) {
      setMessage({ type: 'err', text: `${name} ya está en la lista` });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const next = [...(configured || []), name];
      const data = await api.put(`/api/agents/${agentId}/services-config`, { services: next });
      setConfigured(data.services || next);
      setDraft('');
      setMessage({ type: 'ok', text: `${name} agregado. El agente lo aplicará en el próximo heartbeat.` });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error: ' + e.message });
    } finally {
      setSaving(false);
    }
  }

  async function removeService(name) {
    setSaving(true);
    setMessage(null);
    try {
      const next = (configured || []).filter((n) => n !== name);
      const data = await api.put(`/api/agents/${agentId}/services-config`, { services: next });
      setConfigured(data.services || next);
      setMessage({ type: 'ok', text: `${name} eliminado.` });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error: ' + e.message });
    } finally {
      setSaving(false);
    }
  }

  if (configured === null) return <Skeleton />;

  const statusByName = new Map(services.map((s) => [s.name, s.status]));
  const reportedExtras = services.filter((s) => !configured.includes(s.name)).map((s) => s.name);

  return (
    <div className="services-tab">
      <Panel title="Servicios monitoreados" action={
        <div className="services-add-inline">
          <input
            type="text"
            placeholder="Nombre del servicio (ej. nginx, postgres, MSSQLSERVER)"
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addService(); } }}
          />
          <button type="button" className="btn-primary" disabled={!draft.trim() || saving} onClick={addService}>Agregar</button>
        </div>
      }>
        {message && <p className={`form-msg ${message.type}`}>{message.text}</p>}
        {configured.length === 0 ? (
          <p className="panel-hint">No hay servicios configurados. Agregá los que querés monitorear (ej. <code>nginx</code>, <code>postgres</code>, <code>MSSQLSERVER</code>) — el agente los buscará y reportará su estado en cada ciclo.</p>
        ) : (
          <DataTable
            empty=""
            columns={['Servicio', 'Estado', 'Acciones']}
            rows={configured.map((name) => {
              const status = statusByName.get(name);
              return [
                <strong>{name}</strong>,
                status ? <span className={`svc-state ${status === 'running' ? 'ok' : 'err'}`}>{status}</span> : <span className="svc-state pending">esperando reporte</span>,
                <button type="button" className="icon-btn danger" disabled={saving} title={`Quitar ${name}`} onClick={() => removeService(name)}>
                  <Trash2 size={14} /> Quitar
                </button>,
              ];
            })}
          />
        )}
        {reportedExtras.length > 0 && (
          <p className="panel-hint">El agente también reportó: {reportedExtras.join(', ')} (no configurados).</p>
        )}
      </Panel>
    </div>
  );
}

function TempBadge({ value }) {
  const tone = value >= 80 ? 'bad' : value >= 60 ? 'warn' : 'ok';
  return <span className={`svc-state ${tone}`}>{value.toFixed(1)} °C</span>;
}

function HardwareTab({ hardware, temperatures = [], onRefresh }) {
  if (!hardware && temperatures.length === 0) return <EmptyState icon="🖥️" title="Sin datos de hardware" subtitle="El agente enviará el inventario de hardware en su próxima sincronización (24h)." />;
  const rows = hardware ? [
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
  ] : [];
  return (
    <div>
      {onRefresh && (
        <div className="actions" style={{ marginBottom: 12 }}>
          <IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar inventario" />
        </div>
      )}
      {rows.length > 0 && (
        <div className="hw-grid">
          {rows.map(([label, value]) => (
            <div key={label} className="hw-row">
              <span className="hw-label">{label}</span>
              <span className="hw-value">{value}</span>
            </div>
          ))}
        </div>
      )}
      {temperatures.length > 0 && (
        <div style={{ marginTop: rows.length > 0 ? 24 : 0 }}>
          <h3 style={{ marginBottom: 10, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.6 }}>Temperaturas</h3>
          <DataTable
            empty="Sin lecturas de temperatura"
            columns={['Sensor', 'Temperatura']}
            rows={temperatures.map((t) => [t.sensor_key, <TempBadge value={t.temperature_c} />])}
          />
        </div>
      )}
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

function expandDiskRules(rules, disks, agentId) {
  if (!Array.isArray(rules)) return rules;
  const diskRules = rules.filter((r) => r.metric === 'disk_used_percent');
  const defaultWarn = diskRules.find((r) => r.resource_key === '' && r.severity === 'warning');
  const defaultCrit = diskRules.find((r) => r.resource_key === '' && r.severity === 'critical');
  const existingMounts = new Set(diskRules.map((r) => r.resource_key).filter((k) => k !== ''));
  const additions = [];
  const seen = new Set();
  for (const d of disks || []) {
    const mount = (d?.mountpoint || d?.name || '').trim();
    if (!mount || existingMounts.has(mount) || seen.has(mount)) continue;
    seen.add(mount);
    additions.push({
      id: `auto:${mount}:warning`,
      agent_id: agentId,
      metric: 'disk_used_percent',
      resource_key: mount,
      severity: 'warning',
      enabled: defaultWarn?.enabled ?? true,
      threshold: defaultWarn?.threshold ?? 70,
      duration_samples: defaultWarn?.duration_samples ?? 2,
      notify_email: defaultWarn?.notify_email ?? false,
      notify_telegram: defaultWarn?.notify_telegram ?? false,
      cooldown_minutes: defaultWarn?.cooldown_minutes ?? 30,
      description: `Disco ${mount} sobre umbral warning`,
      source: 'agent',
    });
    additions.push({
      id: `auto:${mount}:critical`,
      agent_id: agentId,
      metric: 'disk_used_percent',
      resource_key: mount,
      severity: 'critical',
      enabled: defaultCrit?.enabled ?? true,
      threshold: defaultCrit?.threshold ?? 90,
      duration_samples: defaultCrit?.duration_samples ?? 2,
      notify_email: defaultCrit?.notify_email ?? true,
      notify_telegram: defaultCrit?.notify_telegram ?? false,
      cooldown_minutes: defaultCrit?.cooldown_minutes ?? 30,
      description: `Disco ${mount} sobre umbral critical`,
      source: 'agent',
    });
  }
  const withoutDefault = rules.filter((r) => !(r.metric === 'disk_used_percent' && r.resource_key === ''));
  return [...withoutDefault, ...additions];
}

function AgentRulesTab({ api, agentId, disks, agentProfile, onProfileChange }) {
  const [rules, setRules] = useState(null);
  const [pendingExpand, setPendingExpand] = useState(false);
  const [customEnabled, setCustomEnabled] = useState(false);
  const [smtpOk, setSmtpOk] = useState(false);
  const [telegramOk, setTelegramOk] = useState(false);
  const [message, setMessage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newDiskMount, setNewDiskMount] = useState('');

  const loadAll = () => {
    let alive = true;
    Promise.all([
      api.get(`/api/agents/${agentId}/alert-rules`),
      api.get('/api/alert-settings/smtp'),
      api.get('/api/settings/telegram'),
    ]).then(([rulesData, smtp, tg]) => {
      if (!alive) return;
      setRules(rulesData.rules || []);
      setPendingExpand(true);
      setCustomEnabled(!!rulesData.custom_rules_enabled);
      setSmtpOk(!!(smtp.enabled && smtp.host));
      setTelegramOk(!!(tg.enabled && tg.chat_ids));
    }).catch((e) => alive && setMessage({ type: 'err', text: 'Error cargando reglas: ' + e.message }));
    return () => { alive = false; };
  };

  useEffect(() => {
    if (!pendingExpand || !rules || !disks || disks.length === 0) return;
    setRules((prev) => expandDiskRules(prev, disks, agentId));
    setPendingExpand(false);
  }, [pendingExpand, rules, disks, agentId]);

  async function toggleCustom(next) {
    setSaving(true);
    setMessage(null);
    try {
      await api.put(`/api/agents/${agentId}/custom-rules-enabled`, { enabled: next });
      setCustomEnabled(next);
      setMessage({ type: 'ok', text: next ? 'Reglas personalizadas activadas. Editá los umbrales que quieras y guardá.' : 'Reglas personalizadas desactivadas. El equipo usa las reglas globales.' });
    } catch (e) {
      setMessage({ type: 'err', text: 'Error: ' + e.message });
    } finally {
      setSaving(false);
    }
  }

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
      setPendingExpand(true);
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
      setPendingExpand(true);
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

  const availableMounts = (disks || [])
    .map((d) => (d.mountpoint || d.name || '').trim())
    .filter((m) => m && !diskKeys.includes(m));
  const uniqueAvailableMounts = [...new Set(availableMounts)];

  function addDiskRule(mountpoint) {
    const key = (mountpoint || '').trim();
    if (!key) return;
    const defaultWarn = diskRules.find((r) => r.resource_key === '' && r.severity === 'warning');
    const defaultCrit = diskRules.find((r) => r.resource_key === '' && r.severity === 'critical');
    const fresh = [
      {
        id: `new:${key}:warning`,
        agent_id: agentId,
        metric: 'disk_used_percent',
        resource_key: key,
        severity: 'warning',
        enabled: true,
        threshold: defaultWarn?.threshold ?? 70,
        duration_samples: defaultWarn?.duration_samples ?? 2,
        notify_email: defaultWarn?.notify_email ?? false,
        notify_telegram: defaultWarn?.notify_telegram ?? false,
        cooldown_minutes: defaultWarn?.cooldown_minutes ?? 30,
        description: `Disco ${key} sobre umbral warning`,
        source: 'agent',
      },
      {
        id: `new:${key}:critical`,
        agent_id: agentId,
        metric: 'disk_used_percent',
        resource_key: key,
        severity: 'critical',
        enabled: true,
        threshold: defaultCrit?.threshold ?? 90,
        duration_samples: defaultCrit?.duration_samples ?? 2,
        notify_email: defaultCrit?.notify_email ?? true,
        notify_telegram: defaultCrit?.notify_telegram ?? false,
        cooldown_minutes: defaultCrit?.cooldown_minutes ?? 30,
        description: `Disco ${key} sobre umbral critical`,
        source: 'agent',
      },
    ];
    setRules((prev) => [...prev, ...fresh]);
    setNewDiskMount('');
    setMessage({ type: 'ok', text: `Regla para ${key} agregada. Recordá guardar para persistirla.` });
  }

  function removeDiskRule(key) {
    if (!key) return;
    setRules((prev) => prev.filter((r) => !(r.metric === 'disk_used_percent' && r.resource_key === key)));
    setMessage({ type: 'ok', text: `Regla de ${key} eliminada. Recordá guardar para persistir.` });
  }

  return (
    <Panel
      title="Reglas de alertas"
      action={
        <div className="actions">
          <AgentProfileControl api={api} agentId={agentId} initialProfile={agentProfile} onChanged={onProfileChange} />
          <label className="toggle-switch" title="Activar reglas personalizadas para este equipo">
            <input type="checkbox" checked={customEnabled} disabled={saving} onChange={(e) => toggleCustom(e.target.checked)} />
            <span>Reglas personalizadas</span>
          </label>
          {customEnabled && <IconButton icon={RefreshCw} label="Restaurar" onClick={reset} disabled={saving} />}
          {customEnabled && <IconButton icon={Save} label={saving ? 'Guardando…' : 'Guardar reglas'} onClick={save} disabled={saving} />}
        </div>
      }
    >
      {message && <p className={`form-msg ${message.type}`}>{message.text}</p>}

      {!customEnabled && (
        <p className="panel-hint">
          Este equipo está usando las <strong>reglas globales</strong>. Activá el toggle de arriba para personalizar umbrales y notificaciones solo para este equipo.
        </p>
      )}

      {customEnabled && (
        <>
          <p className="panel-hint">
            Personaliza umbrales y notificaciones para este equipo. Las reglas que no modifiques heredan los valores globales.
            {overrideCount > 0 && <> · <strong>{overrideCount}</strong> regla{overrideCount !== 1 ? 's' : ''} personalizada{overrideCount !== 1 ? 's' : ''}.</>}
          </p>

          {!smtpOk && <p className="warn-inline">SMTP no configurado — actívalo en pestaña SMTP para usar notificaciones por email</p>}
          {!telegramOk && <p className="warn-inline">Telegram no configurado — actívalo en pestaña Telegram para usar notificaciones</p>}
        </>
      )}

      {customEnabled && (<>
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
                  <th></th>
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
                      <td>
                        {key !== '' && (
                          <button type="button" className="icon-btn danger" title={`Eliminar regla de ${key}`} onClick={() => removeDiskRule(key)} disabled={saving}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {uniqueAvailableMounts.length > 0 && (
                  <tr className="rules-disk-add">
                    <td colSpan={8}>
                      <div className="rules-disk-add-row">
                        <span>Agregar regla para una unidad / mount:</span>
                        <select value={newDiskMount} onChange={(e) => setNewDiskMount(e.target.value)} disabled={saving}>
                          <option value="">Elegí un mount…</option>
                          {uniqueAvailableMounts.map((m) => (<option key={m} value={m}>{m}</option>))}
                        </select>
                        <button type="button" className="btn-primary" disabled={!newDiskMount || saving} onClick={() => addDiskRule(newDiskMount)}>Agregar</button>
                      </div>
                    </td>
                  </tr>
                )}
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
      </>)}
    </Panel>
  );
}

function SummaryTab({ agent, status, disks, networks, services, alerts, history }) {
  const os = detectOS(agent?.os);
  const commands = useMemo(() => agentCommands(os), [os]);
  const cpuSpark = useMemo(
    () => (history?.metrics || []).slice(-60).map((p) => Number(p.cpu_percent || 0)),
    [history]
  );
  const ramSpark = useMemo(
    () => (history?.metrics || []).slice(-60).map((p) => Number(p.memory_used_percent || 0)),
    [history]
  );
  const latestMetric = history?.metrics?.length ? history.metrics[history.metrics.length - 1] : null;
  const latestNet = history?.network?.length ? history.network[history.network.length - 1] : null;

  const busiestDisk = [...disks].sort((a, b) => Number(b.used_percent || 0) - Number(a.used_percent || 0))[0];
  const upInterfaces = networks.filter((n) => n.up).length;
  const downServices = services.filter((s) => s.status !== 'running').length;
  const hasServices = services.length > 0;
  const alertsCount = alerts.length;

  const cpu = agent.cpu_percent || 0;
  const ram = agent.memory_used_percent || 0;
  const lastSeen = status?.last_seen_at || agent.last_seen_at;

  return (
    <>
      <div className="summary-meta">
        <Status status={agent.status} />
        {agent.primary_ip && <span><strong>IP</strong> {agent.primary_ip}</span>}
        {agent.agent_version && <span><strong>Versión</strong> {agent.agent_version}</span>}
        {agent.uptime_seconds ? <span><strong>Uptime</strong> {duration(agent.uptime_seconds)}</span> : null}
        {lastSeen && <span><strong>Último contacto</strong> {relativeTime(new Date(lastSeen))}</span>}
      </div>

      <div className="kpi-grid compact">
        <Kpi icon={Cpu} label="CPU actual" value={percent(cpu)} tone={pickTone(cpu)} />
        <Kpi icon={MemoryStick} label="RAM actual" value={percent(ram)} tone={pickTone(ram)} />
        <Kpi icon={HardDrive} label="Disco más usado" value={busiestDisk ? `${diskLabel(busiestDisk)} · ${percent(busiestDisk.used_percent)}` : '—'} tone={pickTone(busiestDisk?.used_percent)} />
        <Kpi icon={Network} label="Interfaces UP" value={networks.length ? `${upInterfaces} / ${networks.length}` : '—'} />
        <Kpi icon={Activity} label="Latencia GW" value={latestMetric?.gateway_latency_ms != null ? `${Number(latestMetric.gateway_latency_ms).toFixed(1)} ms` : '—'} />
        <Kpi icon={Gauge} label="Red ↓ / ↑" value={latestNet ? `${rate(latestNet.bytes_recv_per_sec)} / ${rate(latestNet.bytes_sent_per_sec)}` : '—'} />
        <Kpi icon={Settings} label={hasServices ? 'Servicios caídos' : 'Servicios'} value={hasServices ? `${downServices} / ${services.length}` : 'sin monitoreo'} tone={hasServices && downServices > 0 ? 'bad' : ''} />
        <Kpi icon={AlertTriangle} label="Alertas activas" value={alertsCount} tone={alertsCount > 0 ? 'bad' : ''} />
      </div>

      {status && (
        <div className="diagnostic-band">
          <span>Último heartbeat: {date(status.last_seen_at)} ({relativeTime(new Date(status.last_seen_at))})</span>
          <span>Marca offline tras {status.offline_after_seconds}s sin contacto</span>
        </div>
      )}

      <Panel title="Diagnóstico del agente" action={<span className="os-chip">{OS_LABEL[os]}</span>}>
        <div className="cmd-list">
          {commands.map(({ cmd, desc }) => <CommandLine key={cmd} cmd={cmd} desc={desc} />)}
        </div>
      </Panel>
    </>
  );
}

function ResourcesTab({ agent, history, historyLoading = false, disks: currentDisks = [], networks: currentNetworks = [], range, setRange, isOffline = false, lastSeenAt = null }) {
  const rawMetrics = history?.metrics || [];
  const rawNetwork = history?.network || history?.networks || [];
  const rawDiskHistory = history?.disks || [];
  const diskNames = useMemo(
    () => [...new Set(rawDiskHistory.map((d) => d.mountpoint || d.name))].slice(0, 4),
    [rawDiskHistory]
  );

  const grid = useMemo(() => generateTimeGrid(range), [range]);
  const metrics = useMemo(
    () => padHistoryToGrid(rawMetrics, grid, ['cpu_percent', 'memory_used_percent', 'swap_used_percent', 'gateway_latency_ms']),
    [rawMetrics, grid]
  );
  const network = useMemo(
    () => padHistoryToGrid(rawNetwork, grid, ['bytes_recv_per_sec', 'bytes_sent_per_sec']),
    [rawNetwork, grid]
  );
  const disksForChart = useMemo(
    () => pivotDisks(rawDiskHistory, diskNames, grid),
    [rawDiskHistory, diskNames, grid]
  );

  // Series memoizadas: evita que LineChart re-renderice por nueva referencia
  // del array literal en cada render del padre.
  const cpuSeries = useMemo(() => [["CPU", "cpu_percent", "#3b82f6"], ["RAM", "memory_used_percent", "#a855f7"], ["Swap", "swap_used_percent", "#f59e0b"]], []);
  const netSeries = useMemo(() => [["Recibido", "bytes_recv_per_sec", "#ec4899"], ["Enviado", "bytes_sent_per_sec", "#06b6d4"]], []);
  const latSeries = useMemo(() => [["Latencia GW", "gateway_latency_ms", "#10b981"]], []);
  const diskSeries = useMemo(() => diskNames.map((name, i) => [name, name, DISK_COLORS[i % DISK_COLORS.length]]), [diskNames]);
  const latencyFormatter = useMemo(() => (v) => v != null ? `${Number(v).toFixed(1)} ms` : '—', []);

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
      {isOffline && (
        <div className="offline-banner" role="status">
          <strong>Equipo offline</strong>
          <span>Las graficas muestran el ultimo contacto{lastSeenAt ? ` (${date(lastSeenAt)})` : ''}. Sin actualizacion automatica hasta que el agente reconecte.</span>
        </div>
      )}
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
          <LineChart points={metrics} grid={grid} series={cpuSeries} max={100} />
        </ChartPanel>
        <ChartPanel title="Red" subtitle="Velocidad recibida / enviada" unit="B/s">
          <LineChart points={network} grid={grid} series={netSeries} formatter={rate} />
        </ChartPanel>
        <ChartPanel title="Latencia al gateway" subtitle="Latencia promedio al gateway" unit="ms">
          <LineChart points={metrics} grid={grid} series={latSeries} formatter={latencyFormatter} />
        </ChartPanel>
        {diskNames.length > 0 && (
          <ChartPanel title="Uso de disco" subtitle="% usado por unidad / mount" unit="%">
            <LineChart points={disksForChart} grid={grid} series={diskSeries} max={100} />
          </ChartPanel>
        )}
      </div>
    </>
  );
}

export default function AgentDetail({ api, agentId, onBack }) {
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

  const isOffline = data?.agent?.status === 'offline';
  const lastSeenAt = data?.agent_status?.last_seen_at || data?.agent?.last_seen_at || null;

  const { data: historyData, loading: historyLoading } = useLoad(
    () => api.get(`/api/agents/${agentId}/history?range=${range}`),
    [agentId, range, isOffline],
    isOffline ? 0 : CHART_REFRESH_MS
  );

  const { data: inventory, reload: reloadInventory } = useLoad(() => api.get(`/api/agents/${agentId}/inventory`), [agentId], 0);
  const agent = data?.agent;
  const disks = useMemo(() => [...(data?.disks || [])].sort((a, b) => Number(b.used_percent || 0) - Number(a.used_percent || 0)), [data?.disks]);
  const networks = useMemo(() => [...(data?.networks || [])].sort((a, b) => (a.up ? 0 : 1) - (b.up ? 0 : 1)), [data?.networks]);
  const processes = useMemo(() => [...(data?.processes || [])].sort((a, b) => (Number(b.cpu_percent || 0) + Number(b.memory_percent || 0)) - (Number(a.cpu_percent || 0) + Number(a.memory_percent || 0))), [data?.processes]);
  const services = useMemo(() => [...(data?.services || [])].sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1)), [data?.services]);
  const temperatures = useMemo(() => [...(data?.temperatures || [])].sort((a, b) => a.sensor_key.localeCompare(b.sensor_key)), [data?.temperatures]);
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
      <Header title={agent?.name || 'Equipo'} meta={<div className="actions">{agent && <AgentIntervalControl api={api} agentId={agentId} initialSeconds={data.interval_seconds || 60} compact />}<button onClick={onBack} disabled={deleting}>Volver</button><IconButton icon={Edit3} onClick={renameAgent} label="Renombrar" disabled={deleting} /><IconButton icon={Trash2} onClick={deleteAgent} label={deleting ? 'Eliminando…' : 'Eliminar'} disabled={deleting} /><RefreshMeta lastUpdated={lastUpdated} loading={loading} onRefresh={reload} /></div>} />
      {agent && (
        <>
          <div className="detail-head"><Status status={agent.status} /><span>{data.status_reason}</span><span>{agent.hostname}</span><span>{agent.os}</span><span>{agent.arch}</span>{agent.primary_ip && <span>{agent.primary_ip}</span>}</div>
          <AgentTags api={api} agentId={agentId} initialTags={agent.tags || []} />
          {(() => {
            const profile = agent?.profile || 'balanced';
            const hasNetwork = profile !== 'minimal';
            const hasProcesses = profile !== 'minimal';
            const hasServices = profile !== 'minimal';
            const allTabs = ['summary', 'resources', 'disks', ...(hasNetwork ? ['network'] : []), ...(hasProcesses ? ['processes'] : []), ...(hasServices ? ['services'] : []), 'alerts', 'rules', 'hardware', 'software'];
            return (
              <>
                <div className="tab-row">
                  {allTabs.map((item) => <button key={item} className={tab === item ? 'selected' : ''} onClick={() => setTab(item)}>{tabLabel(item)}</button>)}
                </div>
                {tab === 'summary' && <SummaryTab agent={agent} status={data.agent_status} disks={disks} networks={networks} services={services} alerts={alerts} history={historyData} />}
                {tab === 'resources' && <ResourcesTab agent={agent} history={historyData} historyLoading={historyLoading} disks={disks} networks={networks} range={range} setRange={setRange} isOffline={isOffline} lastSeenAt={lastSeenAt} />}
                {tab === 'disks' && <DisksTable disks={disks} />}
                {tab === 'network' && hasNetwork && <NetworkTab api={api} agentId={agentId} fallbackNetworks={networks} />}
                {tab === 'processes' && hasProcesses && <ProcessesTable processes={processes} isOffline={isOffline} lastSeenAt={lastSeenAt} />}
                {tab === 'services' && hasServices && <ServicesTab api={api} agentId={agentId} services={services} />}
                {tab === 'alerts' && <AlertList alerts={alerts} api={api} onChange={reload} />}
                {tab === 'rules' && <AgentRulesTab api={api} agentId={agentId} disks={disks} agentProfile={agent?.profile} onProfileChange={reload} />}
                {tab === 'hardware' && <HardwareTab hardware={inventory?.hardware} temperatures={temperatures} onRefresh={reloadInventory} />}
                {tab === 'software' && <SoftwareTab software={inventory?.software} onRefresh={reloadInventory} />}
              </>
            );
          })()}
        </>
      )}
    </section>
  );
}
