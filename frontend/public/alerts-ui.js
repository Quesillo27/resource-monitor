(() => {
  const API_BASE = ''; // proxied by nginx
  const css = `
    .rm-alert-center-title { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .rm-alert-center-title small { color:#64748b; font-size:12px; font-weight:700; }
    .alert-card { border:1px solid #e1e9f4 !important; border-left:4px solid #f59e0b !important; border-radius:8px !important; box-shadow:0 14px 34px rgba(15,23,42,.045); background:#fff; }
    .alert-card.critical { border-left-color:#dc2626 !important; }
    .alert-card.warning { border-left-color:#f59e0b !important; }
    .rm-alert-context { margin-top:12px; border-top:1px solid #e5edf7; padding-top:12px; }
    .rm-alert-facts { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
    .rm-alert-facts span { display:inline-flex; align-items:center; gap:5px; border:1px solid #dbe6f3; background:#f8fbff; border-radius:999px; padding:5px 9px; color:#334b68; font-size:12px; font-weight:800; }
    .rm-alert-channel.email { background:#eef6ff; border-color:#bfdbfe; color:#1d4ed8; }
    .rm-alert-channel.telegram { background:#ecfeff; border-color:#a5f3fc; color:#0e7490; }
    .rm-alert-channel.platform { background:#f8fafc; border-color:#e2e8f0; color:#475569; }
    .rm-alert-process-title { display:flex; justify-content:space-between; align-items:center; color:#061832; font-size:13px; font-weight:800; margin:8px 0; }
    .rm-alert-process-table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e1e9f4; border-radius:8px; overflow:hidden; font-size:12px; }
    .rm-alert-process-table th { text-align:left; background:#f5f8fc; color:#53657e; text-transform:uppercase; letter-spacing:.04em; padding:8px; border-bottom:1px solid #e5edf7; }
    .rm-alert-process-table td { padding:8px; border-bottom:1px solid #edf2f7; color:#061832; }
    .rm-alert-process-table tr:last-child td { border-bottom:0; }
    .rm-alert-empty-context { color:#6b7b92; font-size:12px; margin-top:8px; }
  `;

  function token() { return localStorage.getItem('rm_token') || ''; }
  async function api(path) {
    const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
    if (!res.ok) return null;
    return res.json();
  }
  function style() {
    if (document.getElementById('rm-alerts-style')) return;
    const el = document.createElement('style');
    el.id = 'rm-alerts-style';
    el.textContent = css;
    document.head.appendChild(el);
  }
  function pct(value) { return `${Number(value || 0).toFixed(1)}%`; }
  function val(value, unit) {
    if (value === null || value === undefined) return 'n/a';
    const n = Number(value || 0);
    return `${n.toFixed(unit === 'Mbps' ? 2 : 1)}${unit ? ` ${unit}` : ''}`;
  }
  function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }
  function processRows(processes) {
    if (!processes?.length) return '<p class="rm-alert-empty-context">Sin snapshot de procesos para esta alerta.</p>';
    return `
      <div class="rm-alert-process-title"><span>Top procesos capturados</span><small>${processes.length} procesos</small></div>
      <table class="rm-alert-process-table">
        <thead><tr><th>Proceso</th><th>PID</th><th>CPU</th><th>RAM</th></tr></thead>
        <tbody>${processes.slice(0,5).map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.pid}</td><td>${pct(p.cpu_percent)}</td><td>${pct(p.memory_percent)}</td></tr>`).join('')}</tbody>
      </table>`;
  }
  function channels(alert) {
    const out = ['<span class="rm-alert-channel platform">Plataforma</span>'];
    if (alert.notify_email) out.push(`<span class="rm-alert-channel email">Email ${alert.notification_count || 0}</span>`);
    if (alert.notify_telegram) out.push(`<span class="rm-alert-channel telegram">Telegram ${alert.telegram_notification_count || 0}</span>`);
    return out.join('');
  }
  function alertHtml(alert) {
    const unit = (alert.unit || '').trim();
    return `
      <div class="rm-alert-context">
        <div class="rm-alert-facts">
          <span>Valor ${val(alert.observed_value, unit)}</span>
          <span>Umbral ${val(alert.threshold_value, unit)}</span>
          <span>${alert.duration_samples || 'n/a'} muestras</span>
          <span>${escapeHtml(alert.resource_key || 'general')}</span>
          ${channels(alert)}
        </div>
        ${processRows(alert.process_snapshot || [])}
      </div>`;
  }
  function labelDashboard() {
    [...document.querySelectorAll('h2,h3,strong')].forEach((el) => {
      if (/ultimas alertas|últimas alertas/i.test(el.textContent || '')) {
        el.innerHTML = '<span class="rm-alert-center-title"><span>Centro de alertas</span><small>causa, canal y contexto</small></span>';
      }
    });
  }
  async function enhance() {
    style(); labelDashboard();
    const cards = [...document.querySelectorAll('.alert-card')].filter((card) => !card.dataset.rmAlertEnhanced);
    if (!cards.length) return;
    const data = await api('/api/alerts');
    const alerts = data?.alerts || [];
    cards.forEach((card) => {
      const message = card.querySelector('strong')?.textContent?.trim();
      const alert = alerts.find((item) => item.message === message);
      if (!alert) return;
      card.dataset.rmAlertEnhanced = '1';
      card.classList.add(alert.severity || 'warning');
      card.insertAdjacentHTML('beforeend', alertHtml(alert));
    });
  }
  new MutationObserver(enhance).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(enhance, 3000);
  enhance();
})();
