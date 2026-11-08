import {
  parseHours, openStatus, pickupStatus, loanStage, reminderFor, defaultDueDate, REMINDER_DAYS,
  addMonths, addDays, diffDays, startOfDay, intervalsOnDate, WEEKDAY_NAMES,
} from './rules.js';
import { CENTERS, ITEMS, LINKS, CHECKLISTS, NEEDS, AGREEMENTS } from './data.js';
import * as bridge from './bridge.js';
import { HOLIDAYS } from './holidays.js';
import { reservePage, accountWho } from './reserve.js';

// 開放時間加上國定假日休館（人事行政總處辦公日曆表）
const HOURS = Object.fromEntries(CENTERS.map((c) => [c.id, { ...parseHours(c.hoursText), closed: HOLIDAYS }]));
const centerById = (id) => CENTERS.find((c) => c.id === id);

// ---------- 狀態與儲存（只存在這支手機） ----------
const KEY = 'tp-aid-helper-v1';
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && Array.isArray(s.loans)) return s;
  } catch { /* 無痕模式或被封鎖時改用記憶體 */ }
  return { loans: [], demoOffset: 0 };
}
let state = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* 忽略 */ }
}
const now = () => new Date(Date.now() + (state.demoOffset || 0));
let myLoc = null;

// ---------- 格式 ----------
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 所有日期都帶年份，避免跨年時看錯
const fmtDate = (d) => { d = new Date(d); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_NAMES[d.getDay()]}）`; };
const fmtTime = (d) => { d = new Date(d); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayWord(d) {
  const n = diffDays(now(), d);
  if (n === 0) return '今天';
  if (n === 1) return '明天';
  if (n === -1) return '昨天';
  return fmtDate(d);
}
const fmtSmart = (d) => `${dayWord(d)} ${fmtTime(d)}`;
const toDateInput = (d) => { d = new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function fromDateInput(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fromDTInput(s) {
  const [date, time] = s.split('T');
  const d = fromDateInput(date);
  const [h, mi] = (time || '0:0').split(':').map(Number);
  d.setHours(h, mi, 0, 0);
  return d;
}
function minsText(m) {
  if (m < 60) return `${m} 分鐘`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小時 ${m % 60} 分` : `${h} 小時`;
}
function km(a, b) {
  const R = 6371;
  const toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat);
  const dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const newId = () => Math.random().toString(36).slice(2, 10);

// 可選的預約時段：往前 3 天到往後 14 天、該中心開館時段內，每 30 分鐘一格（24 小時制）。
// 晚上也能在官網預約，只是預約的時段必須在開館時間內。
const SLOT_MIN = 30;
function reservationSlots(hours, t) {
  const out = [];
  for (let d = -3; d <= 14; d++) {
    for (const iv of intervalsOnDate(hours, addDays(startOfDay(t), d))) {
      for (let x = iv.start.getTime(); x < iv.end.getTime(); x += SLOT_MIN * 60000) out.push(new Date(x));
    }
  }
  return out;
}
// 預設選下一個開館時段（現在正在開館就選目前這一格）；沒有的話選最後一格
function nearestSlot(slots, t) {
  const cur = slots.find((s) => s.getTime() + SLOT_MIN * 60000 > t);
  return cur ?? slots[slots.length - 1] ?? null;
}

// ---------- 狀態文字 ----------
function pickupText(p) {
  switch (p.status) {
    case 'impossible': return { tone: 'danger', text: '取件期限內無開館時段，請洽中心' };
    case 'expired': return { tone: 'muted', text: `已逾取件期限（${fmtSmart(p.deadline)}）` };
    case 'urgent': return { tone: 'danger', text: `取件期限：${fmtSmart(p.deadline)}（剩 ${minsText(p.remainingMin)}）` };
    default: return { tone: 'info', text: `取件期限：${fmtSmart(p.deadline)}` };
  }
}

function loanStatus(loan) {
  if (loan.cancelledAt) return { tone: 'muted', text: `${fmtDate(loan.cancelledAt)} 已取消預約`, s: { stage: 'cancelled' }, label: '已取消' };
  const s = loanStage(loan, HOURS[loan.centerId], now());
  if (s.stage === 'reserved') return { ...pickupText(s.pickup), s, label: '等待取貨' };
  if (s.stage === 'borrowed') {
    const due = fmtDate(s.due);
    // 到期日休館時，另起一行提示最後可歸還的時間
    const note = s.dueClosed && s.level !== 'overdue' ? `※ 到期日為休館日，請於 ${fmtDate(s.returnBy)} ${fmtTime(s.returnBy)} 前歸還` : '';
    if (s.level === 'overdue') return { tone: 'danger', text: `已逾到期日 ${-s.daysLeft} 天`, s, label: '借用中' };
    if (s.level === 'urgent') return { tone: 'danger', text: `到期日：${due}（${s.daysLeft === 0 ? '今日' : '明日'}）`, note, s, label: '借用中' };
    if (s.level === 'soon') return { tone: 'warn', text: `到期日：${due}・剩餘 ${s.daysLeft} 天`, note, s, label: '借用中' };
    return { tone: 'ok', text: `到期日：${due}`, note, s, label: '借用中' };
  }
  if (s.late && s.suspendedNow) return { tone: 'danger', text: `停權至 ${fmtDate(s.suspendedUntil)}`, s, label: '已歸還' };
  return { tone: 'muted', text: `${fmtDate(loan.returnedAt)} 已歸還`, s, label: '已歸還' };
}

const TONE_RANK = { danger: 0, warn: 1, info: 2, ok: 3, muted: 4 };

// ---------- 共用元件 ----------
// 單色線條圖示（跟著按鈕文字顏色），取代顏色不一的 emoji
const svg = (d) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  nav: svg('<polygon points="3 11 22 2 13 21 11 13 3 11"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>'),
  stairs: svg('<path d="M3 20h5v-5h5v-5h5V5h3"/>'),
  bell: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
};

function centerActions(c) {
  return `<div class="btn-row">
    <button class="btn" data-act="call" data-phone="${c.phone}">${ICON.phone} 撥號</button>
    <button class="btn" data-act="map" data-center="${c.id}">${ICON.nav} 導航</button>
  </div>`;
}

function openLine(c) {
  const o = openStatus(HOURS[c.id], now());
  if (o.open) return `<span class="chip ok">營業中</span> ${fmtTime(o.closesAt)} ${o.closesAt.getHours() === 12 ? '午休' : '關門'}`;
  return `<span class="chip muted">休息中</span> ${o.nextOpen ? `${fmtSmart(o.nextOpen)} 開門` : ''}`;
}

function sortedCenters() {
  const t = now();
  return CENTERS.map((c) => {
    const p = pickupStatus(HOURS[c.id], t, t);
    const dist = myLoc ? km(myLoc, c) : null;
    return { c, p, dist };
  }).sort((a, b) => {
    const rank = { ok: 0, urgent: 1, impossible: 2, expired: 3 };
    if (a.dist != null && b.dist != null) return a.dist - b.dist;
    return rank[a.p.status] - rank[b.p.status];
  });
}

const shortName = (c) => c.name.replace('臺北市', '');

// 地址、開放時間、入口提示收在「地址與時間」裡，需要再點開
// 「周二至周六 9:00-12:00 13:30-17:00」→「週二至週六 09:00–12:00、13:30–17:00」
function hoursLabel(c) {
  const h = HOURS[c.id];
  const days = c.hoursText.split(/\d/)[0].trim().replace(/周/g, '週');
  const t = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return `${days} ${h.ranges.map(([x, y]) => `${t(x)}–${t(y)}`).join('、')}`;
}

function centerInfo(c) {
  return `<details class="more"><summary>地址與時間</summary>
    <dl class="info">
      <dt>地址</dt><dd>${esc(c.address)}</dd>
      <dt>怎麼找</dt><dd>${esc(c.entrance)}</dd>
      <dt>開放</dt><dd>${esc(hoursLabel(c))}</dd>
      <dt>休館</dt><dd>國定假日</dd>
      <dt>電話</dt><dd>${esc(c.phoneText)}</dd>
    </dl></details>`;
}

