// 本機伺服器：node serve.mjs（預設 http://0.0.0.0:5173）
// - web/ 底下的靜態檔
// - GET /api/stock：二手輔具即時庫存（爬臺北市輔具資源整合資訊網，快取 10 分鐘）
//   爬取失敗時回傳最後一次成功的快照 data/stock-snapshot.json，並標示 stale: true，
//   這樣 Demo 現場網路不穩也能顯示資料。
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlStock } from './server/stock.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, 'web');
const snapshotFile = join(here, 'data', 'stock-snapshot.json');
const port = Number(process.env.PORT || 5173);
const CACHE_MS = 10 * 60 * 1000;
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

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': types['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
  // 啟動時先抓一次，第一個使用者打開時就有資料
  refresh().catch((err) => console.warn('啟動時爬取失敗：', err.message));
});
