(() => {
  const API_BASE = ''; // proxied by nginx
  const METRIC = 'agent_offline_minutes';
  let installing = false;

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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function currentAgentName() {
    const h1 = document.querySelector('main .page-header h1, main h1');
    return h1?.textContent?.trim() || '';
  }

  async function currentAgentId() {
    const name = currentAgentName();
    if (!name) throw new Error('Equipo no encontrado');
    const data = await api(`/api/agents?q=${encodeURIComponent(name)}`);
    const agents = data.agents || [];
    const agent = agents.find((item) => item.name === name || item.hostname === name) || agents[0];
    if (!agent) throw new Error('Equipo no encontrado');
    return agent.id;
  }

  function rule(rules, severity) {
    return (rules || []).find((item) => item.metric === METRIC && item.severity === severity) || {
      metric: METRIC,
      resource_key: '',
      severity,
      enabled: true,
      threshold: severity === 'critical' ? 10 : 3,
      duration_samples: 1,
      notify_email: severity === 'critical',
      notify_telegram: false,
      cooldown_minutes: 30,
      description: `Conexion perdida ${severity}`,
    };
  }

  function renderRuleRow(severity, ruleData) {
    return `
      <div class="rm-rule-severity" data-offline-severity="${severity}">
        <strong>${severity}</strong>
        <label>Umbral (min)<input type="number" min="1" step="1" value="${Number(ruleData.threshold || 0)}" data-field="threshold"></label>
        <label class="rm-rule-check"><input type="checkbox" data-field="enabled" ${ruleData.enabled ? 'checked' : ''}> Activa</label>
        <label class="rm-rule-check"><input type="checkbox" data-field="notify_email" ${ruleData.notify_email ? 'checked' : ''}> Correo</label>
        <label>Duracion<input type="number" min="1" value="${Number(ruleData.duration_samples || 1)}" data-field="duration_samples"></label>
        <label>Cooldown<input type="number" min="1" value="${Number(ruleData.cooldown_minutes || 30)}" data-field="cooldown_minutes"></label>
      </div>
    `;
  }

  function readCard(card, baseRules) {
    const bySeverity = {
      warning: { ...rule(baseRules, 'warning') },
      critical: { ...rule(baseRules, 'critical') },
    };
    card.querySelectorAll('[data-offline-severity]').forEach((row) => {
      const severity = row.dataset.offlineSeverity;
      row.querySelectorAll('input').forEach((input) => {
        const field = input.dataset.field;
        bySeverity[severity][field] = input.type === 'checkbox' ? input.checked : Number(input.value || 0);
      });
    });
    return [bySeverity.warning, bySeverity.critical].map((item) => ({
      ...item,
      metric: METRIC,
      resource_key: '',
      threshold: Number(item.threshold || 0),
      duration_samples: Number(item.duration_samples || 1),
      cooldown_minutes: Number(item.cooldown_minutes || 30),
      notify_telegram: !!item.notify_telegram,
      notify_email: !!item.notify_email,
      enabled: !!item.enabled,
    }));
  }

  async function inject() {
    if (installing || document.querySelector('[data-v34-offline-rules]')) return;
    const grid = document.querySelector('#rm-rules-panel .rm-rule-grid');
    if (!grid) return;
    installing = true;
    try {
      const id = await currentAgentId();
      const data = await api(`/api/agents/${id}/alert-rules`);
      const rules = data.rules || [];
      const warning = rule(rules, 'warning');
      const critical = rule(rules, 'critical');
      const card = document.createElement('div');
      card.className = 'rm-rule-metric';
      card.dataset.v34OfflineRules = '1';
      card.innerHTML = `
        <h3>Conexion perdida</h3>
        ${renderRuleRow('warning', warning)}
        ${renderRuleRow('critical', critical)}
        <div class="rm-rules-actions" style="margin-top:12px"><button class="primary" type="button">Guardar conexion perdida</button></div>
      `;
      card.querySelector('button').addEventListener('click', async () => {
        const existing = await api(`/api/agents/${id}/alert-rules`);
        const preserved = (existing.rules || []).filter((item) => item.metric !== METRIC);
        const offline = readCard(card, existing.rules || []);
        await api(`/api/agents/${id}/alert-rules`, { method: 'PUT', body: JSON.stringify({ rules: [...preserved, ...offline] }) });
        card.querySelector('button').textContent = 'Guardado';
        setTimeout(() => { card.querySelector('button').textContent = 'Guardar conexion perdida'; }, 1800);
      });
      grid.appendChild(card);
    } catch (_) {
      // Keep the native rules UI working even if the helper cannot resolve the agent.
    } finally {
      installing = false;
    }
  }

  new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(inject, 1500);
  inject();
})();
