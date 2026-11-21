'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildShipment,
  buildShipments,
  analyzeShipments,
  computeSegmentStats,
  STATUS,
} = require('../src/segmenter');
const {
  generateShipments,
  generateLateAdditions,
  demoDataset,
  DEFAULT_SEED,
} = require('../src/fixtures');
const { createServer, buildCsv, buildSegmentView } = require('../server');

const T = (iso) => iso;

function baseSpec(overrides = {}) {
  return {
    id: 'SF-TEST-0001',
    origin: 'SHA-01',
    destination: 'HGH-02',
    inbound: T('2026-11-20T08:00:00.000Z'),
    departure: T('2026-11-20T09:00:00.000Z'),
    arrival: T('2026-11-20T12:00:00.000Z'),
    plan: { inbound_to_departure: 60, departure_to_arrival: 180 },
    ...overrides,
  };
}

test('两段时间都在计划内时为正常件', () => {
  const s = buildShipment(baseSpec());
  assert.equal(s.status, STATUS.ON_TIME);
  assert.equal(s.slow, false);
  assert.equal(s.totalDelayMinutes, 0);
  assert.equal(s.firstSlowSegment, null);
  assert.deepEqual(s.missing, []);
  assert.equal(s.segments[0].actualMinutes, 60);
  assert.equal(s.segments[1].actualMinutes, 180);
});

test('只有入分拣段超标时，最先超标段是入分拣段', () => {
  const s = buildShipment(
    baseSpec({ departure: T('2026-11-20T09:30:00.000Z'), arrival: T('2026-11-20T12:30:00.000Z') }),
  );
  assert.equal(s.status, STATUS.SLOW);
  assert.equal(s.segments[0].delayMinutes, 30);
  assert.equal(s.segments[1].delayMinutes, 0);
  assert.equal(s.firstSlowSegment, 'inbound_to_departure');
  assert.equal(s.totalDelayMinutes, 30);
});

test('两段都超标时最先超标段仍是前一段，总延误是两段之和', () => {
  const s = buildShipment(
    baseSpec({ departure: T('2026-11-20T09:30:00.000Z'), arrival: T('2026-11-20T13:00:00.000Z') }),
  );
  assert.equal(s.status, STATUS.SLOW);
  assert.equal(s.segments[0].delayMinutes, 30);
  assert.equal(s.segments[1].delayMinutes, 30);
  assert.equal(s.firstSlowSegment, 'inbound_to_departure');
  assert.equal(s.totalDelayMinutes, 60);
});

test('只超出 1 分钟也算慢件，边界值按大于计划判定', () => {
  const onEdge = buildShipment(baseSpec());
  assert.equal(onEdge.slow, false);
  const over = buildShipment(
    baseSpec({ arrival: T('2026-11-20T12:01:00.000Z') }),
  );
  assert.equal(over.slow, true);
  assert.equal(over.segments[1].delayMinutes, 1);
});

test('缺出场时间时保留该件，标记时间不全且两段均不可测', () => {
  const s = buildShipment(baseSpec({ departure: null }));
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.equal(s.slow, false);
  assert.deepEqual(s.missing, ['departure']);
  assert.equal(s.segments[0].complete, false);
  assert.equal(s.segments[1].complete, false);
  assert.equal(s.segments[0].actualMinutes, null);
  assert.equal(s.totalDelayMinutes, 0);
  assert.equal(s.times.departure, null);
});

test('缺到件时间时保留该件，但入分拣段仍可测', () => {
  const s = buildShipment(baseSpec({ arrival: null }));
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.deepEqual(s.missing, ['arrival']);
  assert.equal(s.segments[0].complete, true);
  assert.equal(s.segments[1].complete, false);
  assert.ok(s.segments[0].actualMinutes !== null);
});

test('缺少到件时间但某段已超标时，slow 仍反映已测事实', () => {
  const s = buildShipment(
    baseSpec({ departure: T('2026-11-20T09:45:00.000Z'), arrival: null }),
  );
  assert.equal(s.status, STATUS.INCOMPLETE);
  assert.equal(s.slow, true);
  assert.equal(s.firstSlowSegment, 'inbound_to_departure');
});

test('无法解析的时间抛出明确错误', () => {
  assert.throws(
    () => buildShipment(baseSpec({ inbound: 'not-a-date' })),
    /无法解析/,
  );
});

test('结束时间早于开始时间视为倒挂并报错', () => {
  assert.throws(
    () => buildShipment(baseSpec({ arrival: T('2026-11-20T07:00:00.000Z') })),
    /时间倒挂/,
  );
});

test('负数计划时长被拒绝', () => {
  assert.throws(
    () => buildShipment(baseSpec({ plan: { inbound_to_departure: -5, departure_to_arrival: 60 } })),
    /必须是非负数/,
  );
});

