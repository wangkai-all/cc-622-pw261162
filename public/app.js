const state = {
  dataset: null,
  analysis: null,
  segmentView: null,
  lateApplied: false,
};

const $ = (selector) => document.querySelector(selector);
const results = $('#results');
const statusEl = $('#status');
const tooltip = $('#tooltip');

const fmt1 = (n) =>
  n === null || n === undefined
    ? '—'
    : (Math.round(n * 10) / 10).toLocaleString('zh-CN');
const int = (n) => (n ?? 0).toLocaleString('zh-CN');
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);

const STATUS_LABEL = { slow: '慢件', on_time: '正常', incomplete: '时间不全' };
const SEGMENT_LABEL = {
  inbound_to_departure: '入分拣→出场',
  departure_to_arrival: '出场→到件',
};
const MISSING_LABEL = { inbound: '入分拣', departure: '出场', arrival: '到件' };

const statusChip = (status) => {
  const cls = status === 'slow' ? 'slow' : status === 'on_time' ? 'ok' : 'pending';
  return `<span class="chip ${cls}">${STATUS_LABEL[status] ?? esc(status)}</span>`;
};

const segLabel = (key) => SEGMENT_LABEL[key] ?? '';

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    if (type.includes('application/json')) {
      const body = await res.json().catch(() => null);
      if (body?.error) message = body.error;
    }
    throw new Error(message);
  }
  return type.includes('application/json') ? res.json() : res;
}

function postJson(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function setPanelVisible(step) {
  // 保留已完成的步骤，便于操作前后对照；只把新结果滚动到视野内。
  const panel = $(`#step-${step}`);
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  results.dataset.evidenceResult = step;
}

function setButtons() {
  const hasData = Boolean(state.dataset);
  $('#btn-late').disabled = !hasData;
  $('#btn-segments').disabled = !hasData;
  $('#btn-export').disabled = !hasData;
  $('#btn-late').textContent = state.lateApplied ? '重新核对补交' : '补交改派和出场';
}

/* ---------------- charts ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function showTooltip(event, html) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY - rect.height - pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y < 8) y = event.clientY + pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTooltip() {
  tooltip.hidden = true;
}

/**
 * 单系列横向条形图：每个网点一条，值标在条端。
 * 条高 <=24，数据端 4px 圆角，基线端方角。
 */
function renderSiteBars(host, rows, metricLabel = '慢件') {
  if (!rows.length) {
    host.innerHTML = '<p class="empty">没有可展示的网点数据。</p>';
    return;
  }
  const width = 760;
  const rowH = 34;
  const barH = 20;
  const labelW = 150;
  const valueW = 64;
  const top = 8;
  const height = top + rows.length * rowH + 8;
  const barMax = width - labelW - valueW;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `各网点${metricLabel}数横向条形图`,
  });

  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const w = (row.value / max) * barMax;
    const label = svgEl('text', {
      x: labelW - 10,
      y: y + barH / 2 + 4,
      'text-anchor': 'end',
      fill: 'var(--text-secondary)',
      'font-size': 12.5,
    });
    label.textContent = row.label;
    svg.appendChild(label);

    const track = svgEl('rect', {
      x: labelW,
      y: y + (rowH - barH) / 2,
      width: barMax,
      height: barH,
      rx: 3,
      fill: 'var(--surface-2)',
    });
    svg.appendChild(track);

    if (w > 0) {
      const bar = svgEl('rect', {
        x: labelW,
        y: y + (rowH - barH) / 2,
        width: Math.max(w, 3),
        height: barH,
        rx: 3,
        fill: 'var(--series-1)',
      });
      const tip = `<div class="t-title">${esc(row.label)}</div><div class="t-row">${esc(metricLabel)} ${int(row.value)} 段 · 经手 ${int(row.handled)} 件</div>`;
      bar.addEventListener('mousemove', (e) => showTooltip(e, tip));
      bar.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(bar);
    }

    const hitArea = svgEl('rect', {
      x: labelW,
      y,
      width: barMax,
      height: rowH,
      fill: 'transparent',
    });
    const tip = `<div class="t-title">${esc(row.label)}</div><div class="t-row">${esc(metricLabel)} ${int(row.value)} 段 · 经手 ${int(row.handled)} 件</div>`;
    hitArea.addEventListener('mousemove', (e) => showTooltip(e, tip));
    hitArea.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(hitArea);

    const value = svgEl('text', {
      x: labelW + w + 8,
      y: y + barH / 2 + 4,
      fill: 'var(--text-primary)',
      'font-size': 12.5,
      'font-variant-numeric': 'tabular-nums',
    });
    value.textContent = int(row.value);
    svg.appendChild(value);
  });

  host.replaceChildren(svg);
}