// 開館中才顯示「現在預約要在什麼時候前取貨」；休館中上一行已經寫了下次開門時間，
// 而且晚上也能在官網預約開館時段，不需要再多一行
function bookLine(c, p, pt) {
  if (!openStatus(HOURS[c.id], now()).open) return '';
  const text = p.status === 'impossible' ? '若現在預約，取件期限內無開館時段' : `若現在預約，取件期限為 ${fmtSmart(p.deadline)}`;
  return `<p class="line tone-${pt.tone}">${text}</p>`;
}

function centerCard({ c, p, dist }, showPickup = true) {
  const pt = pickupText(p);
  return `<article class="card">
    <div class="card-head"><h3>${esc(shortName(c))}</h3>${dist != null ? `<span class="dist">${dist.toFixed(1)} 公里</span>` : ''}</div>
    <p class="line">${openLine(c)}</p>
    ${showPickup ? bookLine(c, p, pt) : ''}
    ${centerActions(c)}
    ${centerInfo(c)}
  </article>`;
}

function checklist(loan, list) {
  const checks = (loan.checks && loan.checks[list]) || [];
  return `<ul class="checklist">${CHECKLISTS[list].map((t, i) => `
    <li><label><input type="checkbox" data-act="check" data-loan="${loan.id}" data-list="${list}" data-i="${i}" ${checks.includes(i) ? 'checked' : ''}> <span>${esc(t)}</span></label></li>`).join('')}
  </ul>`;
}

function locateButton() {
  return myLoc ? '' : `<button class="btn ghost" data-act="locate">${ICON.pin} 依距離排序</button>`;
}

// ---------- 即時庫存 ----------
// 由 serve.mjs 的 /api/stock 提供（爬臺北市輔具資源整合資訊網，快取 10 分鐘）。
// 拿不到時 stock 維持 null，畫面退回沒有庫存資訊的版本。
const OFFICIAL = 'https://tpap.taipei/app37/rentView';
const CENTER_SHORT = { heyi: '合宜', west: '西區', south: '南區' };
// 官網的中心編號
const OFFICIAL_CENTER = { heyi: 1, south: 2, west: 3 };
let stock = null;
let stockLoading = true; // 第一次載入中；失敗時改成 false，畫面退回沒有庫存的版本
// 這些頁面有使用者正在填的表單或查詢結果，自動重畫會清掉
const busyForm = () => ['loan-form', 'demo-form', 'reserve-form', 'q-form'].some((id) => document.getElementById(id));
// 打開 app 就請伺服器重爬：先拿到手上最新的資料，伺服器還在爬（refreshing）就再等爬完、更新畫面
function loadStock(wait = false) {
  return fetch(`/api/stock${wait ? '?wait=1' : ''}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.categories) stock = d;
      return d;
    })
    .catch(() => null)
    .finally(() => {
      stockLoading = false;
      // 正在填表單時不要重畫（busyForm），避免清掉使用者輸入
      if (!busyForm()) render();
    });
}
loadStock().then((d) => { if (d?.refreshing) loadStock(true); });
// 從背景切回來（重新看到畫面）也重抓
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadStock().then((d) => { if (d?.refreshing) loadStock(true); });
});
// 官網大類編號 → 圖片（庫存還沒載入時也能顯示）
const ITEM_IMG = {
  輪椅: 1, 助行器: 2, 拐杖: 3, 便盆椅: 4, 輪椅座墊: 5, 氣墊床: 6, 洗澡椅: 7, 助步車: 8,
  居家用照顧床: 9, 兒童類輔具: 10, 移位輔具: 12, 矯具: 20, 其他: 20, 其他輔具: 20,
};
const stockCat = (name) => stock?.categories.find((c) => c.name === name);
const stockModel = (id) => stock?.categories.flatMap((c) => c.models.map((m) => ({ ...m, cat: c.name }))).find((m) => m.id === Number(id));

// ---------- 到貨通知（台北通自己的） ----------
// 沒貨的款式可以按「有貨時通知我」，記在這支手機。每次打開 App 拿到最新庫存時檢查，
// 有貨就跳台北通通知、首頁顯示「可以預約了」。和官網的「候補」不同：官網候補是排隊順位，
// 這裡只是提醒「現在有貨」，兩個可以一起用。
const watches = () => (state.watches ||= []);
// 這一款還沒取貨、沒取消的預約（同一款不能重複預約，和官網購物車一樣）
const activeLoanFor = (modelId) => state.loans.find((l) => l.modelId === Number(modelId) && !l.pickedUpAt && !l.cancelledAt && !l.returnedAt
  && loanStage(l, HOURS[l.centerId], now()).pickup?.status !== 'expired');
function watchList() {
  if (!watches().length) return '';
  return `<h2>到貨通知</h2>${watches().map((w) => {
    const m = stockModel(w.modelId);
    const has = m && m.remaining > 0;
    return `<a class="card link tone-border-${has ? 'ok' : 'muted'}" href="#/borrow?step=plan&item=${encodeURIComponent(w.item)}&focus=${w.modelId}">
      <div class="card-head"><h3>${esc(w.item)}</h3><span class="chip ${has ? 'ok' : 'muted'}">${has ? `有貨 ${m.remaining}` : '等待中'}</span></div>
      <p class="line">${esc(w.name)}${has ? '・可以預約了' : w.official ? `・已在官網候補（${(w.centers || []).map((c) => CENTER_SHORT[c]).join('、')}）` : '・有貨時會通知你'}</p></a>`;
  }).join('')}`;
}
function checkWatches() {
  if (!stock) return;
  let changed = false;
  for (const w of watches()) {
    const m = stockModel(w.modelId);
    const has = !!m && m.remaining > 0;
    if (has && !w.notified) {
      bridge.notify(`${w.item}：候補輔具已到貨`, `${w.name} 目前剩餘 ${m.remaining} 件，請儘速預約。`, (t, c) => toast(`${t}｜${c}`, 6000));
      w.notified = true; changed = true;
    } else if (!has && w.notified) { w.notified = false; changed = true; }
  }
  if (changed) save();
}
function stockNote() {
  if (!stock) return '';
  const t = new Date(stock.fetchedAt);
  // 一行就好：來源寫在「資料來源」頁
  return `<p class="small stock-note">${stock.stale ? `官網連不上，顯示 ${fmtTime(t)} 的庫存` : `庫存 ${fmtTime(t)} 更新`}${stock.refreshing ? '・正在更新…' : ''}</p>`;
}

// 畫面中間跳出的確認視窗（用 <dialog>），回傳 Promise<boolean>
function confirmDialog(title, text, okLabel, tone = 'danger') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm-dialog';
    d.innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="btn-row"><button class="btn" value="no">返回</button><button class="btn ${tone === 'danger' ? 'danger-fill' : 'primary'}" value="yes">${esc(okLabel)}</button></div>`;
    const done = (ok) => { d.close(); d.remove(); resolve(ok); };
    d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.value === 'yes')));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(d);
    d.showModal();
  });
}

// 畫面中間跳出的小表單（取貨、歸還用），回傳 form 元素或 null
function formDialog(title, fields, okLabel, onMount) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm-dialog';
    d.innerHTML = `<h3>${esc(title)}</h3><form method="dialog" class="form">${fields}
      <div class="btn-row"><button class="btn" value="no">返回</button><button class="btn primary" value="yes">${esc(okLabel)}</button></div></form>`;
    const form = d.querySelector('form');
    const done = (ok) => { d.close(); d.remove(); resolve(ok ? form : null); };
    form.addEventListener('submit', (e) => { e.preventDefault(); done(e.submitter?.value === 'yes'); });
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(d);
    onMount?.(form);
    d.showModal();
  });
}

