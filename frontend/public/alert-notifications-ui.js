(() => {
  const API_BASE = ''; // proxied by nginx
  const seenIds = new Set();
  let latestAlerts = [];

  function token(){ return localStorage.getItem('rm_token') || ''; }
  async function api(path, options={}){
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token()}`, ...(options.headers||{}) } });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  function ensureStyle(){
    if(document.getElementById('rm-alert-notifications-style')) return;
    const style=document.createElement('style');
    style.id='rm-alert-notifications-style';
    style.textContent=`
      .alert-list{display:grid!important;gap:12px!important}.alert-card{align-items:flex-start!important;border-left:4px solid #dfe6ef!important;padding:16px!important}.alert-card.warning{border-left-color:#d18a00!important}.alert-card.critical{border-left-color:#c6283d!important}.alert-card>svg{background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;box-sizing:content-box;padding:8px;flex:0 0 auto}.alert-card>div{min-width:0!important}.alert-card strong{display:block;max-width:900px}.rm-alert-top{display:flex;gap:12px;justify-content:space-between;align-items:flex-start}.rm-seen-btn{margin-left:auto;align-self:flex-start;border:1px solid #cbd8ea;background:#eef6ff;color:#0b55b7;border-radius:8px;padding:9px 12px;font-weight:700;cursor:pointer;white-space:nowrap}.rm-seen-btn:hover{background:#dcecff}.rm-alert-meta{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.rm-alert-meta span{display:inline-flex!important;margin:0!important;border:1px solid #dfe8f3;background:#f6f9fc;border-radius:999px;color:#32445b!important;font-size:12px!important;font-weight:700;padding:5px 9px}.rm-alert-status.active{color:#9a3412!important;background:#fff7ed!important;border-color:#fed7aa!important}.rm-alert-status.resolved{color:#166534!important;background:#f0fdf4!important;border-color:#bbf7d0!important}.rm-clear-alerts{border:1px solid #cbd8ea;background:#fff;color:#0b2442;border-radius:8px;padding:10px 13px;font-weight:700;cursor:pointer}.rm-clear-alerts:disabled{opacity:.55;cursor:not-allowed}.rm-alert-processes{border-top:1px solid #edf2f7;margin-top:12px;padding-top:12px}.rm-alert-processes header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.rm-alert-processes header strong{font-size:12px}.rm-alert-processes header span{margin:0!important;color:#66758a!important;font-size:12px!important}.rm-alert-processes table{width:100%;min-width:0;border-collapse:separate;border-spacing:0}.rm-alert-processes th,.rm-alert-processes td{font-size:12px;padding:8px 10px;border-bottom:1px solid #edf2f7;text-align:left}.rm-alert-processes th{background:#f8fafc;color:#53657e;text-transform:uppercase;letter-spacing:.04em}.rm-alert-processes td:nth-child(n+2),.rm-alert-processes th:nth-child(n+2){text-align:right;font-variant-numeric:tabular-nums}@media(max-width:900px){.rm-alert-top{flex-direction:column}.rm-seen-btn{margin-left:0}.alert-card{display:grid!important}}
    `;
    document.head.appendChild(style);
  }
  function onAlertsPage(){ return [...document.querySelectorAll('h1,h2')].some(h=>/alertas|pendientes de visto/i.test(h.textContent||'')); }
  function hideAlertsSMTP(){
    const title=[...document.querySelectorAll('h1')].find(h=>/^\s*alertas\s*$/i.test(h.textContent||''));
    if(!title) return;
    const row=title.closest('section')?.querySelector('.tab-row');
    if(!row) return;
    const buttons=[...row.querySelectorAll('button')];
    const first=buttons.find(btn=>!/smtp/i.test(btn.textContent||''));
    const smtp=buttons.find(btn=>/smtp/i.test(btn.textContent||''));
    if(smtp){
      if(smtp.classList.contains('selected') && first) setTimeout(()=>first.click(),0);
      smtp.remove();
    }
    const smtpPanel=[...document.querySelectorAll('.panel')].find(panel=>/configuracion smtp|configuración smtp/i.test(panel.textContent||''));
    if(smtpPanel && first){ setTimeout(()=>first.click(),0); }
  }
  function updateLabels(){
    hideAlertsSMTP();
    document.querySelectorAll('.panel h2').forEach(h=>{ if(/alertas web|ultimas alertas|últimas alertas/i.test(h.textContent||'')) h.textContent='Pendientes de visto'; });
    document.querySelectorAll('.empty-panel').forEach(el=>{ if(/sin alertas activas/i.test(el.textContent||'')) el.textContent='Sin notificaciones pendientes'; });
    document.querySelectorAll('.tab-row button').forEach(btn=>{ if(/alertas activas/i.test(btn.textContent||'')) btn.textContent='Pendientes de visto'; });
  }
  function findAlert(card){ const text=card.textContent||''; return latestAlerts.find(item=>!seenIds.has(item.id) && text.includes(item.message)) || null; }
  function fmt(value, unit=''){ if(value === null || value === undefined) return 'n/a'; return `${Number(value).toFixed(1)}${unit||''}`; }
  function procs(item){ return Array.isArray(item.process_snapshot) ? item.process_snapshot.slice(0,6) : []; }
  function processTable(item){
    const rows=procs(item);
    if(!rows.length) return '';
    return `<div class="rm-alert-processes"><header><strong>Top procesos capturados</strong><span>${rows.length} procesos</span></header><table><thead><tr><th>Proceso</th><th>PID</th><th>CPU</th><th>RAM</th></tr></thead><tbody>${rows.map(p=>`<tr><td>${escapeHtml(p.name||'n/a')}</td><td>${p.pid ?? ''}</td><td>${fmt(p.cpu_percent,'%')}</td><td>${fmt(p.memory_percent,'%')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function escapeHtml(v){ return String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function addClearButton(){
    if(!onAlertsPage()) return;
    const panelHead=[...document.querySelectorAll('.panel-head')].find(head=>/pendientes de visto|alertas web/i.test(head.textContent||''));
    if(!panelHead || panelHead.querySelector('.rm-clear-alerts')) return;
    const btn=document.createElement('button'); btn.type='button'; btn.className='rm-clear-alerts'; btn.textContent='Limpiar todo'; btn.disabled=latestAlerts.length===0;
    btn.onclick=async()=>{ if(!latestAlerts.length || !window.confirm('Marcar todas las notificaciones pendientes como vistas?')) return; btn.disabled=true; btn.textContent='Limpiando...'; try{ await api('/api/alerts/seen-all',{method:'POST',body:'{}'}); latestAlerts.forEach(item=>seenIds.add(item.id)); document.querySelectorAll('.alert-card').forEach(card=>card.remove()); updateLabels(); setTimeout(()=>location.reload(),250); }catch(err){ window.alert(err.message); btn.disabled=false; btn.textContent='Limpiar todo'; } };
    const actions=panelHead.querySelector('.actions') || panelHead; actions.insertBefore(btn, actions.firstChild);
  }
  function enhanceAlerts(){
    ensureStyle(); updateLabels(); addClearButton();
    document.querySelectorAll('.alert-card').forEach(card=>{
      if(card.dataset.rmSeenReady==='1') return;
      const item=findAlert(card); if(!item) return;
      card.dataset.rmSeenReady='1';
      const body=card.querySelector('div') || card;
      const strong=body.querySelector('strong');
      if(strong && !body.querySelector('.rm-alert-top')){
        const top=document.createElement('div'); top.className='rm-alert-top';
        const title=document.createElement('div');
        title.appendChild(strong.cloneNode(true));
        const subtitle=body.querySelector('span'); if(subtitle) title.appendChild(subtitle.cloneNode(true));
        top.appendChild(title); body.innerHTML=''; body.appendChild(top);
      }
      const top=body.querySelector('.rm-alert-top') || body;
      const meta=document.createElement('div'); meta.className='rm-alert-meta';
      meta.innerHTML=`<span>Valor ${fmt(item.observed_value,item.unit)}</span><span>Umbral ${fmt(item.threshold_value,item.unit)}</span><span>${item.duration_samples||1} muestras</span><span>${escapeHtml(item.resource_key||'general')}</span><span class="rm-alert-status ${item.active?'active':'resolved'}">${item.active?'activa':'resuelta'}</span><span>${item.notify_email ? `Email ${item.notification_count||0}` : 'Plataforma'}</span>${item.notify_telegram ? `<span>Telegram ${item.telegram_notification_count||0}</span>` : ''}`;
      body.appendChild(meta);
      if(item.resolved_at){ const resolved=document.createElement('small'); resolved.textContent=`Resuelta: ${new Date(item.resolved_at).toLocaleString()}`; body.appendChild(resolved); }
      body.insertAdjacentHTML('beforeend', processTable(item));
      if(!item.seen_at){ const btn=document.createElement('button'); btn.type='button'; btn.className='rm-seen-btn'; btn.textContent='Visto'; btn.onclick=async()=>{ btn.disabled=true; btn.textContent='Guardando...'; try{ await api(`/api/alerts/${item.id}/seen`,{method:'POST',body:'{}'}); seenIds.add(item.id); card.remove(); updateLabels(); }catch(err){ window.alert(err.message); btn.disabled=false; btn.textContent='Visto'; } }; top.appendChild(btn); }
    });
  }
  const originalFetch=window.fetch.bind(window);
  window.fetch=async(...args)=>{ const res=await originalFetch(...args); try{ const raw=typeof args[0]==='string'?args[0]:args[0]?.url||''; if(/\/api\/alerts(\?|$)/.test(raw) || /\/api\/agents\/[^/]+$/.test(raw)){ res.clone().json().then(data=>{ if(Array.isArray(data.alerts)) latestAlerts=data.alerts; setTimeout(enhanceAlerts,50); }).catch(()=>{}); } }catch{} return res; };
  new MutationObserver(enhanceAlerts).observe(document.documentElement,{childList:true,subtree:true});
  setInterval(enhanceAlerts,1500); enhanceAlerts();
})();
