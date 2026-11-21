'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const {
  analyzeShipments,
  SEGMENT_LABELS,
  SEGMENTS,
  STATUS,
} = require('./src/segmenter');
const { demoDataset, generateShipments, generateLateAdditions, DEFAULT_SEED } = require('./src/fixtures');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = '127.0.0.1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, '请求体超过 2MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseIntParam(value, fallback, { min, max, name }) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw httpError(400, `${name} 需为 ${min}–${max} 的整数`);
  }
  return n;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function fmt(n) {
  return n === null || n === undefined ? '' : String(Math.round(n * 10) / 10);
}

function fmtOrDash(n) {
  return n === null || n === undefined ? '—' : String(Math.round(n * 10) / 10);
}

function statusLabel(status) {
  if (status === STATUS.SLOW) return '慢件';
  if (status === STATUS.INCOMPLETE) return '时间不全';
  return '正常';
}

/**
 * 导出 CSV：不丢弃任何时间不全的件，缺什么就留空并写进 missing_time 列；
 * 补交/改派引起的变化放在 change 列，与补交后的段值并列展示。
 */
function buildCsv(analysis) {
  const changeById = new Map(analysis.changes.map((c) => [c.id, c]));
  const header = [
    'shipment_id',
    'origin',
    'destination',
    'inbound',
    'departure',
    'arrival',
    'missing_time',
    'reroute',
    'status',
    'first_slow_segment',
    'inbound_to_departure_min',
    'inbound_to_departure_plan_min',
    'departure_to_arrival_min',
    'departure_to_arrival_plan_min',
    'total_delay_min',
    'change',
  ];
  const rows = [header];
  for (const s of analysis.after.shipments) {
    const [inSeg, outSeg] = s.segments;
    const change = changeById.get(s.id);
    let changeText = '';
    if (change) {
      const parts = [];
      if (change.routeChanged) {
        parts.push(
          `改派 ${change.beforeDestination ?? ''}→${change.afterDestination ?? ''}`,
        );
      }
      if (change.rerouteChanged) parts.push(`改派标记→${change.reroute ? '是' : '否'}`);
      for (const shift of change.shifts) {
        parts.push(
          `${shift.label} ${fmtOrDash(shift.before)}→${fmtOrDash(shift.after)} 分钟`,
        );
      }
      if (change.statusChanged) {
        parts.push(
          `状态 ${statusLabel(change.beforeStatus)}→${statusLabel(change.afterStatus)}`,
        );
      }
      changeText = parts.join('；');
    }
    rows.push([
      s.id,
      s.origin,
      s.destination,
      s.times.inbound ?? '',
      s.times.departure ?? '',
      s.times.arrival ?? '',
      s.missing.join('|'),
      s.reroute ? 'yes' : 'no',
      statusLabel(s.status),
      s.firstSlowSegment ? SEGMENT_LABELS[s.firstSlowSegment] : '',
      fmt(inSeg.actualMinutes),
      inSeg.planMinutes,
      fmt(outSeg.actualMinutes),
      outSeg.planMinutes,
      s.totalDelayMinutes,
      changeText,
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function requireShipments(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, '请求体必须是 JSON 对象');
  }
  if (!Array.isArray(body.shipments) || body.shipments.length === 0) {
    throw httpError(400, 'shipments 必须是非空数组');
  }
  if (!Array.isArray(body.lateAdditions ?? [])) {
    throw httpError(400, 'lateAdditions 必须是数组');
  }
  try {
    return analyzeShipments(body.shipments, body.lateAdditions ?? [], {
      seed: Number.isInteger(body.seed) ? body.seed : null,
    });
  } catch (err) {
    throw httpError(400, err.message);
  }
}

function routeGenerate(res, url) {
  const seed = parseIntParam(url.searchParams.get('seed'), DEFAULT_SEED, {
    min: 0,
    max: 2 ** 31 - 1,
    name: 'seed',
  });
  const count = parseIntParam(url.searchParams.get('count'), 36, {
    min: 1,
    max: 500,
    name: 'count',
  });
  sendJson(res, 200, demoDataset({ seed, count }));
}

/**
 * 段间延误视图：两套归因口径并列，另附“最先超标段”的解释清单。
 * 两者合计都等于各件段延误之和，页面据此核对没有多算。
 */
function snapshot(analysisState) {
  const explanation = analysisState.shipments
    .filter((s) => s.firstSlowSegment)
    .map((s) => {
      const first = s.segments.find((seg) => seg.key === s.firstSlowSegment);
      const later = s.segments.filter(
        (seg) => seg.key !== s.firstSlowSegment && seg.slow,
      );
      return {
        id: s.id,
        firstSlowSegment: s.firstSlowSegment,
        firstSlowLabel: SEGMENT_LABELS[s.firstSlowSegment],
        firstDelayMinutes: first.delayMinutes,
        totalDelayMinutes: s.totalDelayMinutes,
        laterSlowSegments: later.map((seg) => ({
          key: seg.key,
          label: seg.label,
          delayMinutes: seg.delayMinutes,
        })),
      };
    });

  return {
    totals: analysisState.totals,
    segments: analysisState.segments,
    sites: analysisState.sites,
    explanation,
    consistency: analysisState.consistency ?? null,
  };
}

function buildSegmentView(analysis) {
  const before = snapshot({
    ...analysis.before,
    consistency: analysis.consistency.before,
  });
  const after = snapshot({
    ...analysis.after,
    consistency: analysis.consistency.after,
  });

  return {
    generatedAt: analysis.generatedAt,
    seed: analysis.seed,
    appliedLate: analysis.lateAdditions.applied.length,
    before,
    after,
    changes: analysis.changes,
    labels: SEGMENTS.map((key) => ({ key, label: SEGMENT_LABELS[key] })),
  };
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== PUBLIC_DIR) {
    sendText(res, 403, '禁止访问');
    return;
  }
  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      sendText(res, 404, '页面不存在');
    } else {
      sendText(res, 500, '读取页面失败');
    }
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? HOST}`);
    try {
      if (req.method === 'GET' && url.pathname === '/api/generate') {
        routeGenerate(res, url);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        sendJson(res, 200, requireShipments(await readJsonBody(req)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/segments') {
        sendJson(res, 200, buildSegmentView(requireShipments(await readJsonBody(req))));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/export') {
        const analysis = requireShipments(await readJsonBody(req));
        const csv = buildCsv(analysis);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="shipment-delay-segments.csv"',
          'content-length': Buffer.byteLength(csv),
          'cache-control': 'no-store',
        });
        res.end(csv);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: '接口不存在' });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, '方法不支持');
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.statusCode ?? 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err.message ?? '服务器内部错误' });
    }
  });
}

if (require.main === module) {
  const rawPort = process.env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 不合法: ${rawPort}`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(port, HOST, () => {
    const addr = server.address();
    console.log(`快件段间延误分析已启动: http://${HOST}:${addr.port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  createServer,
  buildCsv,
  buildSegmentView,
  generateShipments,
  generateLateAdditions,
};
