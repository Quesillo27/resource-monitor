(() => {
  const css = `
    .rm-rules-card {
      padding: 18px;
      border-color: #d8e4f2;
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.07);
    }
    .rm-rules-card > div:first-child {
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 16px;
    }
    .rm-rules-card h2 {
      margin-bottom: 4px;
      letter-spacing: 0;
    }
    .rm-rule-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .rm-rule-grid {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(420px, 1fr)) !important;
      gap: 14px !important;
      align-items: stretch;
    }
    .rm-rule-metric {
      display: grid;
      gap: 12px;
      padding: 14px !important;
      border: 1px solid #dce7f4 !important;
      border-radius: 8px !important;
      background: linear-gradient(180deg, #ffffff 0%, #fbfdff 100%);
      min-width: 0;
    }
    .rm-rule-metric h3 {
      margin: 0 !important;
      padding-bottom: 10px;
      border-bottom: 1px solid #e8eef6;
      font-size: 15px !important;
      font-weight: 800;
      color: #071936;
    }
    .rm-rule-severity {
      display: grid !important;
      grid-template-columns: 92px minmax(110px, 140px) minmax(92px, 112px) minmax(96px, 116px) max-content max-content max-content !important;
      gap: 10px !important;
      align-items: end !important;
      padding: 12px !important;
      border: 1px solid #e2ebf6 !important;
      border-radius: 8px;
      background: #fff;
    }
    .rm-rule-severity + .rm-rule-severity {
      margin-top: 0 !important;
    }
    .rm-rule-severity strong {
      align-self: center;
      justify-self: start;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid #dbe6f3;
      background: #f8fbff;
      color: #42526b !important;
      font-size: 11px !important;
      line-height: 1;
      letter-spacing: .04em;
    }
    .rm-rule-severity label {
      min-width: 0;
      color: #42526b;
      font-size: 12px;
      font-weight: 700;
    }
    .rm-rule-severity label:nth-of-type(1) { grid-column: 2; }
    .rm-rule-severity label:nth-of-type(5) { grid-column: 3; }
    .rm-rule-severity label:nth-of-type(6) { grid-column: 4; }
    .rm-rule-severity input[type="number"] {
      width: 100% !important;
      min-height: 36px;
      margin-top: 5px;
      padding: 7px 10px;
      border-radius: 7px;
      border: 1px solid #cbd9ea;
      background: #fff;
      font-size: 13px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #071936;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    .rm-rule-severity input[type="number"]:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
    }
    .rm-rule-check {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 7px !important;
      min-height: 36px;
      min-width: 88px;
      padding: 7px 10px !important;
      border: 1px solid #dbe6f3;
      border-radius: 999px;
      background: #f8fbff;
      color: #40516b !important;
      font-size: 12px !important;
      font-weight: 800 !important;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease;
    }
    .rm-rule-check:hover {
      border-color: #b8cbe4;
      background: #f2f7fd;
    }
    .rm-rule-check input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: #2563eb;
    }
    .rm-rule-check:has(input:checked) {
      border-color: #b8d4ff;
      background: #eff6ff;
      color: #0b55b7 !important;
      box-shadow: inset 0 0 0 1px rgba(37, 99, 235, .08);
    }
    .rm-rule-check.telegram {
      color: #0e7490 !important;
    }
    .rm-rule-check.telegram:has(input:checked) {
      border-color: #99f6e4;
      background: #ecfeff;
      color: #0f766e !important;
      box-shadow: inset 0 0 0 1px rgba(20, 184, 166, .12);
    }
    .rm-disk-rules {
      margin-top: 16px !important;
      overflow-x: auto;
      border: 1px solid #dce7f4;
      border-radius: 8px;
      background: #fff;
    }
    .rm-disk-rules table {
      min-width: 980px;
      border-collapse: separate !important;
      border-spacing: 0;
    }
    .rm-disk-rules th {
      position: sticky;
      top: 0;
      z-index: 1;
      padding: 10px 12px !important;
      background: #f4f7fb !important;
      color: #4c5d75 !important;
      font-size: 11px !important;
      letter-spacing: .04em;
      text-align: left;
      border-bottom: 1px solid #dfe8f3;
      white-space: nowrap;
    }
    .rm-disk-rules td {
      padding: 10px 12px !important;
      vertical-align: middle;
      border-bottom: 1px solid #eef3f8;
      font-size: 13px;
    }
    .rm-disk-rules tbody tr:hover td {
      background: #f9fbfe;
    }
    .rm-disk-rules tbody tr:last-child td {
      border-bottom: 0;
    }
    .rm-disk-rules th:nth-child(n+3),
    .rm-disk-rules td:nth-child(n+3),
    .rm-disk-rules th.rm-telegram-col,
    .rm-disk-rules td.rm-telegram-col {
      text-align: center;
      white-space: nowrap;
    }
    .rm-disk-key strong {
      display: block;
      font-size: 13px;
      color: #071936;
    }
    .rm-disk-key span {
      color: #66758c !important;
      font-size: 11px !important;
    }
    .rm-usage-pill {
      display: inline-flex !important;
      min-width: 58px;
      justify-content: center;
      padding: 5px 9px !important;
      border-radius: 999px;
      background: #eaf3ff !important;
      color: #1259b5 !important;
      font-size: 12px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .rm-disk-rules input[type="number"] {
      width: 86px !important;
      min-height: 34px;
      padding: 6px 9px;
      border: 1px solid #cbd9ea;
      border-radius: 7px;
      background: #fff;
      font-weight: 700;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    .rm-disk-rules input[type="checkbox"] {
      width: 15px;
      height: 15px;
      accent-color: #2563eb;
    }
    .rm-disk-rules th.rm-telegram-col,
    .rm-disk-rules td.rm-telegram-col {
      color: #0e7490;
    }
    .rm-rule-help {
      display: grid !important;
      grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
      gap: 10px !important;
      margin-top: 12px !important;
    }
    .rm-rule-help > div {
      padding: 10px 12px !important;
      border: 1px solid #e0e9f5 !important;
      border-radius: 8px !important;
      background: #fbfdff !important;
    }
    .rm-rule-help strong {
      display: block;
      margin-bottom: 3px;
      color: #31415b;
      font-size: 12px;
    }
    .rm-rule-help p {
      margin: 0;
      color: #66758c;
      font-size: 11px;
      line-height: 1.35;
    }
    @media (max-width: 1440px) {
      .rm-rule-grid { grid-template-columns: 1fr !important; }
    }
    @media (max-width: 1120px) {
      .rm-rule-severity {
        grid-template-columns: 88px repeat(3, minmax(92px, 1fr)) !important;
        align-items: end !important;
      }
      .rm-rule-severity label:nth-of-type(1) { grid-column: 2; }
      .rm-rule-severity label:nth-of-type(5) { grid-column: 3; }
      .rm-rule-severity label:nth-of-type(6) { grid-column: 4; }
      .rm-rule-severity label.rm-rule-check:nth-of-type(2) { grid-column: 2; grid-row: 2; }
      .rm-rule-severity label.rm-rule-check:nth-of-type(3) { grid-column: 3; grid-row: 2; }
      .rm-rule-severity label.rm-rule-check.telegram { grid-column: 4; grid-row: 2; }
      .rm-rule-check { width: 100%; }
      .rm-rule-help { grid-template-columns: 1fr !important; }
    }
    @media (max-width: 720px) {
      .rm-rules-card { padding: 14px; }
      .rm-rules-card > div:first-child { display: block !important; }
      .rm-rule-actions { justify-content: stretch; margin-top: 12px; }
      .rm-rule-actions .btn { flex: 1 1 auto; }
      .rm-rule-grid { grid-template-columns: 1fr !important; }
      .rm-rule-severity {
        grid-template-columns: 1fr !important;
        gap: 8px !important;
      }
      .rm-rule-severity strong,
      .rm-rule-severity label,
      .rm-rule-severity label:nth-of-type(1),
      .rm-rule-severity label:nth-of-type(5),
      .rm-rule-severity label:nth-of-type(6),
      .rm-rule-severity label.rm-rule-check:nth-of-type(2),
      .rm-rule-severity label.rm-rule-check:nth-of-type(3),
      .rm-rule-severity label.rm-rule-check.telegram {
        grid-column: 1 !important;
        grid-row: auto !important;
        width: 100%;
      }
      .rm-rule-check { justify-content: flex-start !important; }
      .rm-disk-rules table { min-width: 760px; }
    }
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
