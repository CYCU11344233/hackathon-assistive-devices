// 代替使用者在「臺北市輔具資源整合資訊網」送出二手輔具預約（主辦單位同意）。
//
// 官網流程（2026-11 確認）：
//   GET  /app37/rentView/returnList?centerId={中心}&typeId={款式}  放進購物車（官網保留 1 小時），302 到購物車
//   GET  /app37/rentView/basicdata                                 填資料頁
//   GET  /app37/rentView/basicdata?{欄位}&_action_submitData=完成   送出（官網表單沒有 method，所以是 GET）
//
// 預設是「演練模式」：只檢查資料、回傳會送出的欄位，完全不連官網。
// 只有伺服器用 LIVE_RESERVE=1 啟動，而且前端也要求 live 時，才會真的送出。
// 每送出一次就是一筆真的預約（佔庫存、發簡訊），測完請到官網「服務預約查詢與取消」取消。

import { BASE } from './stock.mjs';

const UA = 'TaipeiPass-AidHelper/0.1 (Taipei Codefest 2026 hackathon)';

// 官網的中心編號
export const OFFICIAL_CENTER = { heyi: 1, south: 2, west: 3 };

// 臺北市行政區代碼（官網 twnspcode 選單）
export const TAIPEI_DISTRICTS = {
  松山區: '63000010', 信義區: '63000020', 大安區: '63000030', 中山區: '63000040',
  中正區: '63000050', 大同區: '63000060', 萬華區: '63000070', 文山區: '63000080',
  南港區: '63000090', 內湖區: '63000100', 士林區: '63000110', 北投區: '63000120',
};
// 縣市代碼（官網 cntcode2 選單）
export const COUNTIES = {
  臺北市: '63000', 新北市: '65000', 基隆市: '10017', 桃園縣: '10003', 新竹市: '10018', 新竹縣: '10004',
  苗栗縣: '10005', 臺中市: '66000', 彰化縣: '10007', 南投縣: '10008', 雲林縣: '10009', 嘉義市: '10020',
  嘉義縣: '10010', 臺南市: '67000', 高雄市: '64000', 屏東縣: '10013', 宜蘭縣: '10002', 花蓮縣: '10015',
  臺東縣: '10014', 澎湖縣: '10016', 金門縣: '09020', 連江縣: '09007',
};

/** 西元 YYYY-MM-DD → 民國 YYY/MM/DD（官網生日格式） */
export function toMinguo(iso) {
  const m = String(iso).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return '';
  return `${String(Number(m[1]) - 1911).padStart(3, '0')}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}`;
}

/**
 * 依官網 check() 的規則檢查。回傳錯誤訊息陣列（空陣列表示通過）。
 * f: { name, idno, foreign, twnspcode, addr, liveCnt, liveTwnsp, liveAddr, phone, mobile, email,
 *      userName, userIdno, userForeign, userBirth(YYYY-MM-DD), handicap('1'|'0'), lcms('1'|'0'), selective('1'|'2'|'3') }
 */
export function validate(f) {
  const err = [];
  const need = {
    name: '聯絡人姓名', idno: '聯絡人身分證字號', twnspcode: '戶籍行政區', addr: '戶籍地址',
    liveCnt: '居住縣市', liveTwnsp: '居住行政區', liveAddr: '居住地址', phone: '電話', mobile: '手機',
    userName: '使用者姓名', userIdno: '使用者身分證字號', userBirth: '出生年月日',
    handicap: '身障資格', lcms: '長照資格', selective: '福利資格',
  };
  for (const [k, label] of Object.entries(need)) if (!String(f[k] ?? '').trim()) err.push(`請填寫${label}`);
  if (f.mobile && !/^09\d{8}$/.test(f.mobile)) err.push('手機要是 09 開頭的 10 碼數字');
  if (f.userBirth && !toMinguo(f.userBirth)) err.push('出生年月日格式不對');
  if (f.twnspcode && !Object.values(TAIPEI_DISTRICTS).includes(f.twnspcode)) err.push('戶籍行政區要在臺北市');
  return err;
}