// 在台北通裡填資料預約（web/js/reserve.js）
function reserve(_m, q) {
  if (suspension()) return suspendedPage(suspension());
  const item = q.get('item') || '';
  const center = q.get('center');
  const wait = q.get('wait') === '1';
  const model = stock?.categories.flatMap((c) => c.models).find((m) => m.id === Number(q.get('model')));
  if (!model || (!wait && !CENTER_SHORT[center])) {
    return { title: '填寫預約資料', html: `<p>${stock ? '找不到這個款式，可能已經更新了。' : '庫存載入中…'}</p><a class="btn" href="#/borrow?step=item">回去選輔具</a>` };
  }
  if (!wait && activeLoanFor(model.id)) {
    return { title: '填寫預約資料', html: `<div class="alert warn">你已經預約這款了，取貨或取消後才能再預約。</div><a class="btn primary" href="#/loan/${activeLoanFor(model.id).id}">查看預約</a>` };
  }
  return reservePage({
    esc, toast, confirmDialog, replaceTo, render, item, center, model, wait,
    catId: stock.categories.find((c) => c.models.includes(model))?.id,
    centerShort: CENTER_SHORT,
    addWatch(centers) {
      state.watches = watches().filter((w) => w.modelId !== model.id);
      watches().push({ modelId: model.id, item, name: `${model.name}${model.spec ? ` ${model.spec}` : ''}`, at: now().toISOString(), official: true, centers });
      save();
    },
    centerName: wait ? '' : shortName(centerById(center)),
    pickup: wait ? { status: 'wait', deadline: '' } : (() => {
      const p = pickupStatus(HOURS[center], now(), now());
      return { status: p.status, deadline: p.deadline ? `${fmtDate(p.deadline)} ${fmtTime(p.deadline)}` : '' };
    })(),
    addLoan({ item: name, model: modelName, centerId, official }) {
      const loan = {
        id: newId(), item: name, model: modelName, modelId: model.id, centerId, official, viaApp: true,
        reservedAt: now().toISOString(), renewed: false, notified: [], checks: { pickup: [], return: [] },
      };
      state.loans.push(loan);
      save();
      return loan.id;
    },
  });
}

// ---------- 停權 ----------
// 逾期歸還停權中：回傳停權到哪天（多筆取最晚），沒有就 null
function suspension() {
  const until = state.loans.filter((l) => l.returnedAt && !l.cancelledAt)
    .map((l) => loanStatus(l).s).filter((s) => s.suspendedNow).map((s) => +s.suspendedUntil);
  return until.length ? new Date(Math.max(...until)) : null;
}
// 停權期間擋下預約、候補、記下預約
function suspendedPage(until) {
  return {
    title: '暫停借用',
    html: `<div class="alert danger">逾期歸還，停權到 <strong>${fmtDate(until)}</strong>（還有 ${diffDays(now(), until)} 天）。<br>這段期間不能預約或登記候補。</div>
    <p class="small">依臺北市二手輔具借用規定，逾期歸還須停權至歸還後滿 3 個月。</p>
    <div class="btn-row"><a class="btn primary big" href="#/">回首頁</a></div>`,
  };
}

// ---------- 頁面 ----------
function home() {
  const loans = state.loans.map((l) => ({ l, st: loanStatus(l) }));
  const done = (l) => l.returnedAt || l.cancelledAt;
  const active = loans.filter((x) => !done(x.l)).sort((a, b) => TONE_RANK[a.st.tone] - TONE_RANK[b.st.tone]);
  const returned = loans.filter((x) => done(x.l));
  const until = suspension();
  return {
    title: '輔具接力站',
    html: `
    ${until ? `<div class="alert danger">逾期歸還，<strong>${fmtDate(until)}</strong> 前不能再借。</div>` : ''}
    <div class="big-actions">
      <a class="big-btn ${until ? 'disabled' : ''}" href="#/borrow"><span>🦽</span><div><strong>我要借二手輔具（免費）</strong>${until ? `<small>停權中，${fmtDate(until)} 後才能借</small>` : ''}</div></a>
      <a class="big-btn" href="#/centers"><span>🏥</span><div><strong>輔具中心</strong></div></a>
    </div>
    ${active.length ? `<h2>我的借用</h2>${active.map(({ l, st }) => `
      <article class="card tone-border-${st.tone}">
        <a class="card-link" href="#/loan/${l.id}">
          <div class="card-head"><h3>${esc(l.item)}</h3><span class="chip ${st.tone}">${st.label}</span></div>
          <p class="line tone-${st.tone}">${st.text}</p>${st.note ? `<p class="small">${st.note}</p>` : ''}
        </a>
        ${st.s.stage === 'reserved' && st.s.pickup.status !== 'expired' ? `<h4>出門前檢查</h4>${checklist(l, 'pickup')}` : ''}
      </article>`).join('')}` : ''}
    ${watchList()}
    ${returned.length ? `<details class="returned"><summary>過去的紀錄（${returned.length}）</summary>${returned.map(({ l, st }) => `
      <a class="card link" href="#/loan/${l.id}"><div class="card-head"><h3>${esc(l.item)}</h3><span class="chip muted">${st.label}</span></div><p class="line tone-${st.tone}">${st.text}</p></a>`).join('')}</details>` : ''}
    <p class="footer-links"><a href="#/official">查詢我在官網的預約、候補</a></p>
    <p class="footer-links"><a href="#/loan/new">用電話預約了？手動記下</a></p>
    <p class="footer-links"><a href="#/sources">資料來源</a></p>
    `,
    mount() { runReminders(); checkWatches(); },
  };
}