test('缺少 id 或重复 id 被拒绝，错误信息包含编号', () => {
  assert.throws(() => buildShipment(baseSpec({ id: '  ' })), /缺少 id/);
  assert.throws(
    () => buildShipments([baseSpec(), baseSpec()]),
    /重复的快件编号: SF-TEST-0001/,
  );
});

test('晚补出场时间会同时改写相邻两段，并改变最先超标段', () => {
  const original = baseSpec({
    departure: null,
    arrival: '2026-11-20T13:30:00.000Z',
    plan: { inbound_to_departure: 60, departure_to_arrival: 180 },
  });
  const result = analyzeShipments([original], [
    { id: 'SF-TEST-0001', departure: '2026-11-20T10:00:00.000Z' },
  ]);
  const before = result.before.shipments[0];
  const after = result.after.shipments[0];
  assert.equal(before.status, STATUS.INCOMPLETE);
  assert.equal(after.status, STATUS.SLOW);
  assert.equal(after.segments[0].actualMinutes, 120);
  assert.equal(after.segments[1].actualMinutes, 210);
  assert.equal(after.firstSlowSegment, 'inbound_to_departure');
  assert.deepEqual(
    result.changes[0].shifts.map((s) => s.key),
    ['inbound_to_departure', 'departure_to_arrival'],
  );
  assert.equal(result.changes[0].beforeStatus, STATUS.INCOMPLETE);
  assert.equal(result.changes[0].afterStatus, STATUS.SLOW);
});

test('补交未知编号被忽略并给出原因，不影响结果', () => {
  const result = analyzeShipments([baseSpec()], [
    { id: 'SF-NOT-EXIST', departure: '2026-11-20T10:00:00.000Z' },
    { id: 'SF-TEST-0001' },
  ]);
  assert.equal(result.lateAdditions.applied.length, 0);
  assert.equal(result.lateAdditions.ignored.length, 2);
  assert.match(result.lateAdditions.ignored[0].reason, /不存在/);
  assert.match(result.lateAdditions.ignored[1].reason, /没有任何可应用字段/);
  assert.equal(result.after.totals.totalDelayMinutes, result.before.totals.totalDelayMinutes);
});

test('同一件的多条补交可以叠加，后者基于前者结果应用', () => {
  const spec = baseSpec({ departure: null, arrival: '2026-11-20T13:00:00.000Z' });
  const result = analyzeShipments([spec], [
    { id: 'SF-TEST-0001', departure: '2026-11-20T10:00:00.000Z' },
    { id: 'SF-TEST-0001', reroute: true, destination: 'CAN-05' },
  ]);
  const after = result.after.shipments[0];
  assert.equal(after.reroute, true);
  assert.equal(after.destination, 'CAN-05');
  assert.equal(after.status, STATUS.SLOW);
  assert.equal(after.segments[0].actualMinutes, 120);
  assert.equal(result.lateAdditions.applied.length, 2);
  assert.equal(result.lateAdditions.ignored.length, 0);
});

test('改派会改变归属网点并标记路由变化，即使时长不变', () => {  const result = analyzeShipments([baseSpec()], [
    { id: 'SF-TEST-0001', reroute: true, destination: 'CAN-05' },
  ]);
  const change = result.changes.find((c) => c.id === 'SF-TEST-0001');
  assert.ok(change);
  assert.equal(change.routeChanged, true);
  assert.equal(change.rerouteChanged, true);
  assert.equal(change.beforeDestination, 'HGH-02');
  assert.equal(change.afterDestination, 'CAN-05');
  assert.equal(change.shifts.length, 0);

  const can = result.after.sites.find((s) => s.site === 'CAN-05');
  assert.ok(can);
  assert.equal(can.handled, 1);
});

test('两套归因口径合计都等于总延误，不多算', () => {
  const specs = [
    baseSpec({ id: 'A' }),
    baseSpec({ id: 'B', departure: '2026-11-20T09:30:00.000Z' }),
    baseSpec({
      id: 'C',
      departure: '2026-11-20T09:30:00.000Z',
      arrival: '2026-11-20T14:00:00.000Z',
    }),
    baseSpec({ id: 'D', departure: null }),
  ];
  const shipments = buildShipments(specs);
  const segments = computeSegmentStats(shipments);
  const total = shipments.reduce((sum, s) => sum + s.totalDelayMinutes, 0);
  const spread = segments.reduce((sum, s) => sum + s.byAttribution.spread, 0);
  const first = segments.reduce((sum, s) => sum + s.byAttribution.first, 0);
  assert.equal(Math.round(spread * 10), Math.round(total * 10));
  assert.equal(Math.round(first * 10), Math.round(total * 10));
});

