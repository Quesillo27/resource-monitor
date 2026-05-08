(() => {
  const API_BASE = ''; // proxied by nginx
  const STATE = {
    agentId: '',
    agentName: '',
    installed: false,
    loading: false,
    nativeNodes: [],
  };

  const css = `
    .rm-rules-panel { margin-top: 16px; }
    .rm-rules-card { background: #fff; border: 1px solid #d9e2ef; border-radius: 8px; box-shadow: 0 16px 36px rgba(15, 23, 42, .06); padding: 18px; }
    .rm-rules-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:16px; }
    .rm-rules-head h2 { margin:0; font-size:18px; color:#061832; }
    .rm-rules-head p { margin:4px 0 0; color:#53657e; font-size:13px; }
    .rm-rules-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .rm-rules-actions button, .rm-rule-btn { border:1px solid #cbd8ea; border-radius:8px; background:#fff; color:#08264a; padding:9px 13px; cursor:pointer; font:inherit; }
    .rm-rules-actions button.primary, .rm-rule-btn.primary { background:#1f63ad; border-color:#1f63ad; color:#fff; }
    .rm-rules-actions button:disabled { opacity:.6; cursor:not-allowed; }
    .rm-rule-status { margin: 8px 0 14px; font-size:13px; color:#53657e; }
    .rm-rule-status.ok { color:#047857; }
    .rm-rule-status.err { color:#b91c1c; }
    .rm-rule-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:14px; }
    .rm-rule-metric { border:1px solid #e1e9f4; border-radius:8px; padding:14px; background:#fbfdff; }
    .rm-rule-metric h3 { margin:0 0 12px; font-size:15px; color:#061832; }
    .rm-rule-severity { border-top:1px solid #e5edf7; padding-top:12px; margin-top:12px; display:grid; grid-template-columns: 1fr 110px 96px 96px; align-items:end; gap:10px; }
    .rm-rule-severity:first-of-type { border-top:0; margin-top:0; padding-top:0; }
    .rm-rule-severity strong { text-transform:uppercase; letter-spacing:.04em; font-size:11px; color:#53657e; }
    .rm-rule-severity label, .rm-rule-field { display:flex; flex-direction:column; gap:5px; font-size:12px; color:#53657e; }
    .rm-rule-severity input[type='number'], .rm-rule-field input[type='number'] { border:1px solid #cbd8ea; border-radius:7px; padding:8px; font:inherit; background:#fff; color:#061832; }
    .rm-rule-check { display:flex !important; flex-direction:row !important; align-items:center; gap:7px !important; padding-bottom:8px; }
    .rm-disk-rules { margin-top:16px; overflow:auto; border:1px solid #dce6f2; border-radius:8px; }
    .rm-disk-rules table { width:100%; border-collapse:collapse; background:#fff; }
    .rm-disk-rules th { background:#f5f8fc; color:#53657e; font-size:11px; text-transform:uppercase; letter-spacing:.04em; text-align:left; padding:12px; border-bottom:1px solid #e5edf7; }
    .rm-disk-rules td { padding:11px 12px; border-bottom:1px solid #edf2f7; color:#061832; vertical-align:middle; }
    .rm-disk-rules tr:last-child td { border-bottom:0; }
    .rm-disk-rules input[type='number'] { width:86px; border:1px solid #cbd8ea; border-radius:7px; padding:8px; }
    .rm-disk-key small { display:block; color:#6b7b92; margin-top:3px; }
    .rm-usage-pill { display:inline-flex; min-width:68px; justify-content:center; border-radius:999px; padding:5px 9px; background:#eef6ff; color:#1f63ad; font-weight:700; font-size:12px; }
    .rm-rule-help { margin-top:14px; display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:10px; }
    .rm-rule-help span { border:1px solid #e5edf7; border-radius:8px; padding:10px; color:#53657e; font-size:12px; background:#fbfdff; }
    @media (max-width: 980px) { .rm-rule-grid { grid-template-columns:1fr; } .rm-rule-severity { grid-template-columns:1fr 1fr; } .rm-rule-help { grid-template-columns:1fr; } }
  `;

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
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function installStyle() {
    if (document.getElementById('rm-rules-style')) return;
    const style = document.createElement('style');
    style.id = 'rm-rules-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function findDetail() {
    const main = document.querySelector('main');
    const title = main?.querySelector('.page-header h1, h1');
    const tabs = main?.querySelector('.tab-row');
    const detailHead = main?.querySelector('.detail-head');
    if (!main || !title || !tabs || !detailHead) return null;
    const name = title.textContent.trim();
    if (!name || name === 'Equipos monitoreados' || name === 'Dashboard operativo') return null;
    return { main, title, tabs, detailHead, name };
  }

  async function resolveAgentId(name) {
    if (STATE.agentName === name && STATE.agentId) return STATE.agentId;
    const data = await api(`/api/agents?q=${encodeURIComponent(name)}`);
    const agents = data.agents || [];
    const exact = agents.find((a) => a.name === name || a.hostname === name) || agents[0];
    if (!exact) throw new Error('No pude resolver el equipo para configurar reglas.');
    STATE.agentId = exact.id;
    STATE.agentName = name;
    return exact.id;
  }

  function nativeContentAfterTabs(tabs) {
    const nodes = [];
    let node = tabs.nextElementSibling;
    while (node) {
      if (node.id !== 'rm-rules-panel') nodes.push(node);
      node = node.nextElementSibling;
    }
    return nodes;
  }

  function showNative(tabs) {
    document.getElementById('rm-rules-panel')?.remove();
    STATE.nativeNodes.forEach((node) => { node.style.display = ''; });
    tabs.querySelectorAll('button').forEach((btn) => {
      if (btn.dataset.rmRules === '1') btn.classList.remove('selected');
    });
  }

  function installTab(ctx) {
    installStyle();
    const existing = ctx.tabs.querySelector('[data-rm-rules="1"]');
    if (existing) return;
    ctx.tabs.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => showNative(ctx.tabs));
    });
    const button = document.createElement('button');
    button.textContent = 'Reglas';
    button.dataset.rmRules = '1';
    button.addEventListener('click', async () => {
      STATE.nativeNodes = nativeContentAfterTabs(ctx.tabs);
      STATE.nativeNodes.forEach((node) => { node.style.display = 'none'; });
      ctx.tabs.querySelectorAll('button').forEach((btn) => btn.classList.remove('selected'));
      button.classList.add('selected');
      await renderRules(ctx);
    });
    ctx.tabs.appendChild(button);
  }

  function blankRule(metric, severity, threshold, enabled = true, notify = false, resourceKey = '') {
    return { metric, severity, resource_key: resourceKey, threshold, enabled, notify_email: notify, duration_samples: 2, cooldown_minutes: 30, description: '' };
  }

  function byKey(rules) {
    const map = new Map();
    (rules || []).forEach((rule) => map.set(`${rule.metric}:${rule.resource_key || ''}:${rule.severity}`, { ...rule }));
    return map;
  }

  function rule(map, metric, severity, defaults, resourceKey = '') {
    return map.get(`${metric}:${resourceKey}:${severity}`) || blankRule(metric, severity, defaults.threshold, defaults.enabled, defaults.notify_email, resourceKey);
  }

  function buildDraft(rules, disks) {
    const map = byKey(rules);
    const metrics = {
      cpu: { label: 'CPU', unit: '%', warning: rule(map, 'cpu', 'warning', { threshold: 85, enabled: true, notify_email: false }), critical: rule(map, 'cpu', 'critical', { threshold: 95, enabled: true, notify_email: true }) },
      ram: { label: 'RAM', unit: '%', warning: rule(map, 'ram', 'warning', { threshold: 85, enabled: true, notify_email: false }), critical: rule(map, 'ram', 'critical', { threshold: 95, enabled: true, notify_email: true }) },
      network_recv_mbps: { label: 'Red recibida', unit: 'Mbps', warning: rule(map, 'network_recv_mbps', 'warning', { threshold: 0, enabled: false, notify_email: false }), critical: rule(map, 'network_recv_mbps', 'critical', { threshold: 0, enabled: false, notify_email: true }) },
      network_sent_mbps: { label: 'Red enviada', unit: 'Mbps', warning: rule(map, 'network_sent_mbps', 'warning', { threshold: 0, enabled: false, notify_email: false }), critical: rule(map, 'network_sent_mbps', 'critical', { threshold: 0, enabled: false, notify_email: true }) },
    };
    const diskKeys = [...new Set((disks || []).map((d) => d.mountpoint || d.name).filter(Boolean))];
    const diskRows = diskKeys.map((key) => ({
      key,
      disk: (disks || []).find((d) => (d.mountpoint || d.name) === key) || {},
      warning: rule(map, 'disk_used_percent', 'warning', { threshold: 80, enabled: true, notify_email: false }, key),
      critical: rule(map, 'disk_used_percent', 'critical', { threshold: 90, enabled: true, notify_email: true }, key),
    }));
    if (!diskRows.length) {
      diskRows.push({ key: '', disk: {}, warning: rule(map, 'disk_used_percent', 'warning', { threshold: 80, enabled: true, notify_email: false }), critical: rule(map, 'disk_used_percent', 'critical', { threshold: 90, enabled: true, notify_email: true }) });
    }
    return { metrics, disks: diskRows };
  }

  function metricCard(metric, data, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-rule-metric';
    wrap.innerHTML = `<h3>${data.label}</h3>`;
    ['warning', 'critical'].forEach((severity) => {
      const row = document.createElement('div');
      const r = data[severity];
      row.className = 'rm-rule-severity';
      row.innerHTML = `
        <strong>${severity}</strong>
        <label>Umbral (${data.unit})<input type="number" step="0.1" value="${Number(r.threshold || 0)}" data-field="threshold"></label>
        <label class="rm-rule-check"><input type="checkbox" data-field="enabled" ${r.enabled ? 'checked' : ''}> Activa</label>
        <label class="rm-rule-check"><input type="checkbox" data-field="notify_email" ${r.notify_email ? 'checked' : ''}> Correo</label>
        <label>Duracion<input type="number" min="1" value="${Number(r.duration_samples || 2)}" data-field="duration_samples"></label>
        <label>Cooldown<input type="number" min="1" value="${Number(r.cooldown_minutes || 30)}" data-field="cooldown_minutes"></label>
      `;
      row.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => {
        const field = input.dataset.field;
        const value = input.type === 'checkbox' ? input.checked : Number(input.value);
        onChange(metric, severity, field, value);
      }));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function diskTable(disks, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'rm-disk-rules';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Unidad / mount</th><th>Uso actual</th><th>Warning %</th><th>Critical %</th><th>Activa</th><th>Correo critical</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
    const body = wrap.querySelector('tbody');
    disks.forEach((row, index) => {
      const tr = document.createElement('tr');
      const label = row.key || 'default';
      const device = row.disk?.name && row.disk.name !== row.key ? row.disk.name : '';
      tr.innerHTML = `
        <td class="rm-disk-key"><strong>${label}</strong>${device ? `<small>${device}</small>` : ''}</td>
        <td><span class="rm-usage-pill">${Number(row.disk?.used_percent || row.warning.current_value || 0).toFixed(1)}%</span></td>
        <td><input type="number" step="0.1" value="${Number(row.warning.threshold || 80)}" data-sev="warning" data-field="threshold"></td>
        <td><input type="number" step="0.1" value="${Number(row.critical.threshold || 90)}" data-sev="critical" data-field="threshold"></td>
        <td><input type="checkbox" data-sev="all" data-field="enabled" ${row.warning.enabled || row.critical.enabled ? 'checked' : ''}></td>
        <td><input type="checkbox" data-sev="critical" data-field="notify_email" ${row.critical.notify_email ? 'checked' : ''}></td>
      `;
      tr.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => {
        const value = input.type === 'checkbox' ? input.checked : Number(input.value);
        onChange(index, input.dataset.sev, input.dataset.field, value);
      }));
      body.appendChild(tr);
    });
    return wrap;
  }

  function flattenDraft(draft) {
    const out = [];
    Object.values(draft.metrics).forEach((metric) => {
      out.push(metric.warning, metric.critical);
    });
    draft.disks.forEach((row) => out.push(row.warning, row.critical));
    return out.map((rule) => ({
      ...rule,
      threshold: Number(rule.threshold || 0),
      duration_samples: Number(rule.duration_samples || 2),
      cooldown_minutes: Number(rule.cooldown_minutes || 30),
      enabled: !!rule.enabled,
      notify_email: !!rule.notify_email,
    }));
  }

  async function renderRules(ctx) {
    let panel = document.getElementById('rm-rules-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'rm-rules-panel';
      panel.className = 'rm-rules-panel';
      ctx.tabs.insertAdjacentElement('afterend', panel);
    }
    panel.innerHTML = `<div class="rm-rules-card"><div class="rm-rules-head"><div><h2>Reglas de alertas por servidor</h2><p>Cargando reglas y discos actuales...</p></div></div></div>`;
    try {
      const id = await resolveAgentId(ctx.name);
      const [detail, rulesData] = await Promise.all([api(`/api/agents/${id}`), api(`/api/agents/${id}/alert-rules`)]);
      const disks = detail.disks || [];
      const draft = buildDraft(rulesData.rules || [], disks);
      let message = '';
      const redraw = () => {
        panel.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'rm-rules-card';
        card.innerHTML = `
          <div class="rm-rules-head">
            <div><h2>Reglas de alertas por servidor</h2><p>Warning puede quedarse sólo en plataforma; critical envía correo sólo si lo activas por regla.</p></div>
            <div class="rm-rules-actions"><button data-action="reset">Restaurar defaults</button><button class="primary" data-action="save">Guardar reglas</button></div>
          </div>
          ${message ? `<div class="rm-rule-status ok">${message}</div>` : ''}
          <div class="rm-rule-grid"></div>
          <h2 style="font-size:16px;margin:18px 0 10px;color:#061832">Disco por unidad / mount</h2>
        `;
        const grid = card.querySelector('.rm-rule-grid');
        Object.entries(draft.metrics).forEach(([metric, data]) => grid.appendChild(metricCard(metric, data, (m, s, f, v) => { draft.metrics[m][s][f] = v; })));
        card.appendChild(diskTable(draft.disks, (index, severity, field, value) => {
          if (severity === 'all') {
            draft.disks[index].warning[field] = value;
            draft.disks[index].critical[field] = value;
          } else {
            draft.disks[index][severity][field] = value;
          }
        }));
        const help = document.createElement('div');
        help.className = 'rm-rule-help';
        help.innerHTML = `<span><strong>Duracion</strong><br>Numero de muestras consecutivas sobre umbral antes de abrir alerta.</span><span><strong>Red</strong><br>Se evalua en Mbps reales calculados desde contadores acumulados.</span><span><strong>Correo</strong><br>SMTP global se usa sólo cuando la regla tiene correo activo y respeta cooldown.</span>`;
        card.appendChild(help);
        card.querySelector('[data-action="save"]').addEventListener('click', async () => {
          const btn = card.querySelector('[data-action="save"]');
          btn.disabled = true;
          try {
            await api(`/api/agents/${id}/alert-rules`, { method: 'PUT', body: JSON.stringify({ rules: flattenDraft(draft) }) });
            message = 'Reglas guardadas para este equipo.';
            redraw();
          } catch (err) {
            message = `Error al guardar: ${err.message}`;
            redraw();
          }
        });
        card.querySelector('[data-action="reset"]').addEventListener('click', async () => {
          if (!confirm('Restaurar este equipo a los defaults globales?')) return;
          await api(`/api/agents/${id}/alert-rules/reset`, { method: 'POST', body: '{}' });
          message = 'Reglas restauradas a defaults globales. Recarga la pestaña para verlas heredadas.';
          redraw();
        });
        panel.appendChild(card);
      };
      redraw();
    } catch (err) {
      panel.innerHTML = `<div class="rm-rules-card"><div class="rm-rule-status err">${err.message}</div></div>`;
    }
  }

  function tick() {
    const ctx = findDetail();
    if (!ctx) return;
    installTab(ctx);
  }

  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(tick, 1000);
  tick();
})();