/**
 * 两系列纵向分组柱状图（口径对比）。相邻柱之间留 2px 表面间隙，
 * 柱顶 4px 圆角，值标在柱帽上，图例由调用方渲染。
 */
function renderGroupedColumns(host, groups, series) {
  if (!groups.length) {
    host.innerHTML = '<p class="empty">没有可展示的分段数据。</p>';
    return;
  }
  const width = 760;
  const height = 320;
  const margin = { top: 26, right: 20, bottom: 56, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const max = Math.max(1, ...groups.flatMap((g) => series.map((s) => g.values[s.key])));
  const niceMax = niceCeil(max);
  const ticks = 4;
  const band = plotW / groups.length;
  const barW = Math.min(24, (band * 0.56 - 2) / series.length);
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': '分段延误两套归因口径对比柱状图',
  });

  for (let t = 0; t <= ticks; t += 1) {
    const v = (niceMax / ticks) * t;
    const y = margin.top + plotH - (v / niceMax) * plotH;
    svg.appendChild(
      svgEl('line', {
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
        stroke: t === 0 ? 'var(--baseline)' : 'var(--gridline)',
        'stroke-width': 1,
      }),
    );
    const tick = svgEl('text', {
      x: margin.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      fill: 'var(--text-muted)',
      'font-size': 11,
      'font-variant-numeric': 'tabular-nums',
    });
    tick.textContent = int(Math.round(v));
    svg.appendChild(tick);
  }

  groups.forEach((group, gi) => {
    const groupW = series.length * barW + (series.length - 1) * 2;
    const startX = margin.left + gi * band + (band - groupW) / 2;
    series.forEach((s, si) => {
      const value = group.values[s.key] ?? 0;
      const h = (value / niceMax) * plotH;
      const x = startX + si * (barW + 2);
      const y = margin.top + plotH - h;
      const rect = svgEl('rect', {
        x,
        y,
        width: barW,
        height: Math.max(h, value > 0 ? 2 : 0),
        rx: 4,
        fill: `var(${s.color})`,
      });
      rect.addEventListener('mousemove', (e) =>
        showTooltip(
          e,
          `<div class="t-title">${esc(group.label)}</div><div class="t-row">${esc(s.label)}：${fmt1(value)} 分钟</div>`,
        ),
      );
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      if (value > 0) {
        const label = svgEl('text', {
          x: x + barW / 2,
          y: y - 7,
          'text-anchor': 'middle',
          fill: 'var(--text-primary)',
          'font-size': 11,
          'font-variant-numeric': 'tabular-nums',
        });
        label.textContent = fmt1(value);
        svg.appendChild(label);
      }
    });

    const gLabel = svgEl('text', {
      x: margin.left + gi * band + band / 2,
      y: height - margin.bottom + 22,
      'text-anchor': 'middle',
      fill: 'var(--text-secondary)',
      'font-size': 12.5,
    });
    gLabel.textContent = group.label;
    svg.appendChild(gLabel);
  });

  const unit = svgEl('text', {
    x: margin.left,
    y: 14,
    fill: 'var(--text-muted)',
    'font-size': 11,
  });
  unit.textContent = '分钟';
  svg.appendChild(unit);

  host.replaceChildren(svg);
}

/**
 * 两系列堆叠横向条形图：网点积压 + 传播 = 该网点延误合计。
 * 段间留 2px 表面间隙，条端标出合计。
 */
