import React, { useEffect, useState } from 'react';
import { AlertTriangle, Eye, Save } from 'lucide-react';
import {
  AlertList,
  Header,
  IconButton,
  METRIC_LABELS,
  METRIC_UNITS,
  Panel,
  REFRESH_MS,
  RefreshMeta,
  Skeleton,
  timeAgo,
  useLoad,
} from '../lib/ui';

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
      {!smtpOk && <p className="warn-inline">SMTP no habilitado — configura en <strong>Configuración → SMTP</strong> para usar notificaciones por email</p>}
      {!telegramOk && <p className="warn-inline">Telegram no habilitado — configura en <strong>Configuración → Telegram</strong> para usar notificaciones por Telegram</p>}
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

export default function AlertsCenter({ api }) {
  const [tab, setTab] = useState('alerts');
  return (
    <section>
      <Header title="Alertas" />
      <div className="tab-row">
        <button className={tab === 'alerts' ? 'selected' : ''} onClick={() => setTab('alerts')}>Alertas activas</button>
        <button className={tab === 'stats' ? 'selected' : ''} onClick={() => setTab('stats')}>Estadísticas</button>
        <button className={tab === 'timeline' ? 'selected' : ''} onClick={() => setTab('timeline')}>Timeline</button>
        <button className={tab === 'rules' ? 'selected' : ''} onClick={() => setTab('rules')}>Reglas</button>
      </div>
      {tab === 'alerts' && <Alerts api={api} />}
      {tab === 'stats' && <AlertStats api={api} />}
      {tab === 'timeline' && <AlertTimeline api={api} />}
      {tab === 'rules' && <AlertRulesPanel api={api} />}
    </section>
  );
}