test('最先超标口径把整件延误记到首段，后续段不再重复承担', () => {
  const s = buildShipment(
    baseSpec({ departure: '2026-11-20T09:30:00.000Z', arrival: '2026-11-20T13:00:00.000Z' }),
  );
  const [inSeg, outSeg] = computeSegmentStats([s]);
  assert.equal(inSeg.byAttribution.first, 60);
  assert.equal(outSeg.byAttribution.first, 0);
  assert.equal(inSeg.byAttribution.spread, 30);
  assert.equal(outSeg.byAttribution.spread, 30);
});

test('网点视角把积压记在出发网点、传播记在目的网点', () => {
  const spec = baseSpec({
    departure: '2026-11-20T09:30:00.000Z',
    arrival: '2026-11-20T13:00:00.000Z',
  });
  const sites = analyzeShipments([spec]).after.sites;
  const origin = sites.find((x) => x.site === 'SHA-01');
  const dest = sites.find((x) => x.site === 'HGH-02');
  assert.equal(origin.segments.inbound_to_departure.delayMinutes, 30);
  assert.equal(origin.segments.departure_to_arrival.delayMinutes, 0);
  assert.equal(dest.segments.inbound_to_departure.delayMinutes, 0);
  assert.equal(dest.segments.departure_to_arrival.delayMinutes, 30);
  // 整件只算一次慢件，但每个网点各有一个慢段责任。
  assert.equal(origin.slow, 1);
  assert.equal(dest.slow, 1);
  assert.equal(origin.slowShipments, 1);
  assert.equal(dest.slowShipments, 1);
  assert.equal(origin.totalDelayMinutes + dest.totalDelayMinutes, 60);
});

test('网点慢件数按段归属统计，同一件不会在两个网点重复计入', () => {
  const specs = [
    baseSpec({ id: 'X', departure: '2026-11-20T09:30:00.000Z' }), // 只积压
    baseSpec({ id: 'Y', arrival: '2026-11-20T12:30:00.000Z' }), // 只传播
    baseSpec({ id: 'Z', departure: null, arrival: null }), // 缺时间归出发网点
  ];
  const sites = analyzeShipments(specs).after.sites;
  const origin = sites.find((x) => x.site === 'SHA-01');
  const dest = sites.find((x) => x.site === 'HGH-02');
  assert.equal(origin.slow, 1);
  assert.equal(origin.slowShipments, 1);
  assert.equal(origin.incomplete, 1);
  assert.equal(dest.slow, 1);
  assert.equal(dest.slowShipments, 1);
  // Z 同时缺出场与到件：出发网点记「缺出场」，目的网点记「缺到件」。
  assert.equal(dest.incomplete, 1);
});

test('同一 seed 生成完全相同的记录，不同 seed 会变化', () => {
  const a = generateShipments({ seed: 1234, count: 12 });
  const b = generateShipments({ seed: 1234, count: 12 });
  const c = generateShipments({ seed: 4321, count: 12 });
  assert.deepEqual(a.shipments, b.shipments);
  assert.notDeepEqual(a.shipments, c.shipments);
});

test('演示数据集包含缺出场、缺到件和待改派件，补交后仍保留时间不全的件', () => {
  const demo = demoDataset({ seed: DEFAULT_SEED });
  assert.ok(demo.meta.departureGaps.length > 0);
  assert.ok(demo.meta.arrivalGaps.length > 0);
  assert.ok(demo.lateAdditions.length > 0);

  const result = analyzeShipments(demo.shipments, demo.lateAdditions);
  const incompleteAfter = result.after.shipments.filter(
    (s) => s.status === STATUS.INCOMPLETE,
  );
  assert.ok(incompleteAfter.length > 0, '导出/分析应保留时间不全的件');
  assert.equal(result.after.shipments.length, demo.shipments.length);
  assert.ok(result.consistency.before.ok);
  assert.ok(result.consistency.after.ok);
});

test('演示数据规模与种子可参数化，非法参数被拒绝', () => {
  const small = generateShipments({ seed: 7, count: 5 });
  assert.equal(small.shipments.length, 5);
  assert.throws(() => generateShipments({ seed: 1, count: 0 }), /正整数/);
  assert.throws(() => generateShipments({ seed: -1 }), /非负整数/);
  const noLate = generateLateAdditions({
    shipments: [],
    meta: { departureGaps: [], plannedReroute: null },
  });
  assert.deepEqual(noLate.additions, []);
});

test('CSV 导出保留时间不全的件，并写出 change 列', () => {
  const demo = demoDataset();
  const result = analyzeShipments(demo.shipments, demo.lateAdditions);
  const csv = buildCsv(result);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, demo.shipments.length + 1);
  assert.match(lines[0], /missing_time/);
  assert.match(lines[0], /change/);
  assert.match(csv, /时间不全/);
  const rerouteLine = lines.find((l) => l.includes('改派'));
  assert.ok(rerouteLine, 'CSV 应展示改派引起的变化');
  const missingLine = lines.find((l) => /时间不全/.test(l));
  assert.ok(missingLine);
});

