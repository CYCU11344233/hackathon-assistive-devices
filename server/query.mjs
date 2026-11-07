// 在台北通裡查詢、取消官網的二手輔具預約（官網「服務預約查詢與取消」）。
//
// 官網流程（2026-11 確認）：
//   GET /app37/rentView/query                                       查詢頁（拿 session）
//   GET /app37/rentView/doQuery?qrenttype=1&qname=&qidno=&qphone=   二手輔具的候補清單和借用清單
// 每筆借用清單最後一欄是「取消」，還能取消時裡面會有按鈕；候補清單最後一欄也一樣。
// 按鈕的網址格式要等有一筆還沒過期的預約才看得到，所以這裡用通用的方式抓
// （location.href='…' 或 href="…"），抓不到就當作不能線上取消。

import { BASE } from './stock.mjs';

const UA = 'TaipeiPass-AidHelper/0.1 (Taipei Codefest 2026 hackathon)';

const text = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim();

/** 從「取消」欄裡找出要呼叫的網址（相對路徑） */
export function actionUrl(cell) {
  const html = cell.replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const m = html.match(/location\.(?:href\s*=|assign\()\s*['"]([^'"]+)['"]/) || html.match(/href="(\/[^"]+)"/);
  return m ? m[1] : null;
}

const rowsOf = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
  .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]))
  .filter((tds) => tds.length);

/** 民國 115/09/02 → 2026-09-02 */
export function fromMinguo(s) {
  const m = String(s).match(/(\d{2,3})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/);
  return m ? `${Number(m[1]) + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

/**
 * 解析 doQuery 的結果。
 * 回傳 { waits: [{ date, item, status, seq, cancelUrl }], rents: [{ no, date, center, cancelled, items: [{ item, spec, deadline, cancelUrl }] }] }
 */
export function parseQuery(html) {
  const waits = [];
  const w = html.match(/id="collapse_waitList"[\s\S]*?<\/table>/);
  if (w) {
    for (const tds of rowsOf(w[0])) {
      if (tds.length < 4) continue;
      waits.push({
        date: fromMinguo(text(tds[0])), item: text(tds[1]), status: text(tds[2]),
        seq: text(tds[3]).replace(/^-$/, ''), cancelUrl: tds[4] ? actionUrl(tds[4]) : null,
      });
    }
  }
  const rents = [];
  const parts = html.split(/以下為您"/).slice(1);
  for (const p of parts) {
    const head = p.match(/^([\d/]+)"的借用清單\((\d+)\)([^<]*)/);
    if (!head) continue;
    const center = text(p.match(/<h3 class="panel-title">([\s\S]*?)<\/h3>/)?.[1] || '');
    const table = p.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '';
    const items = rowsOf(table).filter((tds) => tds.length >= 5).map((tds) => ({
      item: text(tds[0]),
      spec: [tds[1], tds[2], tds[3]].map(text).filter((x) => x && x !== '---').join(' '),
      deadline: fromMinguo(text(tds[4])),
      cancelUrl: tds[5] ? actionUrl(tds[5]) : null,
    }));
    rents.push({ no: head[2], date: fromMinguo(head[1]), center, cancelled: head[3].includes('已取消'), items });
  }
  return { waits, rents };
}

function session() {
  const jar = new Map();
  return async function get(path) {
    let url = BASE + path;
    for (let i = 0; i < 5; i++) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';');
        const at = kv.indexOf('=');
        jar.set(kv.slice(0, at).trim(), kv.slice(at + 1).trim());
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
      return { status: res.status, html: await res.text() };
    }
    throw new Error('官網轉址太多次');
  };
}

const qs = ({ name, idno, phone }) => new URLSearchParams({
  qrenttype: '1', qname: String(name || '').trim(), qidno: String(idno || '').trim().toUpperCase(), qphone: String(phone || '').trim(),
});

/** 查詢。who: { name, idno, phone }（phone 是預約時填的「電話」） */
export async function queryOfficial(who) {
  const get = session();
  await get('/app37/rentView/query');
  const r = await get(`/app37/rentView/doQuery?${qs(who)}`);
  if (r.status !== 200) throw new Error(`官網查詢失敗（${r.status}）`);
  return { ...parseQuery(r.html), get };
}

/**
 * 取消一筆借用清單裡的某項（no：借用清單編號；index：第幾項）或某筆候補（wait：第幾筆）。
 * 回傳 { ok, message }
 */
export async function cancelOfficial(who, { no, index = 0, wait }) {
  const q = await queryOfficial(who);
  const url = wait != null ? q.waits[wait]?.cancelUrl : q.rents.find((r) => r.no === no)?.items[index]?.cancelUrl;
  if (!url) return { ok: false, message: '官網這筆已經不能線上取消（可能已過領取期限或已取消），請打電話給輔具中心' };
  await q.get(url);
  // 重新查一次確認
  const after = await queryOfficial(who);
  const ok = wait != null ? /取消/.test(after.waits[wait]?.status || '') : !!after.rents.find((r) => r.no === no)?.cancelled
    || !after.rents.find((r) => r.no === no)?.items[index]?.cancelUrl;
  return { ok, message: ok ? '已在官網取消' : '官網沒有回應取消結果，請到官網確認' };
}