function renderStackedSites(host, rows, series) {
  if (!rows.length) {
    host.innerHTML = '<p class="empty">没有可展示的网点数据。</p>';
    return;
  }
  const width = 760;
  const rowH = 36;
  const barH = 20;
  const labelW = 110;
  const valueW = 70;
  const top = 8;
  const height = top + rows.length * rowH + 8;
  const plotW = width - labelW - valueW;
  const max = Math.max(1, ...rows.map((r) => series.reduce((s, x) => s + (r[x.key] ?? 0), 0)));
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': '各网点积压与传播延误堆叠条形图',
  });

  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const values = series.map((s) => row[s.key] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    const track = svgEl('rect', {
      x: labelW,
      y: y + (rowH - barH) / 2,
      width: plotW,
      height: barH,
      rx: 3,
      fill: 'var(--surface-2)',
    });
    svg.appendChild(track);

    const label = svgEl('text', {
      x: labelW - 10,
      y: y + barH / 2 + 4,
      'text-anchor': 'end',
      fill: 'var(--text-secondary)',
      'font-size': 12.5,
    });
    label.textContent = row.label;
    svg.appendChild(label);

    let x = labelW;
    let firstSegment = true;
    series.forEach((s, si) => {
      const value = values[si];
      if (value <= 0) return;
      const w = (value / max) * (plotW - 8);
      const gap = firstSegment ? 0 : 2;
      const rect = svgEl('rect', {
        x: x + gap,
        y: y + (rowH - barH) / 2,
        width: Math.max(w - gap, 1),
        height: barH,
        fill: `var(${s.color})`,
      });
      const tip = `<div class="t-title">${esc(row.label)}</div><div class="t-row">${esc(s.label)}：${fmt1(value)} 分钟</div><div class="t-row">延误合计：${fmt1(total)} 分钟</div>`;
      rect.addEventListener('mousemove', (e) => showTooltip(e, tip));
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      x += w;
      firstSegment = false;
    });

    const tip = `<div class="t-title">${esc(row.label)}</div>${series
      .map((s, si) => `<div class="t-row">${esc(s.label)}：${fmt1(values[si])} 分钟</div>`)
      .join('')}<div class="t-row">延误合计：${fmt1(total)} 分钟</div>`;
    const hitArea = svgEl('rect', {
      x: labelW,
      y,
      width: plotW,
      height: rowH,
      fill: 'transparent',
    });
    hitArea.addEventListener('mousemove', (e) => showTooltip(e, tip));
    hitArea.addEventListener('mouseleave', hideTooltip);
    svg.appendChild(hitArea);

    const value = svgEl('text', {
      x: labelW + (total / max) * (plotW - 8) + 8,
      y: y + barH / 2 + 4,
      fill: 'var(--text-primary)',
      'font-size': 12.5,
      'font-variant-numeric': 'tabular-nums',
    });
    value.textContent = fmt1(total);
    svg.appendChild(value);
  });

  host.replaceChildren(svg);
}

