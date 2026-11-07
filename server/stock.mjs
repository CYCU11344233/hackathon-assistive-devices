// 二手輔具庫存爬蟲：從「臺北市輔具資源整合資訊網」抓即時剩餘數量和等待人數。
// 主辦單位（資訊局）同意本競賽爬取此網站。
//
// 網站結構（2026-11 確認）：
//   /app37/rentView/additem               12 大類，各類總剩餘數，連到 vehicleDetail/{類別}
//   /app37/rentView/vehicleDetail/{類別}  各規格：名稱、尺寸、剩餘、說明、等待人數；
//                                          有貨的按鈕連 chooseCenterCategory/{規格}，沒貨的連 waitingRent/{規格}
//   /app37/rentView/map/{規格}            各中心剩餘數量與服務行政區
//
// 禮貌爬取：一次只發一個請求、請求之間間隔 300ms、結果快取 10 分鐘（見 serve.mjs）。

export const BASE = 'https://tpap.taipei';
const UA = 'TaipeiPass-AidHelper/0.1 (Taipei Codefest 2026 hackathon)';
// 官網的中心編號
export const CENTER_IDS = { 1: 'heyi', 2: 'south', 3: 'west' };

const decode = (s) => s
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;?/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

/** 大類清單：[{ id, name, remaining }] */
export function parseCategories(html) {
  const out = [];
  const blocks = html.split(/<div class="ind-tab"/).slice(1);
  for (const b of blocks) {
    const id = b.match(/vehicleDetail\/(\d+)/)?.[1];
    const name = b.match(/<span class="sr-only">([^<]+)<\/span>/)?.[1]?.trim();
    const remaining = b.match(/剩餘[:：]\s*(\d+)/)?.[1];
    if (id && name && remaining != null && !out.some((x) => x.id === Number(id))) {
      out.push({ id: Number(id), name, remaining: Number(remaining) });
    }
  }
  return out;
}

/** 某一大類的各規格：[{ id, name, spec, remaining, desc, waiting }] */
export function parseModels(html) {
  const out = [];
  const blocks = html.split(/<table class="ind-tab"/).slice(1);
  for (const b of blocks) {
    const body = b.split('</table>')[0];
    const name = decode(body.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] || '');
    const tds = [...body.matchAll(/<td(?![^>]*rowspan)[^>]*>([\s\S]*?)<\/td>/g)].map((m) => decode(m[1]));
    const remaining = Number(body.match(/剩餘[:：]\s*(\d+)/)?.[1] ?? NaN);
    const id = Number(body.match(/(?:chooseCenterCategory|waitingRent)\/(\d+)/)?.[1] ?? NaN);
    if (!name || Number.isNaN(id) || Number.isNaN(remaining)) continue;
    // 尺寸欄有時和名稱一樣或兩格重複（例如「移位腰帶」），去掉重複的
    const spec = [...new Set([tds[0], tds[1]])].filter((x) => x && x !== '---' && x !== name).join(' ');
    const desc = tds.find((t, i) => i >= 3 && t && !/^剩餘/.test(t) && !/等待人數/.test(t)) || '';
    const waiting = Number(body.match(/等待人數[:：]\s*(\d+)/)?.[1] ?? 0);
    out.push({ id, name, spec, remaining, desc, waiting });
  }
  return out;
}

/** 某規格在各中心的剩餘數量：{ heyi: 1, west: 0, south: 0 } */
export function parseCenters(html) {
  const out = {};
  for (const m of html.matchAll(/centerId=(\d+)[\s\S]*?剩餘數量[:：]\s*(\d+)/g)) {
    const key = CENTER_IDS[m[1]];
    if (key && !(key in out)) out[key] = Number(m[2]);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${path} 回應 ${res.status}`);
  return res.text();
}

/** 抓一次完整庫存。只有「有剩餘」的規格才去查各中心數量，減少請求數。 */
export async function crawlStock({ delayMs = 300 } = {}) {
  const categories = parseCategories(await get('/app37/rentView/additem'));
  if (!categories.length) throw new Error('解析不到輔具大類，官網版面可能改了');
  for (const c of categories) {
    await sleep(delayMs);
    c.models = parseModels(await get(`/app37/rentView/vehicleDetail/${c.id}`));
    for (const m of c.models) {
      if (m.remaining > 0) {
        await sleep(delayMs);
        m.centers = parseCenters(await get(`/app37/rentView/map/${m.id}`));
      }
    }
  }
  return {
    source: '臺北市輔具資源整合資訊網 https://tpap.taipei/app37/rentView/additem',
    fetchedAt: new Date().toISOString(),
    categories,
  };
}
