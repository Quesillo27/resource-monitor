import React, { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export const REFRESH_MS = 60_000;

export const METRIC_LABELS = {
  cpu: 'CPU',
  ram: 'RAM',
  disk_used_percent: 'Disco',
  network_recv_mbps: 'Red recv',
  network_sent_mbps: 'Red sent',
  agent_offline_minutes: 'Sin conexion',
};

export const METRIC_UNITS = {
  cpu: '%',
  ram: '%',
  disk_used_percent: '%',
  network_recv_mbps: 'Mbps',
  network_sent_mbps: 'Mbps',
  agent_offline_minutes: 'min',
};

export function round(value) {
  return Number(value || 0).toFixed(1);
}

export function percent(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${round(value)}%`;
}

export function date(value) {
  if (!value) return 'n/a';
  return new Date(value).toLocaleString();
}

export function relativeTime(value) {
  if (!value) return 'pendiente';
  const seconds = Math.max(0, Math.round((Date.now() - value.getTime()) / 1000));
  if (seconds < 5) return 'ahora';
  if (seconds < 60) return `hace ${seconds}s`;
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)}min`;
  return `hace ${Math.floor(seconds / 3600)}h`;
}

export function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  return `hace ${Math.floor(hrs / 24)}d`;
}

export function humanMinutes(mins) {
  if (mins == null || isNaN(mins)) return '—';
  const m = Number(mins);
  if (m < 0) return '—';
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${m.toFixed(1)} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = Math.round(m - h * 60);
    return r === 0 ? `${h}h` : `${h}h ${r}min`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m - d * 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

export function copyTextFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function useLoad(loader, deps, refreshMs = 0) {
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

export function Header({ title, meta }) {
  return <header className="page-header"><div><h1>{title}</h1></div>{meta}</header>;
}

export function Panel({ title, action, children }) {
  return <section className="panel"><div className="panel-head"><h2>{title}</h2>{action}</div>{children}</section>;
}

export function IconButton({ icon: Icon, label, onClick }) {
  return <button className="icon-button" title={label} aria-label={label} onClick={onClick}><Icon size={18} /></button>;
}

export function RefreshMeta({ lastUpdated, loading, onRefresh }) {
  return (
    <div className="refresh-meta">
      <span>{loading ? 'Actualizando...' : `Actualizado ${relativeTime(lastUpdated)}`}</span>
      <IconButton icon={RefreshCw} onClick={onRefresh} label="Actualizar" />
    </div>
  );
}

export function Skeleton() {
  return <div className="skeleton-wrap"><div className="skeleton" /><div className="skeleton" style={{ width: '70%' }} /><div className="skeleton" style={{ width: '85%' }} /></div>;
}

export function Modal({ title, children, onClose }) {
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

export function AlertList({ alerts, compact = false, api = null, onChange = null }) {
  const [channels, setChannels] = useState({ smtpOk: false, telegramOk: false });
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    Promise.all([
      api.get('/api/settings/smtp').catch(() => ({})),
      api.get('/api/settings/telegram').catch(() => ({})),
    ]).then(([smtp, tg]) => {
      if (cancelled) return;
      setChannels({
        smtpOk: !!(smtp && smtp.enabled && smtp.host),
        telegramOk: !!(tg && tg.enabled && tg.chat_ids),
      });
    });
    return () => { cancelled = true; };
  }, [api]);
  if (!alerts.length) return <p className="empty-panel">Sin alertas activas ✓</p>;
  async function markSeen(id) {
    if (!api) return;
    await api.post(`/api/alerts/${id}/seen`, {});
    onChange && onChange();
  }
  const fmt = (v, u) => {
    if (v == null) return '—';
    const unit = (u || '').trim();
    if (unit === 'min') return humanMinutes(v);
    return `${Number(v).toFixed(1)}${unit}`;
  };
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
              {alert.notify_email && channels.smtpOk && <span title="Notifica por email">· ✉ email</span>}
              {alert.notify_telegram && channels.telegramOk && <span title="Notifica por telegram">· ✈ telegram</span>}
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
