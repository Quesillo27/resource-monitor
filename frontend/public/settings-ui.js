(() => {
  const API_BASE = `${location.protocol}//${location.hostname}:8080`;
  const css = `
    .rm-settings-nav { margin-top:8px; display:flex; align-items:center; gap:12px; width:100%; border:0; background:transparent; color:#dbeafe; padding:12px 16px; border-radius:8px; font:inherit; cursor:pointer; text-align:left; }
    .rm-settings-nav:hover,.rm-settings-nav.active { background:#24364a; color:#fff; }
    .rm-settings { padding:32px 36px; color:#061832; }
    .rm-settings-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:24px; }
    .rm-settings h1 { margin:0; font-size:32px; letter-spacing:0; }
    .rm-settings p { color:#53657e; margin:6px 0 0; }
    .rm-tabs { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .rm-tab { border:1px solid #cbd8ea; background:#fff; color:#0b2442; border-radius:8px; padding:10px 14px; cursor:pointer; font-weight:600; }
    .rm-tab.active { border-color:#2563eb; color:#0b55b7; background:#eff6ff; }
    .rm-panel { background:#fff; border:1px solid #dbe5f0; border-radius:8px; box-shadow:0 16px 36px rgba(15,23,42,.05); padding:22px; }
    .rm-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .rm-field label { display:block; color:#40536f; font-size:13px; font-weight:800; margin-bottom:7px; }
    .rm-field input,.rm-field select,.rm-field textarea { width:100%; box-sizing:border-box; border:1px solid #cbd8ea; border-radius:8px; padding:12px; font:inherit; background:#fff; }
    .rm-field textarea { min-height:82px; resize:vertical; }
    .rm-check { display:flex; align-items:center; gap:10px; color:#40536f; font-weight:800; }
    .rm-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; }
    .rm-btn { border:1px solid #cbd8ea; background:#fff; color:#0b2442; border-radius:8px; padding:11px 14px; cursor:pointer; font-weight:700; }
    .rm-btn.primary { background:#2563eb; color:#fff; border-color:#2563eb; }
    .rm-msg { margin-top:12px; color:#53657e; font-weight:700; }
    .rm-table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e1e9f4; border-radius:8px; }
    .rm-table th { background:#f6f8fb; color:#53657e; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:12px; }
    .rm-table td { padding:12px; border-top:1px solid #edf2f7; }
    .rm-role { border:1px solid #dbe5f0; border-radius:999px; padding:4px 8px; color:#334b68; font-size:12px; font-weight:800; }
    .rm-denied { background:#fff; border:1px solid #dbe5f0; border-radius:8px; padding:24px; color:#53657e; }
    @media (max-width:900px){ .rm-grid{grid-template-columns:1fr;} .rm-settings{padding:22px;} }
  `;

  function token() { return localStorage.getItem('rm_token') || ''; }
  function decodeRole() {
    try { return JSON.parse(atob(token().split('.')[1] || '')).role || 'viewer'; } catch { return 'viewer'; }
  }
  function headers() { return { Authorization: `Bearer ${token()}`, 'Content-Type':'application/json' }; }
  async function api(path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function style() {
    if (document.getElementById('rm-settings-style')) return;
    const el = document.createElement('style'); el.id = 'rm-settings-style'; el.textContent = css; document.head.appendChild(el);
  }
  function input(id, label, value='', type='text') { return `<div class="rm-field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${escapeAttr(value)}"></div>`; }
  function escapeAttr(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function main() { return document.querySelector('main') || document.querySelector('#root > div > div:nth-child(2)') || document.body; }

  function addNav() {
    if (document.querySelector('.rm-settings-nav')) return;
    const aside = document.querySelector('aside') || document.querySelector('[class*=sidebar]') || document.querySelector('#root nav');
    if (!aside) return;
    const btn = document.createElement('button');
    btn.className = 'rm-settings-nav';
    btn.innerHTML = '<span>⚙</span><span>Configuración</span>';
    btn.onclick = () => render('smtp');
    const logout = [...aside.querySelectorAll('button,a')].find(el => /salir/i.test(el.textContent || ''));
    if (logout?.parentNode) logout.parentNode.insertBefore(btn, logout); else aside.appendChild(btn);
  }

  async function render(tab) {
    style(); addNav();
    document.querySelectorAll('.rm-settings-nav').forEach(el => el.classList.add('active'));
    const role = decodeRole();
    const root = main();
    root.innerHTML = `<section class="rm-settings"><div class="rm-settings-head"><div><h1>Configuración</h1><p>Canales de notificación, usuarios y seguridad de la consola.</p></div></div>${role !== 'admin' ? '<div class="rm-denied">Tu rol no permite modificar configuración global.</div>' : shell(tab)}</section>`;
    if (role !== 'admin') return;
    bindTabs(tab);
    if (tab === 'smtp') await renderSMTP();
    if (tab === 'telegram') await renderTelegram();
    if (tab === 'users') await renderUsers();
  }
  function shell(active) {
    return `<div class="rm-tabs"><button class="rm-tab ${active==='smtp'?'active':''}" data-tab="smtp">SMTP</button><button class="rm-tab ${active==='telegram'?'active':''}" data-tab="telegram">Telegram</button><button class="rm-tab ${active==='users'?'active':''}" data-tab="users">Usuarios</button></div><div id="rm-settings-panel" class="rm-panel"></div>`;
  }
  function bindTabs() { document.querySelectorAll('.rm-tab').forEach(btn => btn.onclick = () => render(btn.dataset.tab)); }
  function panel() { return document.getElementById('rm-settings-panel'); }

  async function renderSMTP() {
    const cfg = await api('/api/settings/smtp');
    panel().innerHTML = `<h2>SMTP</h2><div class="rm-grid">
      <label class="rm-check"><input id="smtp_enabled" type="checkbox" ${cfg.enabled?'checked':''}> Habilitar correos</label><div></div>
      ${input('smtp_host','Host',cfg.host)}${input('smtp_port','Puerto',cfg.port || 25,'number')}
      ${input('smtp_user','Usuario',cfg.username)}${input('smtp_from','Remitente',cfg.from_address)}
      ${input('smtp_pass','Contraseña','', 'password')}<div class="rm-field"><label>Destinatarios</label><textarea id="smtp_to">${escapeAttr(cfg.to_addresses)}</textarea></div>
      ${input('smtp_cooldown','Cooldown minutos',cfg.cooldown_minutes || 30,'number')}
      <div><label class="rm-check"><input id="smtp_tls" type="checkbox" ${cfg.use_tls?'checked':''}> TLS directo</label><br><label class="rm-check"><input id="smtp_starttls" type="checkbox" ${cfg.use_starttls?'checked':''}> STARTTLS</label></div>
    </div><div class="rm-actions"><button id="smtp_test" class="rm-btn">Probar</button><button id="smtp_save" class="rm-btn primary">Guardar SMTP</button></div><div id="smtp_msg" class="rm-msg"></div>`;
    document.getElementById('smtp_save').onclick = () => saveSMTP(false);
    document.getElementById('smtp_test').onclick = () => saveSMTP(true);
  }
  async function saveSMTP(test) {
    const body = smtpPayload(); const msg = document.getElementById('smtp_msg');
    try { await api(test ? '/api/settings/smtp/test' : '/api/settings/smtp', { method: test ? 'POST':'PUT', body: JSON.stringify(body) }); msg.textContent = test ? 'Prueba enviada.' : 'SMTP guardado.'; }
    catch(e){ msg.textContent = e.message; }
  }
  function smtpPayload() { return { enabled: smtp_enabled.checked, host: smtp_host.value, port: Number(smtp_port.value || 25), username: smtp_user.value, password: smtp_pass.value, from_address: smtp_from.value, to_addresses: smtp_to.value, cooldown_minutes: Number(smtp_cooldown.value || 30), use_tls: smtp_tls.checked, use_starttls: smtp_starttls.checked }; }

  async function renderTelegram() {
    const cfg = await api('/api/settings/telegram');
    panel().innerHTML = `<h2>Telegram</h2><div class="rm-grid">
      <label class="rm-check"><input id="tg_enabled" type="checkbox" ${cfg.enabled?'checked':''}> Habilitar Telegram</label><div></div>
      ${input('tg_token','Bot token','', 'password')}${input('tg_parse','Parse mode',cfg.parse_mode || 'HTML')}
      <div class="rm-field"><label>Chat IDs</label><textarea id="tg_chats">${escapeAttr(cfg.chat_ids)}</textarea></div>${input('tg_cooldown','Cooldown minutos',cfg.cooldown_minutes || 30,'number')}
    </div><div class="rm-actions"><button id="tg_test" class="rm-btn">Probar</button><button id="tg_save" class="rm-btn primary">Guardar Telegram</button></div><div id="tg_msg" class="rm-msg"></div>`;
    document.getElementById('tg_save').onclick = () => saveTelegram(false);
    document.getElementById('tg_test').onclick = () => saveTelegram(true);
  }
  async function saveTelegram(test) {
    const body = { enabled: tg_enabled.checked, bot_token: tg_token.value, chat_ids: tg_chats.value, parse_mode: tg_parse.value || 'HTML', cooldown_minutes: Number(tg_cooldown.value || 30) };
    const msg = document.getElementById('tg_msg');
    try { await api(test ? '/api/settings/telegram/test' : '/api/settings/telegram', { method: test ? 'POST':'PUT', body: JSON.stringify(body) }); msg.textContent = test ? 'Prueba enviada.' : 'Telegram guardado.'; }
    catch(e){ msg.textContent = e.message; }
  }

  async function renderUsers() {
    const data = await api('/api/users');
    const rows = (data.users || []).map(u => `<tr><td>${escapeAttr(u.username)}</td><td><span class="rm-role">${u.role}</span></td><td>${u.active?'Activo':'Inactivo'}</td><td><button class="rm-btn" data-edit="${u.id}">Editar</button> <button class="rm-btn" data-pass="${u.id}">Contraseña</button></td></tr>`).join('');
    panel().innerHTML = `<h2>Usuarios</h2><div class="rm-grid">
      ${input('new_user','Usuario')}${input('new_pass','Contraseña','', 'password')}
      <div class="rm-field"><label>Rol</label><select id="new_role"><option value="admin">admin</option><option value="operator">operator</option><option value="viewer">viewer</option></select></div>
      <label class="rm-check"><input id="new_active" type="checkbox" checked> Activo</label>
    </div><div class="rm-actions"><button id="create_user" class="rm-btn primary">Crear usuario</button></div><div id="users_msg" class="rm-msg"></div><br><table class="rm-table"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows}</tbody></table>`;
    document.getElementById('create_user').onclick = createUser;
    document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => editUser(btn.dataset.edit, data.users.find(u => u.id === btn.dataset.edit)));
    document.querySelectorAll('[data-pass]').forEach(btn => btn.onclick = () => changePassword(btn.dataset.pass));
  }
  async function createUser() {
    const msg = document.getElementById('users_msg');
    try { await api('/api/users', { method:'POST', body: JSON.stringify({ username:new_user.value, password:new_pass.value, role:new_role.value, active:new_active.checked }) }); msg.textContent='Usuario creado.'; await renderUsers(); }
    catch(e){ msg.textContent=e.message; }
  }
  async function editUser(id, user) {
    const username = prompt('Usuario', user.username); if (username === null) return;
    const role = prompt('Rol: admin, operator o viewer', user.role) || user.role;
    const active = confirm('Aceptar = activo. Cancelar = inactivo.');
    await api(`/api/users/${id}`, { method:'PATCH', body: JSON.stringify({ username, role, active }) }); await renderUsers();
  }
  async function changePassword(id) {
    const password = prompt('Nueva contraseña'); if (!password) return;
    await api(`/api/users/${id}/password`, { method:'POST', body: JSON.stringify({ password }) }); await renderUsers();
  }

  style();
  new MutationObserver(addNav).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(addNav, 1500);
  addNav();
})();
