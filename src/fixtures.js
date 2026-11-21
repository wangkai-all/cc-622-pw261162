'use strict';

/**
 * 可重复生成的虚构快件数据集。
 *
 * 使用固定种子的 mulberry32，保证同一个 seed 在任何机器上生成完全相同的记录，
 * 便于测试和页面演示时反复核对。基准日固定为 2026-11-20，结果不随运行时间漂移。
 */

const SITES = [
  { code: 'SHA-01', name: '上海虹桥中转' },
  { code: 'HGH-02', name: '杭州萧山中转' },
  { code: 'NKG-03', name: '南京禄口分拨' },
  { code: 'WUH-04', name: '武汉天河分拨' },
  { code: 'CAN-05', name: '广州白云中转' },
  { code: 'SZX-06', name: '深圳宝安分拨' },
  { code: 'CTU-07', name: '成都双流中转' },
  { code: 'XIY-08', name: '西安咸阳分拨' },
];

const SITE_BY_CODE = new Map(SITES.map((s) => [s.code, s]));

const DEFAULT_SEED = 20261121;
const DEFAULT_COUNT = 36;
const BASE_MS = Date.UTC(2026, 10, 20, 0, 0, 0);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function minutesToIso(minutes) {
  return new Date(BASE_MS + Math.round(minutes * 60000)).toISOString();
}

function siteName(code) {
  return SITE_BY_CODE.get(code)?.name ?? null;
}

/**
 * 生成一批原始记录。刻意留出几类异常：
 *  - 缺出场时间（当晚补录）
 *  - 缺到件时间（运输途中，导出时保留）
 *  - 入分拣段或出场段严重积压
 */
function generateShipments({ seed = DEFAULT_SEED, count = DEFAULT_COUNT } = {}) {
  if (!Number.isInteger(seed) || seed < 0) throw new Error('seed 必须是非负整数');
  if (!Number.isInteger(count) || count <= 0) throw new Error('count 必须是正整数');

  const rng = mulberry32(seed);
  const shipments = [];
  const departureGaps = [];
  const arrivalGaps = [];

  for (let i = 0; i < count; i += 1) {
    const origin = pick(rng, SITES);
    let destination = pick(rng, SITES);
    if (destination.code === origin.code) {
      destination = SITES[(SITES.indexOf(origin) + 1) % SITES.length];
    }

    const planIn = pick(rng, [45, 60, 75, 90]);
    const planOut = pick(rng, [120, 150, 180, 210]);

    // 约 1/5 的件入分拣段积压，约 1/5 的件出场段积压，其余正常。
    const roll = rng();
    const inFactor = roll < 0.2 ? 1.8 + rng() * 1.6 : 0.55 + rng() * 0.45;
    const outFactor =
      roll >= 0.2 && roll < 0.4 ? 1.7 + rng() * 1.3 : 0.5 + rng() * 0.6;

    const inboundMin = 8 * 60 + rng() * 10 * 60; // 08:00–18:00
    const departureMin = inboundMin + planIn * inFactor;
    const arrivalMin = departureMin + planOut * outFactor;

    const id = `SF${String(102400 + i).padStart(10, '0')}`;
    // 出场漏扫（当晚补录）和到件未到（导出时保留）是两类不同缺口：
    // 前者到件通常仍已扫描，补上出场后两段都变得可测；后者会一直缺到件。
    const missingDeparture = rng() < 0.1;
    const missingArrival = !missingDeparture && rng() < 0.1;

    const spec = {
      id,
      origin: origin.code,
      originName: origin.name,
      destination: destination.code,
      destinationName: destination.name,
      reroute: false,
      plan: { inbound_to_departure: planIn, departure_to_arrival: planOut },
      inbound: minutesToIso(inboundMin),
      departure: missingDeparture ? null : minutesToIso(departureMin),
      arrival: missingArrival ? null : minutesToIso(arrivalMin),
    };
    if (missingDeparture) {
      spec.plannedDeparture = minutesToIso(departureMin);
      departureGaps.push(id);
    } else if (missingArrival) {
      spec.plannedArrival = minutesToIso(arrivalMin);
      arrivalGaps.push(id);
    }
    shipments.push(spec);
  }

  // 保证至少一条缺出场记录存在，供“补交出场”演示；若随机没抽中则改写最后一条。
  if (departureGaps.length === 0 && count >= 2) {
    const s = shipments[count - 1];
    s.plannedDeparture = s.departure;
    s.departure = null;
    departureGaps.push(s.id);
  }
  // 保证至少一条缺到件记录，验证导出仍保留时间不全的件。
  if (arrivalGaps.length === 0) {
    const target = shipments.find(
      (s) => s.departure && s.arrival && !departureGaps.includes(s.id),
    );
    if (target) {
      target.plannedArrival = target.arrival;
      target.arrival = null;
      arrivalGaps.push(target.id);
    }
  }

  // 指定一条正常件作为改派对象，供“补交改派”演示。
  const rerouteTarget = shipments.find((s) => s.departure && s.arrival);
  const reroute =
    rerouteTarget === undefined
      ? null
      : {
          id: rerouteTarget.id,
          // 备用网点：既不是出发地也不是原目的地。
          destination:
            SITES.find(
              (site) =>
                site.code !== rerouteTarget.origin &&
                site.code !== rerouteTarget.destination,
            )?.code ?? null,
        };

  return {
    shipments,
    meta: {
      seed,
      count,
      businessDate: '2026-11-20',
      plannedReroute: reroute,
      departureGaps,
      arrivalGaps,
    },
  };
}

