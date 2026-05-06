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
  if (unit === '%') return `${value.toFixed(1)}%`;
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

function enhancePanel(panel) {
  if (panel.getAttribute(ENHANCED_ATTR) === '1') return;
  const svg = panel.querySelector('svg.chart');
  const polylines = [...panel.querySelectorAll('svg.chart polyline')];
  const scaleText = panel.querySelector('.chart-scale span:last-child')?.textContent || '100%';
  if (!svg || !polylines.length) return;

  panel.setAttribute(ENHANCED_ATTR, '1');
  panel.classList.add('chart-hover-panel');
  const scale = parseScale(scaleText);
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

    tooltip.innerHTML = `<strong>Punto ${index + 1}</strong>${rows}`;
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
setInterval(enhanceCharts, 2000);
