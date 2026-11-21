'use strict';

/**
 * 快件段间延误分析模型。
 *
 * 一条快件的生命周期按三个时间点切分成两段：
 *   inbound  入分拣  -> departure  出场
 *   departure 出场  -> arrival    到件
 *
 * 任何一段的实测耗时超过该段计划耗时（阈值）即视为“慢件”，
 * 超标的那一段就是“最先超标段”。
 *
 * 晚补的出场时间只会影响“入分拣->出场”和“出场->到件”这两段的
 * 归因，不会改变已发生的到件事实；缺时间的件保留在结果里并标注。
 */

const SEGMENTS = Object.freeze(['inbound_to_departure', 'departure_to_arrival']);

const SEGMENT_LABELS = Object.freeze({
  inbound_to_departure: '入分拣→出场',
  departure_to_arrival: '出场→到件',
});

const STATUS = Object.freeze({
  ON_TIME: 'on_time',
  SLOW: 'slow',
  INCOMPLETE: 'incomplete',
});

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 以 0.1 分钟为最小单位求和，避免浮点误差让两套口径“差 0.1”。 */
function sum1(values) {
  const tenths = values.reduce((sum, v) => sum + Math.round((v ?? 0) * 10), 0);
  return tenths / 10;
}

function toTime(value, field, id) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`快件 ${id} 的 ${field} 时间无法解析: ${String(value)}`);
  }
  return ms;
}

function nonNegativeNumber(value, field, id, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`快件 ${id} 的 ${field} 必须是非负数: ${String(value)}`);
  }
  return n;
}

/**
 * 构造一条快件的归段路径。
 *
 * spec: {
 *   id, origin, destination,
 *   inbound, departure, arrival,          // ISO 字符串 / Date / null
 *   plan: { inbound_to_departure, departure_to_arrival },  // 分钟
 *   reroute: boolean                       // 改派标记（可选）
 * }
 */
function buildShipment(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('快件记录必须是对象');
  const id = String(spec.id ?? '').trim();
  if (!id) throw new Error('快件记录缺少 id');

  const inbound = toTime(spec.inbound, 'inbound', id);
  const departure = toTime(spec.departure, 'departure', id);
  const arrival = toTime(spec.arrival, 'arrival', id);

  const planIn = nonNegativeNumber(
    spec.plan?.inbound_to_departure,
    'plan.inbound_to_departure',
    id,
    0,
  );
  const planOut = nonNegativeNumber(
    spec.plan?.departure_to_arrival,
    'plan.departure_to_arrival',
    id,
    0,
  );

  const segments = SEGMENTS.map((key) => {
    const start = key === 'inbound_to_departure' ? inbound : departure;
    const end = key === 'inbound_to_departure' ? departure : arrival;
    const planMinutes =
      key === 'inbound_to_departure' ? planIn : planOut;
    const complete = start !== null && end !== null;
    let actualMinutes = null;
    let delayMinutes = null;
    let slow = false;

    if (complete) {
      if (end < start) {
        throw new Error(
          `快件 ${id} 的 ${SEGMENT_LABELS[key]} 时间倒挂: 结束早于开始`,
        );
      }
      // 统一保留一位小数，保证“分摊合计”和“最先超标合计”逐分对得上。
      actualMinutes = round1((end - start) / 60000);
      delayMinutes = round1(Math.max(0, actualMinutes - planMinutes));
      slow = actualMinutes > planMinutes;
    }

    return {
      key,
      label: SEGMENT_LABELS[key],
      start: start === null ? null : new Date(start).toISOString(),
      end: end === null ? null : new Date(end).toISOString(),
      planMinutes,
      actualMinutes,
      delayMinutes,
      slow,
      complete,
    };
  });

  const missing = [];
  if (inbound === null) missing.push('inbound');
  if (departure === null) missing.push('departure');
  if (arrival === null) missing.push('arrival');

  const slowSegments = segments.filter((s) => s.slow);
  const incomplete = segments.some((s) => !s.complete);

  let status;
  if (incomplete) status = STATUS.INCOMPLETE;
  else if (slowSegments.length > 0) status = STATUS.SLOW;
  else status = STATUS.ON_TIME;

  // 总延误按段汇总：每段只贡献自己超出的分钟数，避免同一段既算“分摊”又算“解释”时重复计数。
  const totalDelayMinutes = sum1(segments.map((s) => s.delayMinutes));

  const firstSlow = slowSegments[0] ?? null;

  return {
    id,
    origin: spec.origin ?? null,
    destination: spec.destination ?? null,
    times: {
      inbound: inbound === null ? null : new Date(inbound).toISOString(),
      departure: departure === null ? null : new Date(departure).toISOString(),
      arrival: arrival === null ? null : new Date(arrival).toISOString(),
    },
    missing,
    reroute: Boolean(spec.reroute),
    plan: { inbound_to_departure: planIn, departure_to_arrival: planOut },
    segments,
    status,
    // 是否至少有一段实测超标（缺时间的件也可能已测出某段超标）。
    slow: slowSegments.length > 0,
    totalDelayMinutes,
    // 最先超标段：只记录“第一个”超标的段，用于解释口径。
    firstSlowSegment: firstSlow ? firstSlow.key : null,
  };
}

