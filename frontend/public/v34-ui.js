(() => {
  let currentAgentId = '';
  let currentHistory = null;
  let preferredRange = sessionStorage.getItem('rm_history_range') || '';

  const originalFetch = window.fetch.bind(window);
  const style = document.createElement('style');
  style.textContent = `
    .network-clean-toolbar {
      align-items: center;
      background: #fff;
      border: 1px solid #dce7f4;
      border-radius: 8px;
      display: flex;
      justify-content: space-between;
      margin: 0 0 12px;
      padding: 10px 12px;
    }
    .network-clean-toolbar span { color: #52637a; font-size: 13px; font-weight: 700; }
    .network-clean-toolbar button {
      background: #fff;
      border: 1px solid #d8e1ec;
      border-radius: 8px;
      color: #14538e;
      font-weight: 800;
      min-height: 36px;
      padding: 0 12px;
    }
  `;
  document.head.appendChild(style);

  window.fetch = async (input, init) => {
    let url = typeof input === 'string' ? input : input?.url || '';
    const requestedRange = preferredRange && /\/api\/agents\/[^/]+\/history\?range=/.test(url) ? preferredRange : '';
    if (requestedRange) {
      url = url.replace(/range=[^&]+/, `range=${encodeURIComponent(requestedRange)}`);
      input = typeof input === 'string' ? url : new Request(url, input);
    }
    const response = await originalFetch(input, init);
    const cloned = response.clone();
    cloned.json().then((data) => {
      const agentMatch = url.match(/\/api\/agents\/([^/?]+)/);
      if (agentMatch && !url.includes('/history') && !url.includes('/networks')) currentAgentId = agentMatch[1];
      if (url.includes('/history')) currentHistory = data;
    }).catch(() => {});
    return response;
  };

  function token() {
    return localStorage.getItem('rm_token') || '';
  }

  async function api(path, options = {}) {
    const res = await originalFetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token()}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`api ${res.status}`);
    return res.json();
  }

  function selectedPlatform() {
    const buttons = [...document.querySelectorAll('.wizard .segmented button')];
    return buttons.find((button) => button.classList.contains('selected'))?.textContent?.trim().toLowerCase() || 'linux';
  }

  function polishEnrollment() {
    const result = document.querySelector('.install-result');
    if (!result) return;
    const platform = selectedPlatform();
    const boxes = [...result.querySelectorAll('.command-box')];
    boxes.forEach((box) => {
      const title = box.querySelector('span')?.textContent?.toLowerCase() || '';
      const isWindows = title.includes('windows');
      box.style.display = platform === 'windows' ? (isWindows ? 'flex' : 'none') : (!isWindows ? 'flex' : 'none');
    });
  }

  function injectHistoryRanges() {
    const toolbar = [...document.querySelectorAll('.chart-toolbar .segmented')].find((el) => el.textContent.includes('24h'));
    if (!toolbar || toolbar.dataset.v34Ranges === '1') return;
    toolbar.dataset.v34Ranges = '1';
    ['1h', '6h', '12h'].reverse().forEach((range) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = range;
      button.addEventListener('click', () => {
        preferredRange = range;
        sessionStorage.setItem('rm_history_range', range);
        toolbar.querySelectorAll('button').forEach((item) => item.classList.remove('selected'));
        button.classList.add('selected');
        const native = [...toolbar.querySelectorAll('button')].find((item) => item.textContent.trim() === '24h');
        native?.click();
        setTimeout(clickRefresh, 100);
      });
      toolbar.prepend(button);
    });
  }

  function replaceSwapRing() {
    const cards = [...document.querySelectorAll('.ring-card')];
    const swap = cards.find((card) => card.textContent.includes('Swap'));
    if (!swap || !currentHistory?.metrics?.length) return;
    const last = currentHistory.metrics[currentHistory.metrics.length - 1] || {};
    const cpu = Number(last.cpu_percent || 0);
    swap.querySelector('strong').textContent = 'CPU';
    swap.querySelector('small').textContent = `${cpu.toFixed(1)}% / 100%`;
    const ring = swap.querySelector('.ring');
    if (ring) ring.style.background = `conic-gradient(#2563eb ${Math.max(0, Math.min(cpu, 100)) * 3.6}deg, #d9dee6 0deg)`;
    const value = swap.querySelector('.ring span');
    if (value) value.textContent = `${cpu.toFixed(1)}%`;
  }

  function injectNetworkValidation() {
    const networkTabSelected = [...document.querySelectorAll('.tab-row button.selected')].some((button) => button.textContent.trim() === 'Red');
    if (!networkTabSelected || document.querySelector('[data-v34-network-reconcile]')) return;
    const table = document.querySelector('.table-wrap');
    if (!table) return;
    const bar = document.createElement('div');
    bar.className = 'network-clean-toolbar';
    bar.innerHTML = '<span>Interfaces activas del ultimo reporte</span><button data-v34-network-reconcile>Validar interfaces</button>';
    table.parentElement.insertBefore(bar, table);
    bar.querySelector('button').addEventListener('click', async (event) => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = 'Validando...';
      try {
        if (!currentAgentId) throw new Error('missing agent');
        await api(`/api/agents/${currentAgentId}/networks/reconcile`, { method: 'POST', body: '{}' });
        const next = await api(`/api/agents/${currentAgentId}/networks`);
        rewriteNetworkTable(next.networks || []);
      } catch (_) {
        cleanLocalNetworkRows();
      } finally {
        event.currentTarget.textContent = 'Validar interfaces';
        event.currentTarget.disabled = false;
      }
    });
  }

  function cleanLocalNetworkRows() {
    const rows = [...document.querySelectorAll('.table-wrap tbody tr')];
    rows.forEach((row) => {
      const name = row.children[0]?.textContent?.trim() || '';
      if (/^(br-|veth|virbr|docker|lo$)/i.test(name)) row.remove();
    });
    const tbody = document.querySelector('.table-wrap tbody');
    if (tbody && !tbody.children.length) tbody.innerHTML = '<tr><td class="empty" colspan="4">Sin interfaces activas visibles</td></tr>';
  }

  function rewriteNetworkTable(networks) {
    const tbody = document.querySelector('.table-wrap tbody');
    if (!tbody) return;
    tbody.innerHTML = networks.length ? networks.map((net) => `
      <tr>
        <td>${escapeHTML(net.name || '')}</td>
        <td>${net.up ? 'up' : 'down'}</td>
        <td>${formatBytes(net.bytes_recv)}</td>
        <td>${formatBytes(net.bytes_sent)}</td>
      </tr>
    `).join('') : '<tr><td class="empty" colspan="4">Sin muestras de red</td></tr>';
  }

  function clickRefresh() {
    const refresh = [...document.querySelectorAll('button[aria-label="Actualizar"]')].pop();
    refresh?.click();
  }

  function formatBytes(value) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let next = Number(value || 0);
    let unit = 0;
    while (next > 1024 && unit < units.length - 1) {
      next /= 1024;
      unit += 1;
    }
    return `${next.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  }

  function run() {
    polishEnrollment();
    injectHistoryRanges();
    replaceSwapRing();
    injectNetworkValidation();
  }

  new MutationObserver(run).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(run, 1000);
  run();
})();
