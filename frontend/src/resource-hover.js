const ENHANCED_ATTR = 'data-rm-hover-ready';

function parseScale(text) {
  const raw = String(text || '').trim();
  const value = Number(raw.replace(',', '.').match(/[0-9.]+/)?.[0] || 0);
  const unit = raw.replace(/[0-9.,\s]/g, '') || '%';
  const multipliers = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const upper = unit.toUpperCase();
  return { value: value * (multipliers[upper] || 1), unit: upper.includes('%') ? '%' : upper };
}

function formatValue(value, unit) {
  if (unit === '%') return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let next = Math.max(0, Number(value || 0));
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function labelFor(panel, lineIndex) {
  return panel.querySelectorAll('.legend span')[lineIndex]?.textContent?.trim() || `Serie ${lineIndex + 1}`;
}

function colorFor(panel, lineIndex, polyline) {
  return panel.querySelectorAll('.legend i')[lineIndex]?.style?.background || polyline.style.stroke || '#2563eb';
}

function lineValue(pointY, maxValue) {
  const yZero = 44;
  const yTop = 4;
  const ratio = Math.max(0, Math.min(1, (yZero - pointY) / (yZero - yTop)));
  return ratio * maxValue;
}

function svgPointFromMouse(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function clientPointFromSvg(svg, x, y) {
  const point = svg.createSVGPoint();
  point.x = x;
  point.y = y;
  return point.matrixTransform(svg.getScreenCTM());
}

function nearestPointIndex(points, x) {
  let closestIndex = 0;
  let closestDistance = Infinity;
  for (let index = 0; index < points.numberOfItems; index += 1) {
    const distance = Math.abs(points.getItem(index).x - x);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
}

function currentRangeHours() {
  const selected = document.querySelector('.chart-toolbar .segmented .selected')?.textContent?.trim() || '24h';
  if (selected === '7d') return 24 * 7;
  if (selected === '30d') return 24 * 30;
  return 24;
}

function formatTick(date, rangeHours) {
  if (rangeHours <= 24) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function buildTimeTicks(rangeHours) {
  const end = Date.now();
  const start = end - rangeHours * 60 * 60 * 1000;
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => formatTick(new Date(start + (end - start) * ratio), rangeHours));
}

function renderAxes(panel, svg, scale) {
  const svgRect = svg.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  let yAxis = panel.querySelector('.rm-y-axis');
  let xAxis = panel.querySelector('.rm-x-axis');
  if (!yAxis) {
    yAxis = document.createElement('div');
    yAxis.className = 'rm-y-axis';
    panel.append(yAxis);
  }
  if (!xAxis) {
    xAxis = document.createElement('div');
    xAxis.className = 'rm-x-axis';
    panel.append(xAxis);
  }

  const yValues = [1, 0.75, 0.5, 0.25, 0].map((ratio) => formatValue(scale.value * ratio, scale.unit));
  yAxis.innerHTML = yValues.map((value) => `<span>${value}</span>`).join('');
  yAxis.style.top = `${svgRect.top - panelRect.top}px`;
  yAxis.style.left = `${Math.max(8, svgRect.left - panelRect.left - 58)}px`;
  yAxis.style.height = `${svgRect.height}px`;

  const rangeHours = currentRangeHours();
  xAxis.innerHTML = buildTimeTicks(rangeHours).map((value) => `<span>${value}</span>`).join('');
  xAxis.style.top = `${svgRect.bottom - panelRect.top + 8}px`;
  xAxis.style.left = `${svgRect.left - panelRect.left}px`;
  xAxis.style.width = `${svgRect.width}px`;
}

function enhancePanel(panel) {
  const svg = panel.querySelector('svg.chart');
  const polylines = [...panel.querySelectorAll('svg.chart polyline')];
  const scaleText = panel.querySelector('.chart-scale span:last-child')?.textContent || '100%';
  if (!svg || !polylines.length) return;

  const scale = parseScale(scaleText);
  panel.classList.add('chart-hover-panel', 'chart-axis-panel');
  renderAxes(panel, svg, scale);
  if (panel.getAttribute(ENHANCED_ATTR) === '1') return;
  panel.setAttribute(ENHANCED_ATTR, '1');

  const cursor = document.createElement('div');
  cursor.className = 'hover-cursor-line';
  const tooltip = document.createElement('div');
  tooltip.className = 'hover-value-tooltip';
  panel.append(cursor, tooltip);

  svg.addEventListener('mousemove', (event) => {
    const points = polylines[0].points;
    if (!points?.numberOfItems || !svg.getScreenCTM()) return;

    const svgMouse = svgPointFromMouse(svg, event);
    const index = nearestPointIndex(points, svgMouse.x);
    const point = points.getItem(index);
    const clientPoint = clientPointFromSvg(svg, point.x, point.y);
    const panelRect = panel.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const left = clientPoint.x - panelRect.left;

    cursor.style.display = 'block';
    cursor.style.left = `${left}px`;
    cursor.style.top = `${svgRect.top - panelRect.top}px`;
    cursor.style.height = `${svgRect.height}px`;

    const rows = polylines.map((line, lineIndex) => {
      const linePoint = line.points.getItem(index);
      const value = lineValue(linePoint.y, scale.value);
      const color = colorFor(panel, lineIndex, line);
      return `<span><i style="background:${color}"></i>${labelFor(panel, lineIndex)}<b>${formatValue(value, scale.unit)}</b></span>`;
    }).join('');

    tooltip.innerHTML = `<strong>${buildTimeTicks(currentRangeHours())[Math.round((index / Math.max(points.numberOfItems - 1, 1)) * 4)] || `Punto ${index + 1}`}</strong>${rows}`;
    tooltip.style.display = 'grid';
    tooltip.style.left = `${Math.min(Math.max(left, 115), panelRect.width - 115)}px`;
    tooltip.style.top = `${Math.max(70, svgRect.top - panelRect.top + 14)}px`;
  });

  svg.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
    tooltip.style.display = 'none';
  });
}

function enhanceCharts() {
  document.querySelectorAll('.chart-grid .panel').forEach(enhancePanel);
}

const observer = new MutationObserver(enhanceCharts);
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('load', enhanceCharts);
window.addEventListener('resize', enhanceCharts);
setInterval(enhanceCharts, 2000);
