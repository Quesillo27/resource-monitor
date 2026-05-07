(() => {
  const API_BASE = `${location.protocol}//${location.hostname}:8080`;
  const css = `
    .rm-settings-nav { margin-top:8px; display:flex; align-items:center; gap:12px; width:100%; border:0; background:transparent; color:#dbeafe; padding:12px 16px; border-radius:8px; font:inherit; cursor:pointer; text-align:left; }
    .rm-settings-nav:hover,.rm-settings-nav.active { background:#24364a; color:#fff; }
    .rm-settings-backdrop { position:fixed; inset:0; background:rgba(15,23,42,.28); z-index:1000; display:none; }
    .rm-settings-backdrop.open { display:block; }
    .rm-settings-drawer { position:fixed; top:0; right:0; width:min(1120px, calc(100vw - 28px)); height:100vh; background:#f3f6fb; border-left:1px solid #dbe5f0; box-shadow:-18px 0 44px rgba(15,23,42,.18); z-index:1001; transform:translateX(105%); transition:transform .18s ease; overflow:auto; }
    .rm-settings-drawer.open { transform:translateX(0); }
    .rm-settings { padding:30px; color:#061832; }
    .rm-settings-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:20px; }
    .rm-settings h1 { margin:0; font-size:30px; letter-spacing:0; }
    .rm-settings h2 { margin:0 0 16px; font-size:19px; }
    .rm-settings p { color:#53657e; margin:6px 0 0; }
    .rm-tabs { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
    .rm-tab { border:1px solid #cbd8ea; background:#fff; color:#0b2442; border-radius:8px; padding:10px 14px; cursor:pointer; font-weight:650; }
    .rm-tab.active { border-color:#2563eb; color:#0b55b7; background:#eff6ff; }
    .rm-panel { background:#fff; border:1px solid #dbe5f0; border-radius:8px; box-shadow:0 16px 36px rgba(15,23,42,.05); padding:22px; }
    .rm-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
    .rm-field label { display:block; color:#40536f; font-size:13px; font-weight:800; margin-bottom:7px; }
    .rm-field input,.rm-field select,.rm-field textarea { width:100%; box-sizing:border-box; border:1px solid #cbd8ea; border-radius:8px; padding:12px; font:inherit; background:#fff; }
    .rm-field textarea { min-height:82px; resize:vertical; }
    .rm-check { display:flex; align-items:center; gap:10px; color:#40536f; font-weight:800; }
    .rm-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:18px; flex-wrap:wrap; }
    .rm-btn { border:1px solid #cbd8ea; background:#fff; color:#0b2442; border-radius:8px; padding:11px 14px; cursor:pointer; font-weight:700; }
    .rm-btn.primary { background:#2563eb; color:#fff; border-color:#2563eb; }
    .rm-btn.danger { color:#b91c1c; border-color:#fecaca; background:#fff7f7; }
    .rm-msg { margin-top:12px; color:#53657e; font-weight:700; }
    .rm-msg.err { color:#b91c1c; }
    .rm-table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border:1px solid #e1e9f4; border-radius:8px; }
    .rm-table th { background:#f6f8fb; color:#53657e; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:.04em; padding:12px; }
    .rm-table td { padding:12px; border-top:1px solid #edf2f7; vertical-align:middle; }
    .rm-role { border:1px solid #dbe5f0; border-radius:999px; padding:4px 8px; color:#334b68; font-size:12px; font-weight:800; }
    .rm-denied { background:#fff; border:1px solid #dbe5f0; border-radius:8px; padding:24px; color:#53657e; }
    .rm-inline-form { display:grid; grid-template-columns:1.2fr 150px 120px auto; gap:10px; align-items:end; padding:12px; background:#f8fbff; border:1px solid #e1e9f4; border-radius:8px; margin-bottom:14px; }
    .rm-modal { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(15,23,42,.35); z-index:1002; padding:20px; }
    .rm-modal.open { display:flex; }
    .rm-modal-card { width:min(560px,100%); background:#fff; border:1px solid #dbe5f0; border-radius:8px; box-shadow:0 18px 48px rgba(15,23,42,.22); padding:20px; }
    @media (max-width:900px){ .rm-grid,.rm-inline-form{grid-template-columns:1fr;} .rm-settings{padding:20px;} }
  `;

  let activeTab = 'smtp';
  let usersCache = [];

  function token() { return localStorage.getItem('rm_token') || ''; }
  function decodeRole() { try { return JSON.parse(atob(token().split('.')[1] || '')).role || 'viewer'; } catch { return 'viewer'; } }
  function headers() { return { Authorization: `Bearer ${token()}`, 'Content-Type':'application/json' }; }
  async function api(path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function escapeAttr(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function input(id, label, value='', type='text') { return `<div class="rm-field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${escapeAttr(value)}"></div>`; }
  function style() { if (document.getElementById('rm-settings-safe-style')) return; const el=document.createElement('style'); el.id='rm-settings-safe-style'; el.textContent=css; document.head.appendChild(el); }

  function ensureShell() {
    style();
    if (!document.getElementById('rm-settings-backdrop')) {
      document.body.insertAdjacentHTML('beforeend', '<div id="rm-settings-backdrop" class="rm-settings-backdrop"></div><aside id="rm-settings-drawer" class="rm-settings-drawer"></aside><div id="rm-settings-modal" class="rm-modal"></div>');
      document.getElementById('rm-settings-backdrop').onclick = closeSettings;
    }
  }
  function addNav() {
    if (document.querySelector('.rm-settings-nav')) return;
    const aside = document.querySelector('aside') || document.querySelector('[class*=sidebar]') || document.querySelector('#root nav');
    if (!aside) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rm-settings-nav';
    btn.innerHTML = '<span>⚙</span><span>Configuración</span>';
    btn.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openSettings('smtp'); };
    const logout = [...aside.querySelectorAll('button,a')].find(el => /salir/i.test(el.textContent || ''));
    if (logout?.parentNode) logout.parentNode.insertBefore(btn, logout); else aside.appendChild(btn);
    [...aside.querySelectorAll('nav button')].forEach((navBtn) => navBtn.addEventListener('click', closeSettings));
  }
  function openSettings(tab='smtp') { activeTab = tab; ensureShell(); document.getElementById('rm-settings-backdrop').classList.add('open'); document.getElementById('rm-settings-drawer').classList.add('open'); render(); }
  function closeSettings() { document.getElementById('rm-settings-backdrop')?.classList.remove('open'); document.getElementById('rm-settings-drawer')?.classList.remove('open'); document.querySelectorAll('.rm-settings-nav').forEach(el => el.classList.remove('active')); }
  function tabButton(id, label) { return `<button class="rm-tab ${activeTab===id?'active':''}" data-tab="${id}">${label}</button>`; }
  async function render() {
    const drawer = document.getElementById('rm-settings-drawer');
    const role = decodeRole();
    document.querySelectorAll('.rm-settings-nav').forEach(el => el.classList.add('active'));
    drawer.innerHTML = `<section class="rm-settings"><div class="rm-settings-head"><div><h1>Configuración</h1><p>Canales de notificación, usuarios y seguridad de la consola.</p></div><button class="rm-btn" id="rm_close">Cerrar</button></div>${role !== 'admin' ? '<div class="rm-denied">Tu rol no permite modificar configuración global.</div>' : `<div class="rm-tabs">${tabButton('smtp','SMTP')}${tabButton('telegram','Telegram')}${tabButton('users','Usuarios')}</div><div id="rm_panel" class="rm-panel">Cargando...</div>`}</section>`;
    document.getElementById('rm_close').onclick = closeSettings;
    if (role !== 'admin') return;
    document.querySelectorAll('.rm-tab').forEach(btn => btn.onclick = () => { activeTab = btn.dataset.tab; render(); });
    if (activeTab === 'smtp') await renderSMTP();
    if (activeTab === 'telegram') await renderTelegram();
    if (activeTab === 'users') await renderUsers();
  }
  function panel() { return document.getElementById('rm_panel'); }

  async function renderSMTP() {
    const cfg = await api('/api/settings/smtp');
    panel().innerHTML = `<h2>SMTP</h2><div class="rm-grid"><label class="rm-check"><input id="smtp_enabled" type="checkbox" ${cfg.enabled?'checked':''}> Habilitar correos</label><div></div>${input('smtp_host','Host',cfg.host)}${input('smtp_port','Puerto',cfg.port || 25,'number')}${input('smtp_user','Usuario',cfg.username)}${input('smtp_from','Remitente',cfg.from_address)}${input('smtp_pass','Contraseña','', 'password')}<div class="rm-field"><label>Destinatarios</label><textarea id="smtp_to">${escapeAttr(cfg.to_addresses)}</textarea></div>${input('smtp_cooldown','Cooldown minutos',cfg.cooldown_minutes || 30,'number')}<div><label class="rm-check"><input id="smtp_tls" type="checkbox" ${cfg.use_tls?'checked':''}> TLS directo</label><br><label class="rm-check"><input id="smtp_starttls" type="checkbox" ${cfg.use_starttls?'checked':''}> STARTTLS</label></div></div><div class="rm-actions"><button id="smtp_test" class="rm-btn">Probar</button><button id="smtp_save" class="rm-btn primary">Guardar SMTP</button></div><div id="smtp_msg" class="rm-msg"></div>`;
    smtp_save.onclick = () => saveSMTP(false); smtp_test.onclick = () => saveSMTP(true);
  }
  function smtpPayload() { return { enabled:smtp_enabled.checked, host:smtp_host.value, port:Number(smtp_port.value || 25), username:smtp_user.value, password:smtp_pass.value, from_address:smtp_from.value, to_addresses:smtp_to.value, cooldown_minutes:Number(smtp_cooldown.value || 30), use_tls:smtp_tls.checked, use_starttls:smtp_starttls.checked }; }
  async function saveSMTP(test) { const msg=smtp_msg; try { await api(test?'/api/settings/smtp/test':'/api/settings/smtp', { method:test?'POST':'PUT', body:JSON.stringify(smtpPayload()) }); msg.className='rm-msg'; msg.textContent=test?'Prueba enviada.':'SMTP guardado.'; } catch(e){ msg.className='rm-msg err'; msg.textContent=e.message; } }

  async function renderTelegram() {
    const cfg = await api('/api/settings/telegram');
    panel().innerHTML = `<h2>Telegram</h2><div class="rm-grid"><label class="rm-check"><input id="tg_enabled" type="checkbox" ${cfg.enabled?'checked':''}> Habilitar Telegram</label><div></div>${input('tg_token','Bot token','', 'password')}${input('tg_parse','Parse mode',cfg.parse_mode || 'HTML')}<div class="rm-field"><label>Chat IDs</label><textarea id="tg_chats">${escapeAttr(cfg.chat_ids)}</textarea></div>${input('tg_cooldown','Cooldown minutos',cfg.cooldown_minutes || 30,'number')}</div><div class="rm-actions"><button id="tg_test" class="rm-btn">Probar</button><button id="tg_save" class="rm-btn primary">Guardar Telegram</button></div><div id="tg_msg" class="rm-msg"></div>`;
    tg_save.onclick = () => saveTelegram(false); tg_test.onclick = () => saveTelegram(true);
  }
  function tgPayload() { return { enabled:tg_enabled.checked, bot_token:tg_token.value, chat_ids:tg_chats.value, parse_mode:tg_parse.value || 'HTML', cooldown_minutes:Number(tg_cooldown.value || 30) }; }
  async function saveTelegram(test) { const msg=tg_msg; try { await api(test?'/api/settings/telegram/test':'/api/settings/telegram', { method:test?'POST':'PUT', body:JSON.stringify(tgPayload()) }); msg.className='rm-msg'; msg.textContent=test?'Prueba enviada.':'Telegram guardado.'; } catch(e){ msg.className='rm-msg err'; msg.textContent=e.message; } }

  async function renderUsers() {
    const data = await api('/api/users'); usersCache = data.users || [];
    const rows = usersCache.map(u => `<tr><td>${escapeAttr(u.username)}</td><td><span class="rm-role">${u.role}</span></td><td>${u.active?'Activo':'Inactivo'}</td><td><button class="rm-btn" data-edit="${u.id}">Editar</button> <button class="rm-btn" data-pass="${u.id}">Contraseña</button><button class="rm-btn" disabled title="Backend DELETE pendiente">Borrar</button></td></tr>`).join('');
    panel().innerHTML = `<h2>Usuarios</h2><div class="rm-inline-form">${input('new_user','Usuario')}${input('new_pass','Contraseña','', 'password')}<div class="rm-field"><label>Rol</label><select id="new_role"><option value="admin">admin</option><option value="operator">operator</option><option value="viewer">viewer</option></select></div><label class="rm-check"><input id="new_active" type="checkbox" checked> Activo</label></div><div class="rm-actions"><button id="create_user" class="rm-btn primary">Crear usuario</button></div><div id="users_msg" class="rm-msg"></div><br><table class="rm-table"><thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${rows}</tbody></table>`;
    create_user.onclick = createUser;
    document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => editUser(usersCache.find(u => u.id === btn.dataset.edit)));
    document.querySelectorAll('[data-pass]').forEach(btn => btn.onclick = () => changePassword(btn.dataset.pass));
  }
  async function createUser() { const msg=users_msg; try { await api('/api/users', { method:'POST', body:JSON.stringify({ username:new_user.value, password:new_pass.value, role:new_role.value, active:new_active.checked }) }); msg.className='rm-msg'; msg.textContent='Usuario creado.'; await renderUsers(); } catch(e){ msg.className='rm-msg err'; msg.textContent=e.message; } }
  function showModal(html) { const modal=document.getElementById('rm-settings-modal'); modal.innerHTML=`<div class="rm-modal-card">${html}</div>`; modal.classList.add('open'); modal.onclick=(e)=>{ if(e.target===modal) closeModal(); }; }
  function closeModal() { const modal=document.getElementById('rm-settings-modal'); modal.classList.remove('open'); modal.innerHTML=''; }
  function editUser(user) {
    showModal(`<h2>Editar usuario</h2><div class="rm-grid">${input('edit_user','Usuario',user.username)}<div class="rm-field"><label>Rol</label><select id="edit_role"><option value="admin">admin</option><option value="operator">operator</option><option value="viewer">viewer</option></select></div><label class="rm-check"><input id="edit_active" type="checkbox" ${user.active?'checked':''}> Activo</label></div><div class="rm-actions"><button class="rm-btn" id="edit_cancel">Cancelar</button><button class="rm-btn primary" id="edit_save">Guardar</button></div><div id="edit_msg" class="rm-msg"></div>`);
    edit_role.value = user.role; edit_cancel.onclick = closeModal;
    edit_save.onclick = async () => { try { await api(`/api/users/${user.id}`, { method:'PATCH', body:JSON.stringify({ username:edit_user.value, role:edit_role.value, active:edit_active.checked }) }); closeModal(); await renderUsers(); } catch(e){ edit_msg.className='rm-msg err'; edit_msg.textContent=e.message; } };
  }
  function changePassword(id) {
    showModal(`<h2>Cambiar contraseña</h2>${input('pass_new','Nueva contraseña','', 'password')}<div class="rm-actions"><button class="rm-btn" id="pass_cancel">Cancelar</button><button class="rm-btn primary" id="pass_save">Guardar contraseña</button></div><div id="pass_msg" class="rm-msg"></div>`);
    pass_cancel.onclick = closeModal;
    pass_save.onclick = async () => { try { await api(`/api/users/${id}/password`, { method:'POST', body:JSON.stringify({ password:pass_new.value }) }); closeModal(); await renderUsers(); } catch(e){ pass_msg.className='rm-msg err'; pass_msg.textContent=e.message; } };
  }

  ensureShell();
  new MutationObserver(addNav).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(addNav, 1000);
  addNav();
})();
