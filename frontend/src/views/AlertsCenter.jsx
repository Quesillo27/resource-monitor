import React, { useEffect, useState } from 'react';
import { AlertTriangle, Bell, Eye, Mail, Save, Send } from 'lucide-react';
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