function buildShipments(specs) {
  if (!Array.isArray(specs)) throw new Error('快件集合必须是数组');
  const seen = new Set();
  return specs.map((spec) => {
    const s = buildShipment(spec);
    if (seen.has(s.id)) throw new Error(`重复的快件编号: ${s.id}`);
    seen.add(s.id);
    return s;
  });
}

module.exports = {
  SEGMENTS,
  SEGMENT_LABELS,
  STATUS,
  buildShipment,
  buildShipments,
  toTime,
  computeSegmentStats,
  computeSiteReport,
  analyzeShipments,
};

/**
 * 按段汇总延误。attribution 两套口径都从“段自身的 delayMinutes”派生，
 * 因此两套口径各自的合计都等于 totalDelayMinutes，不会把总延误多算。
 */
function computeSegmentStats(shipments) {
  const stats = {};
  for (const key of SEGMENTS) {
    stats[key] = {
      key,
      label: SEGMENT_LABELS[key],
      measured: 0,
      complete: 0,
      slowCount: 0,
      delayMinutes: 0,
      byAttribution: { spread: 0, first: 0 },
    };
  }

  for (const s of shipments) {
    for (const seg of s.segments) {
      const stat = stats[seg.key];
      stat.measured += 1;
      if (!seg.complete) continue;
      stat.complete += 1;
      if (!seg.slow) continue;
      stat.slowCount += 1;
      stat.delayMinutes += seg.delayMinutes;
      // 分摊口径：每段只承担自己超出的分钟。
      stat.byAttribution.spread += seg.delayMinutes;
    }
    // 最先超标口径：整件的延误全部记到最先超标的那一段，
    // 后一段就不再被视为原因。因为一件的 totalDelay 就是各段延误之和，
    // 所以该口径的合计与分摊口径完全相同，不会多算。
    if (s.firstSlowSegment) {
      const stat = stats[s.firstSlowSegment];
      stat.byAttribution.first += s.totalDelayMinutes;
    }
  }

  return SEGMENTS.map((key) => {
    const s = stats[key];
    return {
      ...s,
      delayMinutes: s.delayMinutes,
      byAttribution: {
        spread: s.byAttribution.spread,
        first: s.byAttribution.first,
      },
      incomplete: s.measured - s.complete,
      avgDelayMinutes: s.slowCount ? round1(s.delayMinutes / s.slowCount) : 0,
    };
  });
}

/**
 * 网点视角：出发网点承担“入分拣→出场”的积压，
 * 目的网点承担“出场→到件”的传播。
 * 慢件数按“慢段归属”统计，而非按整件状态，避免同一件在两个网点各记一次。
 */
function computeSiteReport(shipments) {
  const sites = new Map();
  const site = (name) => {
    const key = name || '(未填写)';
    if (!sites.has(key)) {
      sites.set(key, {
        site: key,
        handled: 0,
        slow: 0,
        slowShipments: 0,
        incomplete: 0,
        totalDelayMinutes: 0,
        segments: {
          inbound_to_departure: { slow: 0, delayMinutes: 0 },
          departure_to_arrival: { slow: 0, delayMinutes: 0 },
        },
      });
    }
    return sites.get(key);
  };

  for (const s of shipments) {
    const originEntry = site(s.origin);
    const destEntry = site(s.destination);
    originEntry.handled += 1;
    if (destEntry !== originEntry) destEntry.handled += 1;

    // 缺出场时间归出发网点，缺到件时间归目的网点。
    if (s.missing.includes('departure')) originEntry.incomplete += 1;
    if (s.missing.includes('arrival')) destEntry.incomplete += 1;

    const [inSeg, outSeg] = s.segments;
    if (inSeg.complete && inSeg.slow) {
      originEntry.slow += 1;
      originEntry.segments.inbound_to_departure.slow += 1;
      originEntry.segments.inbound_to_departure.delayMinutes += inSeg.delayMinutes;
      originEntry.totalDelayMinutes += inSeg.delayMinutes;
    }
    if (outSeg.complete && outSeg.slow) {
      destEntry.slow += 1;
      destEntry.segments.departure_to_arrival.slow += 1;
      destEntry.segments.departure_to_arrival.delayMinutes += outSeg.delayMinutes;
      destEntry.totalDelayMinutes += outSeg.delayMinutes;
    }
    if (s.slow) {
      if (inSeg.slow) originEntry.slowShipments += 1;
      if (outSeg.slow) destEntry.slowShipments += 1;
    }
  }

  return [...sites.values()]
    .map((entry) => ({
      ...entry,
      totalDelayMinutes: sum1([entry.totalDelayMinutes]),
      avgDelayMinutes: entry.handled
        ? round1(entry.totalDelayMinutes / entry.handled)
        : 0,
    }))
    .sort(
      (a, b) =>
        b.totalDelayMinutes - a.totalDelayMinutes ||
        a.site.localeCompare(b.site),
    );
}

