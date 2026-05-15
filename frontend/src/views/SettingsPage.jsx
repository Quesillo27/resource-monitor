import React, { useEffect, useState } from 'react';
import { Bell, Edit3, KeyRound, Mail, Save, Send, Trash2 } from 'lucide-react';
import { Header, Panel, Modal, IconButton, RefreshMeta, Skeleton, useLoad, date } from '../lib/ui';

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
          <span className="system-label">Reglas de alertas</span>
          <strong>Globales y por equipo</strong>
          <small>Configura desde Alertas → Reglas (globales) o desde el detalle del equipo</small>
        </div>
      </div>
    </Panel>
  );
}

export default function SettingsPage({ api }) {
  const [tab, setTab] = useState('users');
  return (
    <section>
      <Header title="Configuración" />
      <div className="tab-row">
        <button className={tab === 'users' ? 'selected' : ''} onClick={() => setTab('users')}>Usuarios</button>
        <button className={tab === 'smtp' ? 'selected' : ''} onClick={() => setTab('smtp')}>SMTP</button>
        <button className={tab === 'telegram' ? 'selected' : ''} onClick={() => setTab('telegram')}>Telegram</button>
        <button className={tab === 'system' ? 'selected' : ''} onClick={() => setTab('system')}>Sistema</button>
      </div>
      {tab === 'users' && <UsersPanel api={api} />}
      {tab === 'smtp' && <SMTPSettings api={api} />}
      {tab === 'telegram' && <TelegramSettings api={api} />}
      {tab === 'system' && <SystemPanel api={api} />}
    </section>
  );
}