function borrow(_m, q) {
  if (suspension()) return suspendedPage(suspension());
  const step = q.get('step') || 'county';
  const item = q.get('item') || '';
  if (step === 'out') {
    return {
      title: '借用資格',
      html: `<div class="alert warn">請至「輔具資源入口網」查詢各縣市</div>
      <div class="btn-row"><button class="btn primary big" data-act="link" data-url="${LINKS.portal}">開啟輔具資源入口網</button></div>
      <p class="small">有長照需求也可以撥長照專線</p>
      <div class="btn-row"><button class="btn" data-act="call" data-phone="1966">${ICON.phone} 撥打 1966</button></div>`,
    };
  }
  if (step === 'agree') {
    // 官網「二手輔具借用須知」最後的三點注意事項，原文照錄；三個都勾才能繼續
    return {
      title: '借用注意事項',
      html: `<h2>請閱讀並勾選以下三點</h2>
      <form id="agree-form" class="form">
        <ul class="checklist agree">${AGREEMENTS.map((t, i) => `<li><label><input type="checkbox" name="a${i}"> <span>${esc(t)}</span></label></li>`).join('')}</ul>
        <p class="small">法定傳染病說明請見<button type="button" class="linkish" data-act="link" data-url="https://www.cdc.gov.tw/Disease/Index">衛生福利部疾病管制署「傳染病介紹」</button></p>
        <div class="btn-row"><a class="btn" href="#/">我不同意</a><button class="btn primary" type="submit" disabled>我同意</button></div>
      </form>`,
      mount() {
        const f = document.getElementById('agree-form');
        const ok = f.querySelector('button[type=submit]');
        f.addEventListener('change', () => { ok.disabled = !AGREEMENTS.every((_, i) => f[`a${i}`].checked); });
        // 用 replace：在「想借什麼？」按返回直接回首頁，不會再回到資格、注意事項
        f.addEventListener('submit', (e) => { e.preventDefault(); replaceTo('#/borrow?step=item'); });
      },
    };
  }
  if (step === 'item') {
    // 一頁搞定：直接點輔具；不確定的話先點上面的需求，建議的輔具會排到最前面並標出來。
    // 需求放在網址裡（replace，不留瀏覽紀錄），點進「借XX」後按返回還會保留。
    const ids = (q.get('needs') || '').split(',').filter(Boolean);
    const picked = NEEDS.filter((n) => ids.includes(n.id));
    const rec = new Set(picked.flatMap((n) => n.items));
    // 有即時庫存時用官網的 12 大類（含「其他」），沒有時用須知列的項目
    const all = stock ? [...stock.categories.map((c) => c.name), '爬梯機'] : [...ITEMS, '爬梯機', '其他輔具'];
    const tile = (it) => {
      const href = it === '爬梯機' ? '#/borrow?step=stair' : `#/borrow?step=plan&item=${encodeURIComponent(it)}`;
      const c = stockCat(it);
      const badge = c ? (c.remaining > 0 ? `<small class="tone-ok">剩 ${c.remaining}</small>` : '<small class="tone-warn">排隊中</small>') : '';
      // 圖片：官網各大類的代表圖（web/img/items/{類別編號}.jpg，從官網下載縮小）；爬梯機沒有，用線條圖示
      const imgId = c?.id ?? ITEM_IMG[it];
      const thumb = imgId ? `<img src="img/items/${imgId}.jpg" alt="" loading="lazy" onerror="this.remove()">` : ICON.stairs;
      return `<a class="item has-img ${rec.has(it) ? 'rec' : ''}" href="${href}">${thumb ? `<span class="thumb">${thumb}</span>` : ''}
        <span class="name">${rec.has(it) ? '👍 ' : ''}${esc(it === '其他輔具' ? '其他' : it)}</span>${badge}</a>`;
    };
    const recItems = all.filter((it) => rec.has(it));
    const others = all.filter((it) => !rec.has(it));
    return {
      title: '想借什麼？',
      html: `<details class="needs" ${picked.length || q.get('open') ? 'open' : ''}><summary>🤔 不確定借哪種？點選需求</summary>
        <div class="chips">${NEEDS.map((n) => `<button class="need-chip ${ids.includes(n.id) ? 'on' : ''}" data-act="need" data-id="${n.id}">${esc(n.label)}</button>`).join('')}</div>
        ${picked.length ? '<p class="small">只是建議，不確定可先打電話問輔具中心</p>' : ''}
      </details>
      ${recItems.length ? `<h2>建議</h2><div class="item-grid">${recItems.map(tile).join('')}</div><h2>其他</h2>` : '<h2>點選要借的輔具</h2>'}
      ${stockNote()}
      <div class="item-grid">${others.map(tile).join('')}</div>`,
    };
  }
  if (step === 'stair') {
    return {
      title: '爬梯機',
      html: `<div class="alert info">爬梯機要先<strong>預約評估</strong>，不能直接借。</div>
      <div class="btn-row"><button class="btn primary big" data-act="link" data-url="${LINKS.stairEval}">去官網預約評估</button></div>
      <h2>輔具中心</h2>${locateButton()}${sortedCenters().map((x) => centerCard(x, false)).join('')}`,
    };
  }
  if (step === 'plan' && stockCat(item)) {
    const cat = stockCat(item);
    // 從首頁「到貨通知」點進來時，等待中的那款排最上面
    const focus = Number(q.get('focus')) || null;
    const models = [...cat.models].sort((a, b) => (b.id === focus) - (a.id === focus) || (b.remaining > 0) - (a.remaining > 0));
    const waitBtns = (m) => {
      const w = watches().find((x) => x.modelId === m.id);
      if (w?.official) {
        return `<p class="small">已在官網候補（${(w.centers || []).map((c) => CENTER_SHORT[c]).join('、')}），有貨時也會通知你</p>
          <a class="btn danger-outline" href="#/official">查看或取消候補</a>`;
      }
      return `${w
        ? `<button class="btn" data-act="unwatch" data-model="${m.id}">${ICON.bell} 已設定到貨通知（取消）</button>`
        : `<button class="btn primary" data-act="watch" data-model="${m.id}" data-item="${esc(item)}">${ICON.bell} 有貨時通知我</button>`}
        <a class="btn ghost" href="#/reserve?wait=1&model=${m.id}&item=${encodeURIComponent(item)}">登記候補（排隊）</a>`;
    };
    const modelCard = (m) => `<article class="card model ${m.id === focus ? 'focus' : ''}">
      ${m.id === focus ? '<p class="focus-tag">你等待中的款式</p>' : ''}
      <div class="model-top">
        <span class="model-img"><img src="img/models/${m.id}.jpg" alt="${esc(m.name)}" loading="lazy" onerror="this.onerror=null;this.src='img/items/${cat.id}.jpg'"></span>
        <div class="model-info">
          <h3>${esc(m.name)}</h3>
          ${m.spec ? `<p class="model-spec">${esc(m.spec)}</p>` : ''}
          ${m.remaining > 0 ? `<span class="chip ok">剩 ${m.remaining}</span>` : `<span class="chip warn">排隊 ${m.waiting} 人</span>`}
        </div>
      </div>
      ${m.remaining > 0 && m.centers ? `<p class="centers-stock">${Object.entries(m.centers).map(([k, n]) => `<span class="${n > 0 ? 'has' : ''}">${CENTER_SHORT[k]} ${n}</span>`).join('')}</p>` : ''}
      ${m.desc ? `<details class="more"><summary>說明</summary><p class="small">${esc(m.desc).replace(/\n/g, '<br>')}</p></details>` : ''}
      ${activeLoanFor(m.id) ? `<div class="btn-row"><a class="btn" href="#/loan/${activeLoanFor(m.id).id}">你已預約這款，查看</a></div>` : `<div class="btn-row ${m.remaining > 0 ? '' : 'stack'}">${m.remaining > 0
        ? Object.entries(m.centers || {}).filter(([, n]) => n > 0).map(([k]) => `<a class="btn primary" href="#/reserve?center=${k}&model=${m.id}&item=${encodeURIComponent(item)}">在${CENTER_SHORT[k]}預約</a>`).join('')
          || `<button class="btn primary" data-act="link" data-url="${OFFICIAL}/chooseCenterCategory/${m.id}">去官網預約這款</button>`
        : waitBtns(m)}</div>`}
    </article>`;
    return {
      title: `借${item}`,
      html: `${stockNote()}
      ${cat.remaining > 0 ? '' : '<div class="alert warn">目前都借完了。可以「登記候補」排隊，或按「有貨時通知我」</div>'}
      <h2>選款式</h2>${models.map(modelCard).join('')}`,
    };
  }
  if (step === 'plan' && stockLoading) {
    return { title: `借${item}`, html: '<p class="loading">庫存載入中…</p>' };
  }
  if (step === 'plan') {
    return {
      title: `借${item}`,
      html: `<ol class="steps">
        <li><strong>選中心</strong>（看下面）</li>
        <li><strong>到官網預約</strong>
          <div class="btn-row"><button class="btn primary" data-act="link" data-url="${LINKS.reserve}">去官網預約</button></div>
          <p class="small">官網顯示沒有庫存？換其他中心查，或打電話問中心什麼時候會有</p></li>
        <li><strong>回來記下預約</strong>
          <div class="btn-row"><a class="btn" href="#/loan/new?item=${encodeURIComponent(item)}">記下預約</a></div></li>
      </ol>
      <h2>選中心</h2>${locateButton()}${sortedCenters().map((x) => centerCard(x)).join('')}`,
    };
  }
  return {
    title: '借用資格',
    html: `<h2>使用的人戶籍在臺北市嗎？</h2>
    <div class="choice">
      <a class="btn primary big" href="#/borrow?step=agree" data-act="go">是，戶籍在臺北市</a>
      <a class="btn big" href="#/borrow?step=out">不是</a>
    </div>`,
  };
}

let autoLocated = false;
function centers() {
  return {
    title: '輔具中心',
    html: `<p class="small">已排除國定假日；臨時休館請以中心公告為準</p>
    ${myLoc ? `<p class="small">${ICON.pin} 已依離你的距離排序</p>` : locateButton()}
    ${sortedCenters().map((x) => centerCard(x)).join('')}`,
    mount() {
      // 打開就自動定位一次；拒絕或失敗時保留「依距離排序」按鈕可以再試
      if (myLoc || autoLocated) return;
      autoLocated = true;
      const btn = document.querySelector('[data-act=locate]');
      if (btn) actions.locate(btn);
    },
  };
}