test('buildSegmentView 返回前后两个快照和变化清单', () => {
  const demo = demoDataset();
  const view = buildSegmentView(
    analyzeShipments(demo.shipments, demo.lateAdditions, { seed: demo.seed }),
  );
  assert.ok(view.before && view.after);
  assert.ok(view.after.consistency.ok);
  assert.equal(view.before.segments.length, 2);
  assert.ok(Array.isArray(view.after.explanation));
  assert.ok(view.after.explanation.length > 0);
  assert.ok(view.labels.every((l) => l.label));
});

/* ---------------- HTTP ---------------- */

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET / 返回页面并带 data-evidence-result 业务结果区', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /data-evidence-result/);
    assert.match(html, /生成原慢件分布/);
    assert.match(html, /补交改派和出场/);
    assert.match(html, /查看段间延误/);
  });
});

test('GET /api/generate 返回可重复的演示数据', async () => {
  await withServer(async (base) => {
    const a = await fetch(`${base}/api/generate?seed=99&count=6`).then((r) => r.json());
    const b = await fetch(`${base}/api/generate?seed=99&count=6`).then((r) => r.json());
    assert.equal(a.shipments.length, 6);
    assert.deepEqual(a.shipments, b.shipments);
    assert.ok(a.lateAdditions.length > 0);
  });
});

test('GET /api/generate 的非法参数返回 400', async () => {
  await withServer(async (base) => {
    const badSeed = await fetch(`${base}/api/generate?seed=abc`);
    assert.equal(badSeed.status, 400);
    assert.match((await badSeed.json()).error, /seed/);
    const badCount = await fetch(`${base}/api/generate?count=0`);
    assert.equal(badCount.status, 400);
  });
});

test('POST /api/analyze 正常分析并返回一致性自检', async () => {
  await withServer(async (base) => {
    const demo = demoDataset();
    const res = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipments: demo.shipments, lateAdditions: demo.lateAdditions }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.consistency.after.ok);
    assert.ok(body.changes.length > 0);
  });
});

test('POST /api/analyze 对非法数据返回 400 与可读错误', async () => {
  await withServer(async (base) => {
    const cases = [
      { shipments: [] },
      { shipments: [baseSpec({ inbound: 'oops' })] },
      { shipments: [baseSpec(), baseSpec()] },
      { shipments: [baseSpec()], lateAdditions: 'nope' },
      null,
      [],
    ];
    for (const payload of cases) {
      const res = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, JSON.stringify(payload));
      const body = await res.json();
      assert.ok(body.error);
    }
  });
});

test('补交出场的非法时间会整体返回 400，而不是悄悄丢弃', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shipments: [baseSpec({ departure: null })],
        lateAdditions: [{ id: 'SF-TEST-0001', departure: 'yesterday-ish' }],
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /无法解析/);
  });
});

test('POST /api/analyze 对非法 JSON 返回 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  });
});

test('POST /api/segments 返回两套口径与解释清单', async () => {
  await withServer(async (base) => {
    const demo = demoDataset();
    const res = await fetch(`${base}/api/segments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipments: demo.shipments, lateAdditions: demo.lateAdditions }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.after.consistency.ok);
    assert.equal(body.after.segments.length, 2);
    assert.ok(body.after.sites.length > 0);
    assert.ok(body.after.explanation.length > 0);
  });
});

test('POST /api/export 返回含全部快件的 CSV', async () => {
  await withServer(async (base) => {
    const demo = demoDataset();
    const res = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipments: demo.shipments, lateAdditions: demo.lateAdditions }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.match(res.headers.get('content-disposition'), /attachment/);
    const text = await res.text();
    assert.equal(text.trimEnd().split('\r\n').length, demo.shipments.length + 1);
  });
});

test('静态目录穿越与未知接口被拒绝', async () => {
  await withServer(async (base) => {
    const traversal = await fetch(`${base}/..%2fserver.js`);
    assert.ok([403, 404].includes(traversal.status));
    const api = await fetch(`${base}/api/nope`);
    assert.equal(api.status, 404);
    const missing = await fetch(`${base}/nope.html`);
    assert.equal(missing.status, 404);
  });
});

test('PORT 由环境变量读取并绑定回环地址', async () => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('启动超时')), 5000);
      child.stdout.on('data', () => {
        if (output.includes(String(port))) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`服务提前退出，code=${code}`));
      });
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/generate?count=2`);
    assert.equal(res.status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});