function niceCeil(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/* ---------------- generate step ---------------- */

function renderGenerate(analysis) {
  const { totals, sites, segments } = analysis.before;
  const meta = state.dataset.meta;

  $('#generate-sub').textContent = `种子 ${meta.seed} · ${meta.count} 件 · 业务日 ${meta.businessDate}。以下为补交前的原始记录，时间不全的件照常保留。`;
  const missingCount = analysis.before.shipments.filter((s) => s.missing.length > 0).length;
  $('#generate-badge').textContent = `${int(totals.count)} 件 · 缺时间 ${int(missingCount)} 件`;

  $('#generate-stats').innerHTML = [
    statCard('快件总数', int(totals.count), '含时间不全的件'),
    statCard('慢件', int(totals.slow), '至少一段超过计划'),
    statCard('正常', int(totals.onTime), '两段均在计划内'),
    statCard('时间不全', int(totals.incomplete), '缺出场或到件，判定待定'),
    statCard('段延误合计', `${fmt1(totals.totalDelayMinutes)} 分`, '各段超出之和', true),
  ].join('');

  const siteRows = sites
    .map((s) => ({ label: s.site, value: s.slow, handled: s.handled }))
    .filter((row) => row.handled > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  renderSiteBars($('#generate-site-chart'), siteRows, '慢段责任');

  $('#generate-segment-table').querySelector('tbody').innerHTML = segments
    .map(
      (s) => `<tr>
        <td>${esc(s.label)}</td>
        <td class="num">${int(s.complete)}</td>
        <td class="num">${int(s.slowCount)}</td>
        <td class="num">${fmt1(s.delayMinutes)}</td>
        <td>${s.incomplete > 0 ? `${int(s.incomplete)} 段尚缺时间` : '—'}</td>
      </tr>`,
    )
    .join('');

  const byMissing = { departure: 0, arrival: 0 };
  for (const s of analysis.before.shipments) {
    if (s.missing.includes('departure')) byMissing.departure += 1;
    if (s.missing.includes('arrival')) byMissing.arrival += 1;
  }
  $('#generate-missing').innerHTML = missingCount
    ? `有 <strong>${int(missingCount)}</strong> 件时间不全：缺出场 ${int(byMissing.departure)} 件，缺到件 ${int(byMissing.arrival)} 件。它们保留在结果中；补交出场后两段的归属会重新计算。`
    : '本批记录时间完整，无缺失项。';
}

function statCard(label, value, hint, hero = false) {
  return `<div class="stat${hero ? ' hero' : ''}">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    <div class="hint">${esc(hint)}</div>
  </div>`;
}

/* ---------------- late step ---------------- */

function renderLate(analysis) {
  const { totals: before } = analysis.before;
  const { totals: after } = analysis.after;
  const applied = analysis.lateAdditions.applied;
  const ignored = analysis.lateAdditions.ignored;
  const stillMissing = analysis.after.shipments.filter((s) => s.missing.length > 0);

  $('#late-badge').textContent = `应用 ${int(applied.length)} 条 · 变化 ${int(analysis.changes.length)} 件`;
  $('#late-stats').innerHTML = [
    statCard('补交条数', int(applied.length), `忽略 ${int(ignored.length)} 条`),
    statCard('慢件', `${int(before.slow)} → ${int(after.slow)}`, '补交前后'),
    statCard('时间不全', `${int(before.incomplete)} → ${int(after.incomplete)}`, '仍缺时间的件保留'),
    statCard('段延误合计', `${fmt1(before.totalDelayMinutes)} → ${fmt1(after.totalDelayMinutes)} 分`, '补交只改变归因，不制造新事实', true),
  ].join('');

  $('#late-applied').innerHTML = applied.length
    ? applied
        .map((a) => {
          const parts = [];
          if (a.departure) parts.push(`出场 ${esc(a.departure)}`);
          if (a.arrival) parts.push(`到件 ${esc(a.arrival)}`);
          if (a.destination) parts.push(`改派至 ${esc(a.destination)}`);
          if (a.reroute === true) parts.push('标记改派');
          if (a.note) parts.push(esc(a.note));
          return `<li><span class="id">${esc(a.id)}</span><div class="meta">${parts.join(' · ') || '仅更新标记'}</div></li>`;
        })
        .join('')
    : '<li class="meta">没有可应用的补交记录。</li>';

  $('#late-ignored').innerHTML = ignored.length
    ? `<div class="notice">${ignored.map((x) => `${esc(x.id)}：${esc(x.reason)}`).join('<br>')}</div>`
    : '';

  $('#late-missing').innerHTML = stillMissing.length
    ? stillMissing
        .map(
          (s) =>
            `<li><span class="id">${esc(s.id)}</span><div class="meta">缺 ${s.missing.map((m) => esc(MISSING_LABEL[m])).join('、')} 时间</div></li>`,
        )
        .join('')
    : '<li class="meta">补交后所有件时间完整。</li>';

  $('#late-changes').querySelector('tbody').innerHTML = analysis.changes.length
    ? analysis.changes
        .map((c) => {
          const route = [];
          if (c.routeChanged) {
            route.push(
              `<span class="chip reroute">改派</span> ${esc(c.beforeDestination ?? '—')}<span class="arrow">→</span>${esc(c.afterDestination ?? '—')}`,
            );
          }
          if (c.rerouteChanged) {
            route.push(`标记改为 ${c.reroute ? '是' : '否'}`);
          }
          if (!route.length) route.push('—');

          const status = c.statusChanged
            ? `${statusChip(c.beforeStatus)}<span class="arrow">→</span>${statusChip(c.afterStatus)}`
            : statusChip(c.afterStatus);

          const first = c.beforeFirstSlow === c.afterFirstSlow
            ? c.afterFirstSlow
              ? esc(segLabel(c.afterFirstSlow))
              : '—'
            : `${c.beforeFirstSlow ? esc(segLabel(c.beforeFirstSlow)) : '—'}<span class="arrow">→</span>${c.afterFirstSlow ? esc(segLabel(c.afterFirstSlow)) : '—'}`;

          const shifts = c.shifts.length
            ? c.shifts
                .map(
                  (s) =>
                    `${esc(s.label)}：${fmt1(s.before)}<span class="arrow">→</span>${fmt1(s.after)} 分`,
                )
                .join('<br>')
            : '仅路由/标记变化';

          return `<tr>
            <td><span class="id">${esc(c.id)}</span></td>
            <td>${route.join('<br>')}</td>
            <td>${status}</td>
            <td>${first}</td>
            <td>${shifts}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty-cell">本次补交没有引起段值、路由或状态变化。</td></tr>';
}

/* ---------------- segments step ---------------- */

function renderSegments(view) {
  const after = view.after;
  const consistency = after.consistency;
  const check = consistency ?? {};
  $('#segments-badge').textContent = `补交后 · ${int(view.appliedLate)} 条补交已应用`;

  const verdict = check.ok
    ? '<span class="verdict ok">✓ 两套口径合计一致</span>'
    : '<span class="verdict bad">✗ 口径合计不一致</span>';
  $('#segments-consistency').innerHTML = `
    <span>${verdict}</span>
    <span>分摊合计 <strong>${fmt1(check.spreadTotal)}</strong> 分</span>
    <span>最先超标合计 <strong>${fmt1(check.firstTotal)}</strong> 分</span>
    <span>总延误 <strong>${fmt1(check.shipmentTotal)}</strong> 分</span>
    <span>未测段 ${int(after.segments.reduce((s, x) => s + x.incomplete, 0))} 段</span>
  `;

  const series = [
    { key: 'spread', label: '分摊口径', color: '--series-1' },
    { key: 'first', label: '最先超标口径', color: '--series-2' },
  ];
  $('#attribution-legend').innerHTML = series
    .map(
      (s, i) =>
        `<span class="key"><span class="swatch s${i + 1}"></span>${esc(s.label)}</span>`,
    )
    .join('');

  const groups = after.segments.map((s) => ({
    label: s.label,
    values: { spread: s.byAttribution.spread, first: s.byAttribution.first },
  }));
  renderGroupedColumns($('#attribution-chart'), groups, series);

  $('#attribution-table').querySelector('tbody').innerHTML = after.segments
    .map(
      (s) => `<tr>
        <td>${esc(s.label)}</td>
        <td class="num">${int(s.slowCount)}</td>
        <td class="num">${fmt1(s.delayMinutes)}</td>
        <td class="num">${fmt1(s.byAttribution.spread)}</td>
        <td class="num">${fmt1(s.byAttribution.first)}</td>
        <td class="num">${int(s.incomplete)}</td>
      </tr>`,
    )
    .join('') +
    `<tr>
      <td><strong>合计</strong></td>
      <td class="num">${int(after.segments.reduce((a, s) => a + s.slowCount, 0))}</td>
      <td class="num">${fmt1(after.segments.reduce((a, s) => a + s.delayMinutes, 0))}</td>
      <td class="num">${fmt1(after.segments.reduce((a, s) => a + s.byAttribution.spread, 0))}</td>
      <td class="num">${fmt1(after.segments.reduce((a, s) => a + s.byAttribution.first, 0))}</td>
      <td class="num">${int(after.segments.reduce((a, s) => a + s.incomplete, 0))}</td>
    </tr>`;

  const siteSeries = [
    { key: 'inbound', label: '积压（出发网点）', color: '--series-1' },
    { key: 'outbound', label: '传播（目的网点）', color: '--series-2' },
  ];
  $('#site-legend').innerHTML = siteSeries
    .map(
      (s, i) =>
        `<span class="key"><span class="swatch s${i + 1}"></span>${esc(s.label)}</span>`,
    )
    .join('');

  const siteRows = after.sites
    .map((s) => ({
      label: s.site,
      inbound: s.segments.inbound_to_departure.delayMinutes,
      outbound: s.segments.departure_to_arrival.delayMinutes,
    }))
    .filter((r) => r.inbound > 0 || r.outbound > 0);
  renderStackedSites($('#site-chart'), siteRows, siteSeries);

  $('#site-table').querySelector('tbody').innerHTML = after.sites.length
    ? after.sites
        .map(
          (s) => `<tr>
            <td>${esc(s.site)}</td>
            <td class="num">${int(s.handled)}</td>
            <td class="num" title="积压 ${int(s.segments.inbound_to_departure.slow)} 段 · 传播 ${int(s.segments.departure_to_arrival.slow)} 段">${int(s.slow)}</td>
            <td class="num">${int(s.incomplete)}</td>
            <td class="num">${fmt1(s.segments.inbound_to_departure.delayMinutes)}</td>
            <td class="num">${fmt1(s.segments.departure_to_arrival.delayMinutes)}</td>
            <td class="num">${fmt1(s.totalDelayMinutes)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="empty-cell">没有网点数据。</td></tr>';

  $('#explanation-table').querySelector('tbody').innerHTML = view.after.explanation.length
    ? view.after.explanation
        .map(
          (e) => `<tr>
            <td><span class="id">${esc(e.id)}</span></td>
            <td>${esc(e.firstSlowLabel)}</td>
            <td class="num">${fmt1(e.firstDelayMinutes)}</td>
            <td class="num">${fmt1(e.totalDelayMinutes)}</td>
            <td>${e.laterSlowSegments.length ? e.laterSlowSegments.map((x) => `${esc(x.label)} +${fmt1(x.delayMinutes)} 分`).join('<br>') : '—'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty-cell">没有超标段。</td></tr>';
}

/* ---------------- actions ---------------- */

function readInputs() {
  const seed = Number($('#seed').value);
  const count = Number($('#count').value);
  if (!Number.isInteger(seed) || seed < 0) throw new Error('随机种子必须是非负整数');
  if (!Number.isInteger(count) || count < 1 || count > 500) {
    throw new Error('生成件数需为 1–500 的整数');
  }
  return { seed, count };
}

async function onGenerate() {
  setStatus('正在生成虚构记录…');
  try {
    const { seed, count } = readInputs();
    const dataset = await api(`/api/generate?seed=${seed}&count=${count}`);
    state.dataset = dataset;
    state.lateApplied = false;
    state.segmentView = null;
    state.analysis = await postJson('/api/analyze', {
      shipments: dataset.shipments,
      lateAdditions: [],
      seed: dataset.seed,
    });
    $('#step-late').hidden = true;
    $('#step-segments').hidden = true;
    renderGenerate(state.analysis);
    setPanelVisible('generate');
    setButtons();
    setStatus(
      `已生成 ${dataset.shipments.length} 件（种子 ${dataset.seed}）。下一步可「补交改派和出场」。`,
    );
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function onLate() {
  if (!state.dataset) return;
  setStatus('正在补交出场时间并重算分段…');
  try {
    state.analysis = await postJson('/api/analyze', {
      shipments: state.dataset.shipments,
      lateAdditions: state.dataset.lateAdditions,
      seed: state.dataset.seed,
    });
    state.lateApplied = true;
    state.segmentView = null;
    renderLate(state.analysis);
    setPanelVisible('late');
    setButtons();
    setStatus(
      `已应用 ${state.analysis.lateAdditions.applied.length} 条补交记录，${state.analysis.changes.length} 件发生变化。下一步可「查看段间延误」。`,
    );
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function onSegments() {
  if (!state.dataset || !state.lateApplied) return;
  setStatus('正在汇总段间延误…');
  try {
    state.segmentView = await postJson('/api/segments', {
      shipments: state.dataset.shipments,
      lateAdditions: state.dataset.lateAdditions,
      seed: state.dataset.seed,
    });
    renderSegments(state.segmentView);
    setPanelVisible('segments');
    setStatus(
      state.segmentView.after.consistency?.ok
        ? '段间延误已汇总，两套归因口径与总延误一致，未发现重复计费。'
        : '段间延误已汇总，但口径合计不一致，请检查。',
    );
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function onExport() {
  if (!state.dataset) return;
  setStatus('正在导出 CSV…');
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shipments: state.dataset.shipments,
        lateAdditions: state.lateApplied ? state.dataset.lateAdditions : [],
        seed: state.dataset.seed,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `导出失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'shipment-delay-segments.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus('CSV 已导出：时间不全的件保留，change 列记录补交/改派引起的变化。');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('shipment-theme');
  } catch {
    // 隐私模式或存储被禁用时退回系统配色，不影响业务功能。
  }
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.dataset.theme = stored;
  }
  const button = $('#theme-toggle');
  const sync = () => {
    const dark =
      document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    button.textContent = dark ? '浅色' : '深色';
  };
  button.addEventListener('click', () => {
    const dark =
      document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('shipment-theme', document.documentElement.dataset.theme);
    } catch {
      // 存不下主题偏好不影响功能。
    }
    sync();
  });
  sync();
}

$('#btn-generate').addEventListener('click', onGenerate);
$('#btn-late').addEventListener('click', onLate);
$('#btn-segments').addEventListener('click', onSegments);
$('#btn-export').addEventListener('click', onExport);
initTheme();
setButtons();