function newLoan(_m, q) {
  if (suspension()) return suspendedPage(suspension());
  const item = q.get('item') || '';
  const isKnown = ITEMS.includes(item);
  const centerId = CENTERS.some((c) => c.id === q.get('center')) ? q.get('center') : CENTERS[0].id;
  return {
    title: '記下預約',
    html: `<form id="loan-form" class="form">
      <label>輔具
        <select name="item">${ITEMS.map((it) => `<option ${it === item ? 'selected' : ''}>${esc(it)}</option>`).join('')}
          <option value="__other" ${item && !isKnown ? 'selected' : ''}>其他</option></select>
      </label>
      <label class="other-item" ${item && !isKnown ? '' : 'hidden'}>輔具名稱<input name="itemOther" value="${item && !isKnown && item !== '其他輔具' ? esc(item) : ''}" placeholder="例如：洗澡便盆椅"></label>
      <fieldset><legend>中心</legend>${CENTERS.map((c, i) => `
        <label class="radio"><input type="radio" name="center" value="${c.id}" ${c.id === centerId ? 'checked' : ''}> ${esc(shortName(c))}</label>`).join('')}
      </fieldset>
      <div class="field-row">
        <label>預約日期<select name="resDate"></select></label>
        <label>時間<select name="resTime"></select></label>
      </div>
      <p class="small">只能選該中心的開館時間</p>
      <div id="pickup-preview" class="alert info"></div>
      <button class="btn primary big" type="submit">儲存預約</button>
    </form>`,
    mount() {
      const f = document.getElementById('loan-form');
      let slots = [];
      // 依中心重建日期、時間選單，盡量保留原本選的時間
      const rebuild = () => {
        const keep = f.resTime.value ? Number(f.resTime.value) : null;
        slots = reservationSlots(HOURS[f.center.value], now());
        const days = [...new Set(slots.map((d) => toDateInput(d)))];
        const pick = slots.find((d) => d.getTime() === keep) || nearestSlot(slots, now());
        f.resDate.innerHTML = days.map((d) => `<option value="${d}" ${pick && toDateInput(pick) === d ? 'selected' : ''}>${fmtDate(fromDateInput(d))}</option>`).join('');
        fillTimes(pick);
      };
      const fillTimes = (pick) => {
        const day = f.resDate.value;
        const list = slots.filter((d) => toDateInput(d) === day);
        const sel = pick && toDateInput(pick) === day ? pick.getTime() : list[0]?.getTime();
        f.resTime.innerHTML = list.map((d) => `<option value="${d.getTime()}" ${d.getTime() === sel ? 'selected' : ''}>${fmtTime(d)}</option>`).join('');
      };
      const preview = () => {
        const box = document.getElementById('pickup-preview');
        f.querySelector('.other-item').hidden = f.item.value !== '__other';
        if (!f.resTime.value) {
          box.className = 'alert warn';
          box.textContent = '這幾天這個中心沒有開館';
          return;
        }
        const p = pickupStatus(HOURS[f.center.value], new Date(Number(f.resTime.value)), now());
        const pt = pickupText(p);
        box.className = `alert ${pt.tone === 'muted' ? 'warn' : pt.tone}`;
        box.innerHTML = `${pt.text}${p.status === 'impossible' ? '，建議換中心' : ''}`;
      };
      f.addEventListener('change', (e) => {
        if (e.target.name === 'center') rebuild();
        if (e.target.name === 'resDate') fillTimes(null);
        preview();
      });
      rebuild();
      preview();
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!f.resTime.value) { toast('請選開館時間'); return; }
        const name = f.item.value === '__other' ? (f.itemOther.value.trim() || '輔具') : f.item.value;
        const loan = {
          id: newId(),
          item: name,
          centerId: f.center.value,
          reservedAt: new Date(Number(f.resTime.value)).toISOString(),
          renewed: false,
          notified: [],
          checks: { pickup: [], return: [] },
        };
        state.loans.push(loan);
        save();
        replaceTo(`#/loan/${loan.id}`);
      });
    },
  };
}

function timeline(loan, st) {
  const rows = [];
  rows.push(['預約', fmtDate(loan.reservedAt) + ' ' + fmtTime(loan.reservedAt), true]);
  if (loan.cancelledAt) {
    rows.push(['取消', fmtDate(loan.cancelledAt) + ' ' + fmtTime(loan.cancelledAt), true]);
    return `<ol class="timeline">${rows.map(([k, v, done]) => `<li class="${done ? 'done' : ''}"><span>${k}</span><strong>${v}</strong></li>`).join('')}</ol>`;
  }
  if (st.s.stage === 'reserved') {
    rows.push(['取件期限', st.s.pickup.deadline ? fmtSmart(st.s.pickup.deadline) : '沒有開館時段', false]);
  }
  rows.push(['取貨', loan.pickedUpAt ? fmtDate(loan.pickedUpAt) : '尚未取貨', !!loan.pickedUpAt]);
  rows.push([loan.renewed ? '到期日（已續借）' : '到期日', loan.dueDate ? fmtDate(loan.dueDate) : '取貨後 3 個月', !!loan.returnedAt]);
  rows.push(['歸還', loan.returnedAt ? fmtDate(loan.returnedAt) : '—', !!loan.returnedAt]);
  return `<ol class="timeline">${rows.map(([k, v, done]) => `<li class="${done ? 'done' : ''}"><span>${k}</span><strong>${v}</strong></li>`).join('')}</ol>`;
}

function loanDetail(m) {
  const loan = state.loans.find((l) => l.id === m[1]);
  if (!loan) return { title: '找不到', html: '<p>找不到這筆紀錄。</p><a class="btn" href="#/">回首頁</a>' };
  const c = centerById(loan.centerId);
  const st = loanStatus(loan);
  const s = st.s;
  let body = '';
  if (s.stage === 'cancelled') {
    body += `<div class="alert info">${fmtDate(loan.cancelledAt)} ${fmtTime(loan.cancelledAt)} 已取消預約${loan.cancelNote ? `（${esc(loan.cancelNote)}）` : ''}</div>`;
  } else if (s.stage === 'reserved') {
    const p = s.pickup;
    // 下一步：預約完最常見的問題是「然後呢？」，直接講清楚
    if (p.status !== 'impossible' && p.status !== 'expired') {
      body += `<div class="next-step"><h3>下一步</h3><ol>
        <li><strong>${fmtSmart(p.deadline)} 前</strong>帶身分證到${esc(shortName(c))}取貨</li>
        <li>取貨後回來按下方「已完成借用」，我們會提醒你歸還日</li></ol></div>`;
    }
    body += p.intervals.length
      ? `<div class="card"><h3>可取貨時段</h3><ul class="plain">${p.intervals.map((iv) => `<li>${dayWord(iv.start)} ${fmtTime(iv.start)}–${fmtTime(iv.end)}</li>`).join('')}</ul></div>`
      : '';
    const warn = p.status === 'impossible' ? '取件期限內本中心無開館時段，請先致電確認取件方式。'
      : p.status === 'expired' ? '已逾取件期限，預約可能已取消，請致電確認或重新預約。' : '';
    body += `<div class="card"><h3>取貨地點：${esc(shortName(c))}</h3>
        ${warn ? `<div class="alert danger">${warn}</div>` : ''}
        <p class="line">${openLine(c)}</p>${centerActions(c)}
        ${p.status === 'expired' ? '<div class="btn-row"><a class="btn" href="#/borrow">重新預約</a></div>' : ''}
        ${centerInfo(c)}</div>
      <div class="card"><h3>出門前檢查</h3>${checklist(loan, 'pickup')}</div>
      <section class="card actions-card"><h3>辦理</h3>
        <button class="btn primary big" data-act="pickedUp" data-loan="${loan.id}">已完成借用（已取貨）</button>
        <button class="btn danger-outline big" data-act="cancelLoan" data-loan="${loan.id}">取消預約</button>
        <p class="small">不需要時請取消預約，以利其他民眾借用。</p></section>`;
  } else if (s.stage === 'borrowed') {
    body += `<div class="days tone-${st.tone}"><span>${s.daysLeft < 0 ? '已逾期' : '距到期日'}</span><strong>${Math.abs(s.daysLeft)}</strong><span>天</span></div>`;
    if (s.level === 'overdue') {
      body += `<div class="alert danger">逾期會停權。今天還，<strong>${fmtDate(addMonths(startOfDay(now()), 3))}</strong> 起才能再借。</div>`;
    }
    body += `<div class="card"><h3>歸還前準備</h3>${checklist(loan, 'return')}</div>`;
    body += s.canRenew
      ? `<form class="card form" id="renew-form"><h3>續借</h3>
          <p class="small">若具特殊需求，得申請續借 1 次。請先洽輔具中心辦理，辦妥後再更新到期日。</p>
          <div class="btn-row"><button type="button" class="btn" data-act="call" data-phone="${c.phone}">${ICON.phone} 洽輔具中心</button></div>
          <label>新的到期日（依中心核定）<input type="date" name="dueDate" value="${toDateInput(addMonths(new Date(loan.dueDate), 3))}"></label>
          <p class="small">此日期僅供本 App 提醒使用，實際到期日以輔具中心核定為準。</p>
          <button class="btn" type="submit">已辦妥續借</button></form>`
      : '<div class="alert info">已續借 1 次，請於期限內歸還。</div>';
    body += `<section class="card actions-card"><h3>辦理</h3>
        <button class="btn primary big" data-act="returned" data-loan="${loan.id}">已歸還</button></section>
      <div class="card"><h3>${esc(shortName(c))}</h3><p class="line">${openLine(c)}</p>${centerActions(c)}${centerInfo(c)}</div>`;
  } else {
    body += s.late
      ? `<div class="alert ${s.suspendedNow ? 'danger' : 'info'}">${s.suspendedNow ? `逾期歸還，停權到 <strong>${fmtDate(s.suspendedUntil)}</strong>（還有 ${diffDays(now(), s.suspendedUntil)} 天）` : '停權已結束，可以再借。'}</div>`
      : '<div class="alert ok">準時歸還，可以再借。</div>';
  }
  return {
    title: loan.item,
    html: `<section class="detail-head"><h2>${esc(loan.item)}</h2><p class="small">${loan.model ? `${esc(loan.model)}・` : ''}${esc(shortName(c))}${loan.official ? '・已在官網預約' : ''}</p>
      <p class="status tone-${st.tone}">${st.text}</p>${st.note ? `<p class="small">${st.note}</p>` : ''}</section>
      ${timeline(loan, st)}
      ${body}
      <nav class="page-end"><a class="btn ghost big" href="#/">回首頁</a></nav>
      ${loan.viaApp ? '' : `<details class="more danger-zone"><summary>其他</summary>
        <p class="small">這筆是手動記的。記錯了可以刪除，不會影響官網或中心的預約。</p>
        <button class="btn ghost" data-act="delete" data-loan="${loan.id}">刪除這筆紀錄</button></details>`}`,
    mount() {
      const rf = document.getElementById('renew-form');
      if (rf) rf.addEventListener('submit', (e) => {
        e.preventDefault();
        loan.dueDate = fromDateInput(rf.dueDate.value).toISOString();
        loan.renewed = true;
        loan.notified = [];
        save(); toast('已更新到期日'); render();
      });
    },
  };
}

