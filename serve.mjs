// 本機伺服器：node serve.mjs（預設 http://0.0.0.0:5173）
// - web/ 底下的靜態檔
// - GET /api/stock：二手輔具即時庫存（爬臺北市輔具資源整合資訊網，快取 10 分鐘）
//   爬取失敗時回傳最後一次成功的快照 data/stock-snapshot.json，並標示 stale: true，
//   這樣 Demo 現場網路不穩也能顯示資料。
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlStock, BASE } from './server/stock.mjs';
import { validate, buildParams, maskParams, submitReservation } from './server/reserve.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, 'web');
const snapshotFile = join(here, 'data', 'stock-snapshot.json');
const port = Number(process.env.PORT || 5173);
const CACHE_MS = 10 * 60 * 1000;
// 只有用 LIVE_RESERVE=1 node serve.mjs 啟動時，才會真的送出預約；平常是演練模式
const LIVE = process.env.LIVE_RESERVE === '1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---------- 庫存快取 ----------
let cache = null; // { data, at }
let pending = null; // 正在爬的 Promise，避免同時重複爬

async function loadSnapshot() {
  try { return JSON.parse(await readFile(snapshotFile, 'utf8')); } catch { return null; }
}

function refresh() {
  if (!pending) {
    pending = crawlStock()
      .then(async (data) => {
        cache = { data, at: Date.now() };
        await writeFile(snapshotFile, JSON.stringify(data, null, 2)).catch(() => {});
        console.log(`庫存已更新：${data.categories.length} 類`);
        return data;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

async function getStock() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    return await refresh();
  } catch (err) {
    console.warn('爬取庫存失敗，改用快照：', err.message);
    const snap = cache?.data || await loadSnapshot();
    if (!snap) throw err;
    return { ...snap, stale: true };
  }
}

const submits = new Map(); // 身分證雜湊 → 送出時間
function allowSubmit(idno) {
  const key = createHash('sha256').update(idno).digest('hex');
  const day = Date.now() - 24 * 3600 * 1000;
  const list = (submits.get(key) || []).filter((t) => t > day);
  if (list.length >= 3) return false;
  list.push(Date.now());
  submits.set(key, list);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': types['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/api/reserve' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const errors = validate(body.form || {});
      if (errors.length) { sendJson(res, 400, { errors }); return; }
      // 防濫用：同一個身分證 24 小時內最多真的送出 3 次（只在記憶體計數，不存身分證）
      if (LIVE && body.live && !allowSubmit(String(body.form.idno || '').toUpperCase())) {
        sendJson(res, 429, { errors: ['今天已經預約很多次了，請明天再試，或打電話給輔具中心'] });
        return;
      }
      if (!LIVE || !body.live) {
        sendJson(res, 200, { ok: true, dryRun: true, fields: maskParams(buildParams(body.form)) });
        return;
      }
      const result = await submitReservation(body);
      console.log(`送出預約：款式 ${body.modelId} 中心 ${body.center} → ${result.ok ? '成功' : '失敗'}`);
      cache = null; // 庫存變了，下次重抓
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (err) {
      sendJson(res, 500, { errors: [err.message] });
    }
    return;
  }
  if (urlPath === '/api/config') {
    sendJson(res, 200, { liveReserve: LIVE });
    return;
  }
  if (urlPath === '/api/twnsp') {
    // 居住地不在臺北市時，向官網查該縣市的行政區選單
    const cnt = new URL(req.url, 'http://x').searchParams.get('cnt') || '';
    if (!/^\d{5}$/.test(cnt)) { sendJson(res, 400, { error: 'cnt' }); return; }
    try {
      const r = await fetch(`${BASE}/app37/rentView/gettwnspcode`, {
        method: 'POST', body: new URLSearchParams({ value: cnt }), signal: AbortSignal.timeout(15000),
      });
      const html = await r.text();
      const options = [...html.matchAll(/<option value="(\d+)"\s*>([^<]+)</g)].map((m) => ({ code: m[1], name: m[2].trim() }));
      sendJson(res, 200, { options });
    } catch (err) { sendJson(res, 502, { error: err.message }); }
    return;
  }
  if (urlPath === '/api/stock') {
    try { sendJson(res, 200, await getStock()); } catch (err) { sendJson(res, 503, { error: err.message }); }
    return;
  }
  const file = normalize(join(root, urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath));
  if (!file.startsWith(root + sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`輔具借用小幫手：http://localhost:${port}`);
  console.log(LIVE ? '⚠ 真的送出預約模式（LIVE_RESERVE=1）' : '預約為演練模式：不會真的送到官網');
  // 啟動時先抓一次，第一個使用者打開時就有資料
  refresh().catch((err) => console.warn('啟動時爬取失敗：', err.message));
});
