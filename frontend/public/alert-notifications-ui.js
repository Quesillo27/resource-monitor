(() => {
  const API_BASE = `${location.protocol}//${location.hostname}:8080`;
  const seenIds = new Set();
  let latestAlerts = [];

  function token() {
    return localStorage.getItem('rm_token') || '';
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token()}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await originalFetch(...args);
    try {
      const raw = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (/\/api\/alerts(\?|$)/.test(raw) || /\/api\/agents\/[^/]+$/.test(raw)) {
        res.clone().json().then((data) => {
          if (Array.isArray(data.alerts)) latestAlerts = data.alerts;
          setTimeout(enhanceAlerts, 50);
        }).catch(() => {});
      }
    } catch {}
    return res;
  };

  function ensureStyle() {
    if (document.getElementById('rm-alert-notifications-style')) return;
    const style = document.createElement('style');
    style.id = 'rm-alert-notifications-style';
    style.textContent = `
      .rm-seen-btn{margin-left:auto;align-self:flex-start;border:1px solid #cbd8ea;background:#eef6ff;color:#0b55b7;border-radius:8px;padding:9px 12px;font-weight:700;cursor:pointer;white-space:nowrap}
      .rm-seen-btn:hover{background:#dcecff}
      .rm-alert-status{display:inline-flex;margin-top:8px;margin-right:8px;border:1px solid #dbe5f0;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:800;color:#42526a;background:#f8fafc}
      .rm-alert-status.active{color:#9a3412;background:#fff7ed;border-color:#fed7aa}
      .rm-alert-status.resolved{color:#166534;background:#f0fdf4;border-color:#bbf7d0}
      .rm-clear-alerts{border:1px solid #cbd8ea;background:#fff;color:#0b2442;border-radius:8px;padding:10px 13px;font-weight:700;cursor:pointer}
      .rm-clear-alerts:disabled{opacity:.55;cursor:not-allowed}
    `;
    document.head.appendChild(style);
  }

  function onAlertsPage() {
    return [...document.querySelectorAll('h1,h2')].some((h) => /alertas|pendientes de visto/i.test(h.textContent || ''));
  }

  function updateLabels() {
    document.querySelectorAll('.panel h2').forEach((h) => {
      if (/alertas web|ultimas alertas|últimas alertas/i.test(h.textContent || '')) h.textContent = 'Pendientes de visto';
    });
    document.querySelectorAll('.empty-panel').forEach((el) => {
      if (/sin alertas activas/i.test(el.textContent || '')) el.textContent = 'Sin notificaciones pendientes';
    });
  }

  function findAlertForCard(card) {
    const text = card.textContent || '';
    return latestAlerts.find((item) => !seenIds.has(item.id) && text.includes(item.message)) || null;
  }

  function addClearButton() {
    if (!onAlertsPage()) return;
    const panelHead = [...document.querySelectorAll('.panel-head')].find((head) => /pendientes de visto|alertas web/i.test(head.textContent || ''));
    if (!panelHead || panelHead.querySelector('.rm-clear-alerts')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rm-clear-alerts';
    btn.textContent = 'Limpiar todo';
    btn.disabled = latestAlerts.length === 0;
    btn.onclick = async () => {
      if (!latestAlerts.length || !window.confirm('Marcar todas las notificaciones pendientes como vistas?')) return;
      btn.disabled = true;
      btn.textContent = 'Limpiando...';
      try {
        await api('/api/alerts/seen-all', { method: 'POST', body: '{}' });
        latestAlerts.forEach((item) => seenIds.add(item.id));
        document.querySelectorAll('.alert-card').forEach((card) => card.remove());
        updateLabels();
        setTimeout(() => location.reload(), 250);
      } catch (err) {
        window.alert(err.message);
        btn.disabled = false;
        btn.textContent = 'Limpiar todo';
      }
    };
    const actions = panelHead.querySelector('.actions') || panelHead;
    actions.insertBefore(btn, actions.firstChild);
  }

  function enhanceAlerts() {
    ensureStyle();
    updateLabels();
    addClearButton();
    document.querySelectorAll('.alert-card').forEach((card) => {
      if (card.dataset.rmSeenReady === '1') return;
      const item = findAlertForCard(card);
      if (!item) return;
      card.dataset.rmSeenReady = '1';
      const body = card.querySelector('div') || card;
      const status = document.createElement('span');
      status.className = `rm-alert-status ${item.active ? 'active' : 'resolved'}`;
      status.textContent = item.active ? 'activa' : 'resuelta';
      body.appendChild(status);
      if (item.resolved_at) {
        const resolved = document.createElement('small');
        resolved.textContent = `Resuelta: ${new Date(item.resolved_at).toLocaleString()}`;
        body.appendChild(resolved);
      }
      if (!item.seen_at) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rm-seen-btn';
        btn.textContent = 'Visto';
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = 'Guardando...';
          try {
            await api(`/api/alerts/${item.id}/seen`, { method: 'POST', body: '{}' });
            seenIds.add(item.id);
            card.remove();
            updateLabels();
          } catch (err) {
            window.alert(err.message);
            btn.disabled = false;
            btn.textContent = 'Visto';
          }
        };
        card.appendChild(btn);
      }
    });
  }

  new MutationObserver(enhanceAlerts).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(enhanceAlerts, 1500);
  enhanceAlerts();
})();