// ---------- 查詢官網的預約、候補（官網「服務預約查詢與取消」） ----------
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.json()).catch(() => ({ errors: ['連不上伺服器，請稍後再試'] }));
let officialWho = null; // 只留在記憶體，不存
function renderOfficial(q) {
  const box = document.getElementById('q-result');
  if (!box) return;
  if (q.errors) { box.innerHTML = `<div class="alert danger">${esc(q.errors[0])}</div>`; return; }
  const today = toDateInput(now());
  const rents = q.rents || [];
  const waits = q.waits || [];
  if (!rents.length && !waits.length) { box.innerHTML = '<p>官網查不到紀錄。請確認姓名、身分證字號和預約時填的電話。</p>'; return; }
  box.innerHTML = `${waits.length ? `<h2>候補</h2>${waits.map((w, i) => `<div class="card">
      <div class="card-head"><h3>${esc(w.item.split(' / ')[0])}</h3><span class="chip ${/取消/.test(w.status) ? 'muted' : 'info'}">${esc(w.status)}</span></div>
      <p class="line">${esc(w.item.split(' / ').slice(1).join(' '))}</p>
      <p class="small">${w.date ? `${fmtDate(fromDateInput(w.date))} 登記` : ''}${w.seq ? `・候補第 ${esc(w.seq)} 位` : ''}</p>
      ${w.cancelUrl ? `<div class="btn-row"><button class="btn danger-outline" data-act="officialCancel" data-wait="${i}">取消候補</button></div>` : ''}</div>`).join('')}` : ''}
    ${rents.length ? `<h2>預約</h2>${rents.map((r) => {
    const live = !r.cancelled && r.items.some((x) => x.deadline >= today);
    return `<div class="card">
      <div class="card-head"><h3>${esc(r.center.replace('臺北市', ''))}</h3><span class="chip ${r.cancelled ? 'muted' : live ? 'info' : 'muted'}">${r.cancelled ? '已取消' : live ? '等待取貨' : '已過期限'}</span></div>
      <p class="small">${r.date ? `${fmtDate(fromDateInput(r.date))} 預約` : ''}・編號 ${esc(r.no)}</p>
      <ul class="plain">${r.items.map((x, i) => `<li><strong>${esc(x.item)}</strong> ${esc(x.spec)}${x.deadline && !r.cancelled ? `<br><span class="small">領取期限 ${fmtDate(fromDateInput(x.deadline))}</span>` : ''}
        ${x.cancelUrl ? `<div class="btn-row"><button class="btn danger-outline" data-act="officialCancel" data-no="${esc(r.no)}" data-index="${i}">取消預約</button></div>` : ''}</li>`).join('')}</ul></div>`;
  }).join('')}` : ''}`;
}
async function runOfficialQuery() {
  const box = document.getElementById('q-result');
  if (!box || !officialWho) return;
  box.innerHTML = '<p>查詢中…</p>';
  renderOfficial(await postJson('/api/query', officialWho));
}
function officialPage() {
  return {
    title: '官網預約紀錄',
    html: `<p class="small">用預約時填的資料，查臺北市輔具資源整合資訊網上的預約和候補，也可以在這裡取消</p>
      <form id="q-form" class="form card">
        <label>姓名<input name="name" autocomplete="name"></label>
        <label>身分證字號<input name="idno" autocapitalize="characters"></label>
        <label>電話（預約時填的）<input name="phone" type="tel"></label>
        <button class="btn primary big" type="submit">查詢</button>
      </form>
      <div id="q-result"></div>`,
    async mount() {
      const f = document.getElementById('q-form');
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        officialWho = { name: f.name.value.trim(), idno: f.idno.value.trim().toUpperCase(), phone: f.phone.value.trim() };
        runOfficialQuery();
      });
      // 有台北通帳號資料就直接帶入並查詢
      const who = officialWho || await accountWho();
      if (who && document.getElementById('q-form') === f) {
        f.name.value = who.name; f.idno.value = who.idno; f.phone.value = who.phone;
        officialWho = who;
        runOfficialQuery();
      }
    },
  };
}

function sources() {
  return {
    title: '資料來源',
    html: `<ul class="sources">
      <li><strong>中心名稱、開放時間、地址、電話</strong><br>臺北市政府社會局「臺北市二手輔具資源提供單位」，政府資料開放授權條款第 1 版。<br><button class="linkish" data-act="link" data-url="${LINKS.dataset}">data.gov.tw/dataset/135817</button></li>
      <li><strong>借用規則、入口提示、可借項目</strong><br>臺北市輔具資源整合資訊網「二手輔具借用須知」。<br><button class="linkish" data-act="link" data-url="${LINKS.reserve}">tpap.taipei/app37/rentView/intaipei</button></li>
      <li><strong>即時庫存、款式、排隊人數</strong><br>臺北市輔具資源整合資訊網「二手輔具借用」頁面，每 10 分鐘最多更新一次（經主辦單位同意爬取）。<br><button class="linkish" data-act="link" data-url="https://tpap.taipei/app37/rentView/additem">tpap.taipei/app37/rentView/additem</button></li>
      <li><strong>輔具類別圖片</strong><br>臺北市輔具資源整合資訊網「二手輔具借用」各大類代表圖，縮小後存於本機。</li>
      <li><strong>國定假日</strong><br>行政院人事行政總處「中華民國政府行政機關辦公日曆表」115、116 年，政府資料開放授權條款第 1 版。<br><button class="linkish" data-act="link" data-url="https://data.gov.tw/dataset/14718">data.gov.tw/dataset/14718</button></li>
      <li><strong>座標</strong><br>OpenStreetMap Nominatim 依地址查詢，© OpenStreetMap contributors（ODbL），用來算距離。導航用中心名稱搜尋。</li>
    </ul>
    <ul class="plain">
      <li>預約資料由台北通帳號帶入，送到臺北市輔具資源整合資訊網（經主辦單位同意）。</li>
      <li>紀錄只存在這支手機，不會上傳。</li>
      <li>規則以官方公告和借用單為準。</li>
    </ul>
    <p class="small"><a href="#/demo">示範模式</a></p>`,
  };
}

