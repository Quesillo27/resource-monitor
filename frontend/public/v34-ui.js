(() => {
  let currentAgentId = '';
  let currentHistory = null;
  let currentAgentDetail = null;
  let preferredRange = sessionStorage.getItem('rm_history_range') || '';

  const API_BASE = `${window.location.protocol}//${window.location.hostname}:8080`;
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
    if (preferredRange && /\/api\/agents\/[^/]+\/history\?range=/.test(url)) {
      url = url.replace(/range=[^&]+/, `range=${encodeURIComponent(preferredRange)}`);
      input = typeof input === 'string' ? url : new Request(url, input);
    }
    const response = await originalFetch(input, init);
    const cloned = response.clone();
    cloned.json().then((data) => {
      const agentMatch = url.match(/\/api\/agents\/([^/?]+)/);
      if (agentMatch && !url.includes('/history') && !url.includes('/networks')) {
        currentAgentId = agentMatch[1];
        if (!url.includes('/status') && !url.includes('/alert-rules')) currentAgentDetail = data;
      }
      if (url.includes('/history')) currentHistory = data;
    }).catch(() => {});
    return response;
  };

  function token() {
    return localStorage.getItem('rm_token') || '';
  }

  function apiURL(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  }

  function api(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body || null;
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open(method, apiURL(path), true);
      request.setRequestHeader('Content-Type', 'application/json');
      request.setRequestHeader('Authorization', `Bearer ${token()}`);
      request.onload = () => {
        let payload = {};
        try {
          payload = request.responseText ? JSON.parse(request.responseText) : {};
        } catch (_) {
          payload = {};
        }
        if (request.status >= 200 && request.status < 300) {
          resolve(payload);
        } else {
          reject(new Error(payload.error || `request failed ${request.status}`));
        }
      };
      request.onerror = () => reject(new Error('network request failed'));
      request.send(body);
    });
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
    if (!toolbar) return;
    if (toolbar.dataset.v34Ranges !== '1') {
      toolbar.dataset.v34Ranges = '1';
      ['1h', '6h', '12h'].reverse().forEach((range) => {
        if ([...toolbar.querySelectorAll('button')].some((item) => item.textContent.trim() === range)) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = range;
        toolbar.prepend(button);
      });
    }
    toolbar.querySelectorAll('button').forEach((button) => {
      if (button.dataset.v34RangeBound === '1') return;
      button.dataset.v34RangeBound = '1';
      button.addEventListener('click', () => {
        const nextRange = button.textContent.trim();
        preferredRange = nextRange;
        sessionStorage.setItem('rm_history_range', nextRange);
        syncHistoryRangeSelection(toolbar);
        setTimeout(clickRefresh, 80);
      });
    });
    syncHistoryRangeSelection(toolbar);
  }

  function syncHistoryRangeSelection(toolbar) {
    const selected = preferredRange || toolbar.querySelector('button.selected')?.textContent?.trim() || '24h';
    toolbar.querySelectorAll('button').forEach((button) => {
      button.classList.toggle('selected', button.textContent.trim() === selected);
    });
  }

  function replaceSwapRing() {
    const cards = [...document.querySelectorAll('.ring-card')];
    const swap = cards.find((card) => card.textContent.includes('Swap'));
    if (!swap) return;
    const historyMetrics = currentHistory?.metrics || [];
    const last = historyMetrics[historyMetrics.length - 1] || {};
    const cpu = Number(currentAgentDetail?.agent?.cpu_percent ?? last.cpu_percent ?? 0);
    swap.querySelector('strong').textContent = 'CPU';
    swap.querySelector('small').textContent = `${cpu.toFixed(1)}% / 100%`;
    const ring = swap.querySelector('.ring');
    if (ring) ring.style.background = `conic-gradient(#2563eb ${Math.max(0, Math.min(cpu, 100)) * 3.6}deg, #d9dee6 0deg)`;
    const value = swap.querySelector('.ring span');
    if (value) value.textContent = `${cpu.toFixed(1)}%`;
  }

  function injectNetworkValidation() {
    const networkTabSelected = [...document.querySelectorAll('.tab-row button.selected')].some((button) => button.textContent.trim() === 'Red');
    if (!networkTabSelected) {
      document.querySelectorAll('.network-clean-toolbar').forEach((item) => item.remove());
      return;
    }
    applyHiddenNetworkRows();
    if (document.querySelector('[data-v34-network-reconcile]')) return;
    const table = document.querySelector('.table-wrap');
    if (!table || !currentAgentId) return;
    const bar = document.createElement('div');
    bar.className = 'network-clean-toolbar';
    bar.innerHTML = '<span>Interfaces activas del ultimo reporte</span><button data-v34-network-reconcile>Validar interfaces</button>';
    table.parentElement.insertBefore(bar, table);
    bar.querySelector('button').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      if (!button) return;
      button.disabled = true;
      button.textContent = 'Validando...';
      try {
        await api(`/api/agents/${currentAgentId}/networks/reconcile`, { method: 'POST', body: '{}' });
        const next = await api(`/api/agents/${currentAgentId}/networks`);
        rewriteNetworkTable(next.networks || []);
        rememberVisibleNetworks(next.networks || []);
      } catch (error) {
        console.warn('network reconcile failed, applying local cleanup', error);
        cleanLocalNetworkRows();
      } finally {
        if (button.isConnected) {
          button.textContent = 'Validar interfaces';
          button.disabled = false;
        }
      }
    });
  }

  function rewriteNetworkTable(networks) {
    const tbody = document.querySelector('.table-wrap tbody');
    if (!tbody) return;
    const visible = filterVisibleNetworks(networks);
    tbody.innerHTML = visible.length ? visible.map((net) => `
      <tr>
        <td>${escapeHTML(net.name || '')}</td>
        <td>${net.up ? 'up' : 'down'}</td>
        <td>${formatBytes(net.bytes_recv)}</td>
        <td>${formatBytes(net.bytes_sent)}</td>
      </tr>
    `).join('') : '<tr><td class="empty" colspan="4">Sin muestras de red</td></tr>';
  }

  function hiddenNetworkKey() {
    return currentAgentId ? `rm_hidden_networks_${currentAgentId}` : '';
  }

  function hiddenNetworks() {
    const key = hiddenNetworkKey();
    if (!key) return new Set();
    try {
      return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
    } catch (_) {
      return new Set();
    }
  }

  function saveHiddenNetworks(values) {
    const key = hiddenNetworkKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify([...values].sort()));
  }

  function shouldHideNetworkName(name) {
    return /^(br-|veth|virbr|docker|lo$)/i.test(String(name || ''));
  }

  function filterVisibleNetworks(networks) {
    const hidden = hiddenNetworks();
    return (networks || []).filter((net) => {
      const name = net.name || '';
      return name && !hidden.has(name) && !shouldHideNetworkName(name);
    });
  }

  function rememberVisibleNetworks(networks) {
    const hidden = hiddenNetworks();
    networks.forEach((net) => {
      if (shouldHideNetworkName(net.name)) hidden.add(net.name);
    });
    saveHiddenNetworks(hidden);
  }

  function networkRows() {
    const tbody = document.querySelector('.table-wrap tbody');
    return tbody ? [...tbody.querySelectorAll('tr')] : [];
  }

  function cleanLocalNetworkRows() {
    const hidden = hiddenNetworks();
    networkRows().forEach((row) => {
      const name = row.cells?.[0]?.textContent?.trim() || '';
      if (name && shouldHideNetworkName(name)) {
        hidden.add(name);
        row.remove();
      }
    });
    saveHiddenNetworks(hidden);
  }

  function applyHiddenNetworkRows() {
    const hidden = hiddenNetworks();
    if (!hidden.size) return;
    networkRows().forEach((row) => {
      const name = row.cells?.[0]?.textContent?.trim() || '';
      if (hidden.has(name)) row.remove();
    });
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