/** 組成官網表單的欄位（順序照官網表單） */
export function buildParams(f) {
  const p = new URLSearchParams();
  p.append('name', f.name.trim());
  p.append('idno', f.idno.trim().toUpperCase());
  p.append('_idnoType', '');
  if (f.foreign) p.append('idnoType', '1');
  p.append('userType', '0');
  p.append('cntcode', '63000');
  p.append('twnspcode', f.twnspcode);
  if (f.vilgcode) p.append('vilgcode', f.vilgcode);
  p.append('addr', f.addr.trim());
  p.append('cntcode2', f.liveCnt);
  p.append('informtwnspcode', f.liveTwnsp);
  p.append('informaddr', f.liveAddr.trim());
  p.append('phone', f.phone.trim());
  p.append('mobile', f.mobile.trim());
  p.append('email', (f.email || '').trim());
  p.append('email2', '');
  p.append('userName', f.userName.trim());
  p.append('userIdno', f.userIdno.trim().toUpperCase());
  p.append('_userIdnoType', '');
  if (f.userForeign) p.append('userIdnoType', '1');
  p.append('userBirthdt', toMinguo(f.userBirth));
  p.append('handicapType', f.handicap);
  p.append('lcmsType', f.lcms);
  p.append('selectiveType', f.selective);
  p.append('waitValid', 'true');
  p.append('_action_submitData', '完成');
  return p;
}

/** 回應給前端看的欄位：身分證只留前後各一碼 */
export function maskParams(p) {
  const out = {};
  for (const [k, v] of p) out[k] = /idno/i.test(k) && v.length > 2 ? `${v[0]}${'*'.repeat(v.length - 2)}${v.at(-1)}` : v;
  return out;
}

// 簡單的 cookie 連線：記住官網的 JSESSIONID，手動跟隨轉址
function session() {
  const jar = new Map();
  return async function get(path, max = 5) {
    let url = BASE + path;
    for (let i = 0; i < max; i++) {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';');
        const at = kv.indexOf('=');
        jar.set(kv.slice(0, at).trim(), kv.slice(at + 1).trim());
      }
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).href; continue; }
      return { status: res.status, url, html: await res.text() };
    }
    throw new Error('官網轉址太多次');
  };
}

const pageText = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
  .replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .split('\n').map((s) => s.trim()).filter(Boolean);

/** 真的送出預約。回傳 { ok, lines }：lines 是官網結果頁的主要文字，給使用者看。 */
export async function submitReservation({ center, modelId, form }) {
  const centerId = OFFICIAL_CENTER[center];
  if (!centerId || !Number.isInteger(Number(modelId))) throw new Error('中心或款式不正確');
  const get = session();
  const cart = await get(`/app37/rentView/returnList?centerId=${centerId}&typeId=${Number(modelId)}`);
  if (!cart.html.includes(`typeid=${Number(modelId)}`)) throw new Error('官網沒有把這款放進預約清單，可能剛好被借走了');
  let ok = false;
  try {
    await get('/app37/rentView/basicdata');
    const done = await get(`/app37/rentView/basicdata?${buildParams(form)}`);
    const lines = pageText(done.html);
    const start = lines.findIndex((l) => l.includes('服務預約查詢與取消'));
    const end = lines.findIndex((l) => l.startsWith('網站維護單位'));
    const body = lines.slice(start >= 0 ? start + 1 : 0, end > 0 ? end : undefined).filter((l) => l !== ':::');
    // 還停在填資料頁，或出現錯誤字樣，就當作失敗
    ok = done.status < 400 && !body.some((l) => /失敗|錯誤|請確認|必填|填寫資料/.test(l));
    return { ok, lines: body.slice(0, 30) };
  } finally {
    // 沒成功就把購物車裡的這件放回去，不要佔住別人的庫存
    if (!ok) await get(`/app37/rentView/deleteitem?centerid=${centerId}&typeid=${Number(modelId)}&num=0`).catch(() => {});
  }
}