function demo() {
  return {
    title: '示範模式',
    html: `<p>目前時間：<strong>${fmtDate(now())} ${fmtTime(now())}</strong>${state.demoOffset ? '（示範時間）' : ''}</p>
    <form id="demo-form" class="form card">
      <div class="field-row">
        <label>日期<input type="date" name="d" value="${toDateInput(now())}"></label>
        <label>時間（24 小時制）<select name="hm">${Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`)
          .map((t) => `<option ${t === `${pad(now().getHours())}:${now().getMinutes() < 30 ? '00' : '30'}` ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">套用</button>
        <button class="btn" type="button" data-act="shift" data-days="1">+1 天</button>
        <button class="btn" type="button" data-act="shift" data-days="7">+7 天</button></div>
      <button class="btn ghost" type="button" data-act="realtime">結束示範（回到真實時間和自己的資料）</button>
    </form>
    <div class="card"><h3>示範情境</h3>
      <p class="small">時間設為 11/7（六）16:30，建立 3 筆紀錄：剛預約的輪椅、快到期的照顧床、逾期歸還的氣墊床。</p>
      <div class="btn-row"><button class="btn primary" data-act="seed">載入示範情境</button>
      <button class="btn ghost" data-act="wipe">清除所有資料</button></div></div>
    <div class="card"><h3>通知示範</h3>
      <p class="small">按一下會載入示範情境、把時間調到對的時間點，回到首頁時跳出那一則台北通通知。</p>
      <div class="demo-notify">
        <button class="btn" data-act="demoNotify" data-kind="pickup">取件期限快到（輪椅，剩 30 分鐘）</button>
        <button class="btn" data-act="demoNotify" data-kind="due">明日到期（照顧床）</button>
        <button class="btn" data-act="demoNotify" data-kind="today">今日到期（照顧床）</button>
        <button class="btn" data-act="demoNotify" data-kind="overdue">已逾期（照顧床）</button>
        <button class="btn" data-act="demoNotify" data-kind="restock">候補的輔具到貨了</button>
      </div></div>`,
    mount() {
      document.getElementById('demo-form').addEventListener('submit', (e) => {
        e.preventDefault();
        // 不用 datetime-local：手機設成 12 小時制時會顯示成「4:30」，看不出是下午
        const { d, hm } = e.target;
        if (!d.value) return;
        state.demoOffset = fromDTInput(`${d.value}T${hm.value}`).getTime() - Date.now();
        save(); toast('已套用示範時間'); render();
      });
    },
  };
}

function seedDemo() {
  // 第一次載入示範時，先把自己的紀錄備份起來，「結束示範」時還原
  if (!state.backup) state.backup = { loans: state.loans, watches: state.watches || [] };
  const t = new Date(2026, 10, 7, 16, 30);
  state.demoOffset = t.getTime() - Date.now();
  const iso = (d) => d.toISOString();
  state.watches = [];
  state.loans = [
    { id: newId(), item: '輪椅', centerId: 'heyi', reservedAt: iso(new Date(2026, 10, 7, 16, 25)), renewed: false, notified: [], checks: { pickup: [], return: [] } },
    { id: newId(), item: '居家用照顧床', centerId: 'south', reservedAt: iso(new Date(2026, 7, 11, 10)), pickedUpAt: iso(new Date(2026, 7, 12)), dueDate: iso(new Date(2026, 10, 12)), renewed: false, notified: [], checks: { pickup: [0, 1, 2, 3, 4], return: [] } },
    { id: newId(), item: '氣墊床', centerId: 'west', reservedAt: iso(new Date(2026, 5, 29, 10)), pickedUpAt: iso(new Date(2026, 5, 30)), dueDate: iso(new Date(2026, 8, 30)), returnedAt: iso(new Date(2026, 9, 3)), renewed: false, notified: [], checks: { pickup: [], return: [] } },
  ];
  save();
}

// ---------- 提醒 ----------
function runReminders() {
  let changed = false;
  for (const loan of state.loans) {
    if (loan.cancelledAt) continue;
    const r = reminderFor(loan, HOURS[loan.centerId], now(), fmtSmart);
    if (!r) continue;
    loan.notified = loan.notified || [];
    if (loan.notified.includes(r.key)) continue;
    bridge.notify(r.title, r.content, (title, content) => toast(`${title}｜${content}`, 6000));
    loan.notified.push(r.key);
    changed = true;
    break; // 一次只跳一則，避免洗版
  }
  if (changed) save();
}

// 換頁但不留下瀏覽紀錄（存檔、刪除、載入示範後用），
// 讓台北通的返回鍵不會退回剛送出的表單或已刪除的頁面。
function replaceTo(hash) {
  if (location.hash === hash) render();
  else location.replace(hash);
}