/**
 * 全量分析。lateAdditions 是“当晚补交的出场时间”，按 id 覆盖原记录，
 * 并返回变化前后的差异，供页面展示改派/补录引起的变化。
 */
function analyzeShipments(originalSpecs, lateAdditions = [], options = {}) {
  const before = buildShipments(originalSpecs);

  const applied = [];
  const ignored = [];
  const mergedSpecs = originalSpecs.map((s) => ({ ...s }));

  for (const addition of lateAdditions) {
    const id = String(addition?.id ?? '').trim();
    const idx = mergedSpecs.findIndex((s) => String(s.id).trim() === id);
    if (!id || idx === -1) {
      ignored.push({ id: id || '(空)', reason: '原记录中不存在该快件，已忽略' });
      continue;
    }
    // 以已应用的结果为基准，允许多条补交叠加到同一件上。
    const patch = {};
    for (const field of ['departure', 'arrival']) {
      if (addition[field] !== undefined && addition[field] !== null && addition[field] !== '') {
        patch[field] = addition[field];
      }
    }
    for (const field of ['origin', 'destination']) {
      if (typeof addition[field] === 'string' && addition[field].trim()) {
        patch[field] = addition[field].trim();
      }
    }
    if (typeof addition.reroute === 'boolean') patch.reroute = addition.reroute;
    if (addition.plan && typeof addition.plan === 'object') patch.plan = addition.plan;
    if (Object.keys(patch).length === 0) {
      ignored.push({ id, reason: '补交记录没有任何可应用字段' });
      continue;
    }
    const record = { id, ...patch };
    if (typeof addition.note === 'string' && addition.note.trim()) {
      record.note = addition.note.trim();
    }
    applied.push(record);
    mergedSpecs[idx] = {
      ...mergedSpecs[idx],
      ...patch,
      plan: { ...(mergedSpecs[idx].plan ?? {}), ...(patch.plan ?? {}) },
    };
  }

  const after = buildShipments(mergedSpecs);
  const byId = new Map(before.map((s) => [s.id, s]));
  const changes = after
    .map((now) => {
      const prev = byId.get(now.id);
      const shifts = SEGMENTS.map((key) => {
        const was = prev.segments.find((seg) => seg.key === key);
        const is = now.segments.find((seg) => seg.key === key);
        return {
          key,
          label: SEGMENT_LABELS[key],
          before: was.actualMinutes,
          after: is.actualMinutes,
          beforeDelay: was.delayMinutes,
          afterDelay: is.delayMinutes,
          changed:
            was.actualMinutes !== is.actualMinutes ||
            was.slow !== is.slow ||
            was.planMinutes !== is.planMinutes,
        };
      }).filter((x) => x.changed);
      const routeChanged =
        prev.origin !== now.origin || prev.destination !== now.destination;
      return {
        id: now.id,
        origin: now.origin,
        beforeDestination: prev.destination,
        afterDestination: now.destination,
        beforeStatus: prev.status,
        afterStatus: now.status,
        beforeFirstSlow: prev.firstSlowSegment,
        afterFirstSlow: now.firstSlowSegment,
        reroute: now.reroute,
        rerouteChanged: prev.reroute !== now.reroute,
        routeChanged,
        statusChanged: prev.status !== now.status,
        shifts,
      };
    })
    .filter(
      (c) =>
        c.shifts.length > 0 ||
        c.rerouteChanged ||
        c.routeChanged ||
        c.statusChanged,
    );

  const totalsBefore = summarize(before);
  const totalsAfter = summarize(after);

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    seed: options.seed ?? null,
    before: {
      shipments: before,
      totals: totalsBefore,
      segments: computeSegmentStats(before),
      sites: computeSiteReport(before),
    },
    after: {
      shipments: after,
      totals: totalsAfter,
      segments: computeSegmentStats(after),
      sites: computeSiteReport(after),
    },
    lateAdditions: { applied, ignored },
    changes,
    consistency: {
      before: consistencyCheck(before, totalsBefore),
      after: consistencyCheck(after, totalsAfter),
    },
  };
}

function summarize(shipments) {
  return {
    count: shipments.length,
    slow: shipments.filter((s) => s.status === STATUS.SLOW).length,
    onTime: shipments.filter((s) => s.status === STATUS.ON_TIME).length,
    incomplete: shipments.filter((s) => s.status === STATUS.INCOMPLETE).length,
    totalDelayMinutes: sum1(shipments.map((s) => s.totalDelayMinutes)),
  };
}

/**
 * 自检：分摊口径合计 == 最先超标口径合计 == 各件段延误合计。
 * 任一不成立即说明有段被重复计费。
 */
function consistencyCheck(shipments, totals = summarize(shipments)) {
  const segments = computeSegmentStats(shipments);
  const spread = sum1(segments.map((s) => s.byAttribution.spread));
  const first = sum1(segments.map((s) => s.byAttribution.first));
  const shipmentTotal = totals.totalDelayMinutes;
  return {
    ok: spread === shipmentTotal && first === shipmentTotal,
    spreadTotal: spread,
    firstTotal: first,
    shipmentTotal,
  };
}

