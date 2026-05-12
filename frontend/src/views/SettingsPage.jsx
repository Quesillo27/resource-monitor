import React, { useState } from 'react';
import { Edit3, KeyRound, Save, Trash2 } from 'lucide-react';
import { Header, Panel, Modal, IconButton, RefreshMeta, useLoad, date } from '../lib/ui';

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

export default function SettingsPage({ api }) {
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