// ---------- 事件 ----------
let toastTimer;
function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const actions = {
  call: (el) => bridge.phoneCall(el.dataset.phone),
  map: (el) => { const c = centerById(el.dataset.center); bridge.launchMap(c.lat, c.lng, c.name); },
  link: (el) => bridge.openLink(el.dataset.url),
  // 換頁但不留瀏覽紀錄
  go: (el) => replaceTo(el.getAttribute('href')),
  watch(el) {
    const m = stockModel(el.dataset.model);
    if (!m) return;
    watches().push({ modelId: m.id, item: el.dataset.item, name: `${m.name}${m.spec ? ` ${m.spec}` : ''}`, at: now().toISOString() });
    save(); toast('有貨時會用台北通通知你'); render();
  },
  unwatch(el) {
    state.watches = watches().filter((w) => w.modelId !== Number(el.dataset.model));
    save(); toast('已取消到貨通知'); render();
  },
  // 備用：不在台北通裡填，直接把這款放進官網購物車（官網保留 1 小時），在官網填資料
  async officialReserve(el) {
    const c = centerById(el.dataset.center);
    if (!await confirmDialog(`在${shortName(c)}預約？`, '接下來會到官網填資料並送出，官網會幫你保留 1 小時', '去填資料')) return;
    bridge.openLink(`${OFFICIAL}/returnList?centerId=${OFFICIAL_CENTER[el.dataset.center]}&typeId=${el.dataset.model}`);
  },
  need(el) {
    const q = new URLSearchParams((location.hash.split('?')[1]) || '');
    const ids = new Set((q.get('needs') || '').split(',').filter(Boolean));
    if (ids.has(el.dataset.id)) ids.delete(el.dataset.id); else ids.add(el.dataset.id);
    // open=1：取消最後一個需求時，區塊仍保持展開
    replaceTo(`#/borrow?step=item&open=1${ids.size ? `&needs=${[...ids].join(',')}` : ''}`);
  },
  async locate(el) {
    el.disabled = true;
    el.textContent = '定位中…';
    myLoc = await bridge.getLocation();
    if (!myLoc) toast('拿不到位置，請確認定位權限');
    render();
  },
  check(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    const list = el.dataset.list;
    const i = Number(el.dataset.i);
    loan.checks = loan.checks || { pickup: [], return: [] };
    const arr = loan.checks[list] || (loan.checks[list] = []);
    const at = arr.indexOf(i);
    if (el.checked && at < 0) arr.push(i);
    if (!el.checked && at >= 0) arr.splice(at, 1);
    save();
  },
  async pickedUp(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    const f = await formDialog('已完成借用（已取貨）', `
      <label>取貨日<input type="date" name="pickedUpAt" value="${toDateInput(now())}" required></label>
      <label>到期日（依借用單）<input type="date" name="dueDate" value="${toDateInput(defaultDueDate(now()))}" required></label>
      <p class="small">此日期僅供本 App 提醒使用，實際到期日以借用單為準。</p>`, '確認', (form) => {
      // 改取貨日時，歸還期限跟著算（除非使用者自己改過）
      let touched = false;
      form.dueDate.addEventListener('input', () => { touched = true; });
      form.pickedUpAt.addEventListener('input', () => {
        if (!touched && form.pickedUpAt.value) form.dueDate.value = toDateInput(defaultDueDate(fromDateInput(form.pickedUpAt.value)));
      });
    });
    if (!f || !f.pickedUpAt.value || !f.dueDate.value) return;
    loan.pickedUpAt = fromDateInput(f.pickedUpAt.value).toISOString();
    loan.dueDate = fromDateInput(f.dueDate.value).toISOString();
    loan.notified = [];
    save(); toast('已記錄取貨，到期前會提醒你'); render();
  },
  async returned(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    const f = await formDialog('已歸還', `<label>歸還日<input type="date" name="returnedAt" value="${toDateInput(now())}" required></label>`, '確認');
    if (!f || !f.returnedAt.value) return;
    loan.returnedAt = fromDateInput(f.returnedAt.value).toISOString();
    save(); render();
  },
  // 取消預約：不刪紀錄，標成「已取消」收進過去的紀錄。真的送到官網的，會在官網一起取消。
  async cancelLoan(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    if (!loan) return;
    const text = loan.official ? '會在官網取消，讓給下一位'
      : loan.viaApp ? '演練模式的預約，只會在這支手機標示取消'
        : '這筆是手動記的，請記得也打電話通知中心';
    if (!await confirmDialog(`確定要取消「${loan.item}」的預約嗎？`, text, '取消預約')) return;
    if (loan.official) {
      const who = await accountWho();
      if (!who) { toast('拿不到台北通帳號資料，請在這頁輸入後查詢、取消', 5000); location.hash = '#/official'; return; }
      el.disabled = true; el.textContent = '取消中…';
      const q = await postJson('/api/query', who);
      const short = CENTER_SHORT[loan.centerId];
      const r = (q.rents || []).find((x) => !x.cancelled && x.center.includes(short) && x.date === toDateInput(loan.reservedAt)
        && x.items.some((i) => i.item === loan.item));
      if (!r) { toast('官網找不到這筆，請在這頁確認', 5000); location.hash = '#/official'; return; }
      const res = await postJson('/api/cancel', { live: true, who, no: r.no, index: r.items.findIndex((i) => i.item === loan.item) });
      if (!res.ok) { toast(res.message || res.errors?.[0] || '取消失敗', 6000); render(); return; }
    }
    loan.cancelledAt = now().toISOString();
    loan.cancelNote = loan.official ? '已在官網取消' : loan.viaApp ? '演練' : '';
    save(); toast('已取消預約'); render();
  },
  async officialCancel(el) {
    if (!officialWho) return;
    const wait = el.dataset.wait != null;
    if (!await confirmDialog(wait ? '確定取消這筆候補？' : '確定取消這筆預約？', '會在官網取消，讓給下一位', '取消')) return;
    el.disabled = true; el.textContent = '取消中…';
    const res = await postJson('/api/cancel', wait
      ? { live: true, who: officialWho, wait: Number(el.dataset.wait) }
      : { live: true, who: officialWho, no: el.dataset.no, index: Number(el.dataset.index) });
    toast(res.dryRun ? '演練模式：沒有真的取消' : (res.message || res.errors?.[0] || ''), 5000);
    runOfficialQuery();
  },
  async delete(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    const note = (loan?.official || loan?.viaApp) && !loan.pickedUpAt ? '只會刪除這支手機上的紀錄，官網的預約不會取消' : '刪除後無法復原';
    if (!await confirmDialog(`確定要刪除「${loan?.item || '這筆紀錄'}」嗎？`, note, '刪除')) return;
    state.loans = state.loans.filter((l) => l.id !== el.dataset.loan);
    save();
    replaceTo('#/');
  },
  shift(el) { state.demoOffset = (state.demoOffset || 0) + Number(el.dataset.days) * 86400000; save(); render(); },
  realtime() {
    state.demoOffset = 0;
    if (state.backup) { state.loans = state.backup.loans; state.watches = state.backup.watches; delete state.backup; }
    save(); toast('已結束示範，回到你的資料'); replaceTo('#/');
  },
  seed() { seedDemo(); replaceTo('#/'); },
  // Demo 用：調到某個時間點，只讓指定的那一則通知跳出來
  demoNotify(el) {
    const kind = el.dataset.kind;
    seedDemo();
    const at = { pickup: [10, 16, 30], due: [11, 10, 0], today: [12, 10, 0], overdue: [14, 10, 0], restock: [7, 16, 30] }[kind];
    state.demoOffset = new Date(2026, 10, ...at).getTime() - Date.now();
    const all = ['pickup-impossible', 'pickup-expired', 'pickup-urgent', 'overdue', ...REMINDER_DAYS.map((d) => `due-${d}`)];
    const target = kind === 'pickup' ? '輪椅' : kind === 'restock' ? null : '居家用照顧床';
    for (const l of state.loans) l.notified = l.item === target ? [] : [...all];
    if (kind === 'restock') {
      const m = stock?.categories.flatMap((c) => c.models.map((x) => ({ ...x, cat: c.name }))).find((x) => x.remaining > 0);
      if (!m) { toast('庫存還沒載入，請稍等再按'); return; }
      state.watches = [{ modelId: m.id, item: m.cat, name: m.name, at: now().toISOString(), official: true, centers: Object.keys(m.centers || {}), notified: false }];
    }
    save(); replaceTo('#/');
  },
  async wipe() {
    if (!await confirmDialog('確定要清除所有資料嗎？', '所有借用紀錄都會刪除，無法復原', '清除')) return;
    state = { loans: [], demoOffset: 0 }; save(); toast('已清除'); render();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.type === 'checkbox') return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('input[type=checkbox][data-act]');
  if (el) actions[el.dataset.act]?.(el, e);
});

// ---------- 路由 ----------
const routes = [
  [/^#\/?$/, home],
  [/^#\/borrow$/, borrow],
  [/^#\/centers$/, centers],
  [/^#\/loan\/new$/, newLoan],
  [/^#\/loan\/([\w-]+)$/, loanDetail],
  [/^#\/sources$/, sources],
  [/^#\/demo$/, demo],
  [/^#\/reserve$/, reserve],
  [/^#\/official$/, officialPage],
];

let lastHash = null;
function render() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.split('?');
  let view = null;
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) { view = fn(m, new URLSearchParams(qs || '')); break; }
  }
  if (!view) view = home();
  document.title = view.title;
  // 在台北通裡，標題和返回鍵由台北通上方的藍色列負責（它顯示 document.title、返回上一頁），
  // 所以網頁不再自己畫標題列和返回鍵，避免出現兩個返回鍵。
  // 一般瀏覽器開啟時才顯示簡單的標題列，返回用瀏覽器自己的。
  const demoChip = state.demoOffset ? '<a class="demo-chip" href="#/demo">示範時間</a>' : '';
  const header = bridge.isInApp()
    ? (demoChip ? `<div class="demo-bar">${demoChip}</div>` : '')
    : `<header class="topbar"><a class="home-link" href="#/">輔具接力站</a><span class="topbar-title">${esc(view.title)}</span>${demoChip}</header>`;
  document.getElementById('app').innerHTML = `${header}<main>${view.html}</main>`;
  if (hash !== lastHash) window.scrollTo(0, 0);
  lastHash = hash;
  view.mount?.();
}

// 從官網按返回回來時，瀏覽器會捲回原位置，最上面的「預約成功了嗎？」會看不到，所以一律從頂端開始
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('hashchange', render);
render();
// 頁面停留時，每分鐘更新一次倒數
setInterval(() => {
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  if (!busyForm()) render();
}, 60000);
