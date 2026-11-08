// 本機伺服器：node serve.mjs（預設 http://0.0.0.0:5173）
// - web/ 底下的靜態檔
// - GET /api/stock：二手輔具即時庫存（爬臺北市輔具資源整合資訊網；有人打開就背景重爬，沒人時每 10 分鐘爬一次）
//   爬取失敗時回傳最後一次成功的快照 data/stock-snapshot.json，並標示 stale: true，
//   這樣 Demo 現場網路不穩也能顯示資料。
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlStock, BASE } from './server/stock.mjs';
import { validate, buildParams, maskParams, submitReservation } from './server/reserve.mjs';
import { queryOfficial, cancelOfficial } from './server/query.mjs';

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
// 爬一次要 ~30 秒，所以不讓使用者乾等：
// - 有人打開 app：先回手上最新的資料，同時在背景重爬（距上次爬取至少 MIN_GAP_MS，避免狂打官網），
//   前端再用 /api/stock?wait=1 等這次爬完、更新畫面。
// - 沒人打開：每 CACHE_MS（10 分鐘）自己爬一次。
const MIN_GAP_MS = 60 * 1000;
let cache = null; // { data, at }
let pending = null; // 正在爬的 Promise，避免同時重複爬
let lastTry = 0; // 上次開始爬的時間（成功或失敗都算）
let failed = false; // 最近一次爬取失敗

async function loadSnapshot() {
  try { return JSON.parse(await readFile(snapshotFile, 'utf8')); } catch { return null; }
}

function refresh() {
  if (!pending) {
    lastTry = Date.now();
    pending = crawlStock()
      .then(async (data) => {
        cache = { data, at: Date.now() };
        failed = false;
        await writeFile(snapshotFile, JSON.stringify(data, null, 2)).catch(() => {});
        console.log(`庫存已更新：${data.categories.length} 類`);
        return data;
      })
      .catch((err) => {
        failed = true;
        console.warn('爬取庫存失敗，沿用上一次的資料：', err.message);
        throw err;
      })
      .finally(() => { pending = null; });
  }
  return pending;
}

// 手上最新的資料：記憶體快取，沒有就讀上次存的快照
async function latest() {
  const data = cache?.data || await loadSnapshot();
  if (!data) return null;
  return { ...data, stale: failed, refreshing: !!pending };
}

async function getStock({ wait = false } = {}) {
  if (Date.now() - lastTry >= MIN_GAP_MS) refresh().catch(() => {});
  if (wait && pending) await pending.catch(() => {});
  const data = await latest();
  if (data) return data;
  return refresh(); // 第一次啟動又沒有快照：只能等這次爬完
}

// 預約、取消後庫存變了：馬上重抓（正在爬的那次可能是送出前開始的，爬完再補一次）
function refreshAfterChange() {
  (pending ? pending.catch(() => {}).then(() => refresh()) : refresh()).catch(() => {});
}

// 沒人打開時，每 10 分鐘自己爬一次
setInterval(() => {
  if (Date.now() - lastTry >= CACHE_MS) refresh().catch(() => {});
}, 60 * 1000).unref();

// 官網購物車不能放同一款兩次；但分兩次送出官網擋不住，所以送出前先查這個人在官網
// 還有沒有「沒取消、還沒過領取期限」的同類輔具預約，有的話就不再送。
async function hasActiveSame(form, item) {
  const { rents } = await queryOfficial({ name: form.name, idno: form.idno, phone: form.phone });
  const today = new Date().toISOString().slice(0, 10);
  return rents.some((r) => !r.cancelled && r.items.some((x) => x.item === item && x.deadline >= today));
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
      const wait = body.wait ? { modelId: body.modelId, centers: body.centers || [] } : null;
      if (wait && !wait.centers.length) { sendJson(res, 400, { errors: ['請至少勾選一個中心'] }); return; }
      if (!LIVE || !body.live) {
        sendJson(res, 200, { ok: true, dryRun: true, fields: maskParams(buildParams(body.form, wait)) });
        return;
      }
      if (!wait && body.item && await hasActiveSame(body.form, body.item).catch(() => false)) {
        sendJson(res, 409, { errors: [`你在官網已經有一筆還沒取貨的「${body.item}」預約，取貨或取消後才能再預約`] });
        return;
      }
      const result = await submitReservation(body);
      console.log(`送出預約：款式 ${body.modelId} 中心 ${body.center} → ${result.ok ? '成功' : '失敗'}`);
      refreshAfterChange();
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (err) {
      sendJson(res, 500, { errors: [err.message] });
    }
    return;
  }
  if (urlPath === '/api/query' && req.method === 'POST') {
    // 查詢只讀資料，演練模式也會真的查
    try {
      const who = JSON.parse(await readBody(req));
      if (!who.name || !who.idno || !who.phone) { sendJson(res, 400, { errors: ['請填姓名、身分證字號、電話'] }); return; }
      const { waits, rents } = await queryOfficial(who);
      sendJson(res, 200, { waits, rents });
    } catch (err) { sendJson(res, 502, { errors: [err.message] }); }
    return;
  }
  if (urlPath === '/api/cancel' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (!LIVE || !body.live) { sendJson(res, 200, { ok: true, dryRun: true }); return; }
      const result = await cancelOfficial(body.who || {}, body);
      console.log(`取消預約：${body.no ?? `候補 ${body.wait}`} → ${result.ok ? '成功' : '失敗'}`);
      refreshAfterChange();
      sendJson(res, result.ok ? 200 : 502, result);
    } catch (err) { sendJson(res, 500, { errors: [err.message] }); }
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
    const wait = new URL(req.url, 'http://x').searchParams.get('wait') === '1';
    try { sendJson(res, 200, await getStock({ wait })); } catch (err) { sendJson(res, 503, { error: err.message }); }
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
  console.log(`輔具接力站：http://localhost:${port}`);
  console.log(LIVE ? '⚠ 真的送出預約模式（LIVE_RESERVE=1）' : '預約為演練模式：不會真的送到官網');
  // 啟動時先抓一次，第一個使用者打開時就有資料
  refresh().catch((err) => console.warn('啟動時爬取失敗：', err.message));
});
