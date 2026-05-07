(() => {
  const css = `
    .rm-rule-check.telegram { color:#0e7490; }
    .rm-disk-rules th.rm-telegram-col, .rm-disk-rules td.rm-telegram-col { white-space:nowrap; }
  `;
  const metricNames = {
    'CPU': 'cpu',
    'RAM': 'ram',
    'Red recibida': 'network_recv_mbps',
    'Red enviada': 'network_sent_mbps',
  };
  const state = new Map();

  function style() {
    if (document.getElementById('rm-rules-telegram-style')) return;
    const el = document.createElement('style'); el.id = 'rm-rules-telegram-style'; el.textContent = css; document.head.appendChild(el);
  }
  function key(metric, resource, severity) { return `${metric}:${resource || ''}:${severity}`; }
  function installMetricControls() {
    document.querySelectorAll('.rm-rule-metric').forEach((card) => {
      const metric = metricNames[card.querySelector('h3')?.textContent?.trim() || ''];
      if (!metric) return;
      card.querySelectorAll('.rm-rule-severity').forEach((row) => {
        if (row.querySelector('[data-field="notify_telegram"]')) return;
        const severity = row.querySelector('strong')?.textContent?.trim().toLowerCase();
        const label = document.createElement('label');
        label.className = 'rm-rule-check telegram';
        label.innerHTML = '<input type="checkbox" data-field="notify_telegram"> Telegram';
        label.querySelector('input').addEventListener('change', (event) => state.set(key(metric, '', severity), event.target.checked));
        row.insertBefore(label, row.querySelector('label:nth-last-child(2)'));
      });
    });
  }
  function installDiskControls() {
    document.querySelectorAll('.rm-disk-rules table').forEach((table) => {
      if (table.dataset.rmTelegram === '1') return;
      table.dataset.rmTelegram = '1';
      const head = table.querySelector('thead tr');
      if (head) head.insertAdjacentHTML('beforeend', '<th class="rm-telegram-col">Telegram critical</th>');
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const resource = tr.querySelector('.rm-disk-key strong')?.textContent?.trim() || '';
        const td = document.createElement('td');
        td.className = 'rm-telegram-col';
        td.innerHTML = '<input type="checkbox" data-field="notify_telegram">';
        td.querySelector('input').addEventListener('change', (event) => state.set(key('disk_used_percent', resource === 'default' ? '' : resource, 'critical'), event.target.checked));
        tr.appendChild(td);
      });
    });
  }
  function enhance() { style(); installMetricControls(); installDiskControls(); }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'PUT' && /\/api\/agents\/[^/]+\/alert-rules$/.test(url) && init.body) {
      try {
        const payload = JSON.parse(init.body);
        if (Array.isArray(payload.rules)) {
          payload.rules = payload.rules.map((rule) => ({
            ...rule,
            notify_telegram: state.get(key(rule.metric, rule.resource_key || '', rule.severity)) ?? !!rule.notify_telegram,
          }));
          init = { ...init, body: JSON.stringify(payload) };
        }
      } catch {}
    }
    return originalFetch(input, init);
  };

  new MutationObserver(enhance).observe(document.documentElement, { childList:true, subtree:true });
  setInterval(enhance, 1000);
  enhance();
})();