/**
 * 构造“当晚补交”的事件：
 *  1. 为大部分缺出场的件补上出场与到件时间；
 *  2. 对其中一条标记改派并改到备用网点；
 *  3. 留一条缺出场的件不补，验证导出仍保留时间不全的件。
 */
function generateLateAdditions(dataset) {
  const { shipments, meta } = dataset;
  const additions = [];
  const byId = new Map(shipments.map((s) => [s.id, s]));
  const gaps = meta.departureGaps;

  const toFill = gaps.length > 1 ? gaps.slice(0, -1) : gaps;
  for (const [i, id] of toFill.entries()) {
    const s = byId.get(id);
    if (!s) continue;
    // 补录时间以当时计划出场时间为基准，偶数条落在阈值内、奇数条超出，
    // 制造“补录后由未知转慢”和“补录后仍正常”两种结果。
    const slack = i % 2 === 0 ? 0.85 : 1.25;
    const plannedDepartureMs = Date.parse(s.plannedDeparture);
    const departure = new Date(
      Date.parse(s.inbound) +
        (plannedDepartureMs - Date.parse(s.inbound)) * slack,
    ).toISOString();
    additions.push({
      id,
      departure,
      arrival: s.plannedArrival,
      reroute: false,
      note: '夜班补录出场与到件时间',
    });
  }

  const reroute = meta.plannedReroute;
  if (reroute && reroute.destination) {
    additions.push({
      id: reroute.id,
      reroute: true,
      destination: reroute.destination,
      note: '航段取消，改派至备用分拨',
    });
  }

  return { additions, meta: { unfilled: gaps.length > 1 ? gaps.slice(-1) : [] } };
}

/** 使用默认参数一次性拿到可演示的数据与补交事件。 */
function demoDataset(options = {}) {
  const dataset = generateShipments(options);
  const late = generateLateAdditions(dataset);
  return {
    seed: dataset.meta.seed,
    count: dataset.meta.count,
    businessDate: dataset.meta.businessDate,
    shipments: dataset.shipments,
    lateAdditions: late.additions,
    meta: { ...dataset.meta, unfilledAfterLate: late.meta.unfilled },
  };
}

module.exports = {
  SITES,
  DEFAULT_SEED,
  DEFAULT_COUNT,
  mulberry32,
  generateShipments,
  generateLateAdditions,
  demoDataset,
  siteName,
};
