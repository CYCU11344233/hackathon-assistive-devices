import {
  parseHours, openStatus, pickupStatus, loanStage, reminderFor, defaultDueDate,
  addMonths, addDays, diffDays, startOfDay, intervalsOnDate, WEEKDAY_NAMES,
} from './rules.js';
import { CENTERS, ITEMS, LINKS, CHECKLISTS, NEEDS, AGREEMENTS } from './data.js';
import * as bridge from './bridge.js';
import { HOLIDAYS } from './holidays.js';

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
const toDTInput = (d) => `${toDateInput(d)}T${fmtTime(d)}`;
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
    case 'impossible': return { tone: 'danger', text: '2 天內沒開館，無法取貨' };
    case 'expired': return { tone: 'muted', text: `已過取貨期限（${fmtSmart(p.deadline)}）` };
    case 'urgent': return { tone: 'danger', text: `${fmtSmart(p.deadline)} 前取貨，只剩 ${minsText(p.remainingMin)}` };
    default: return { tone: 'info', text: `最晚 ${fmtSmart(p.deadline)} 取貨` };
  }
}

function loanStatus(loan) {
  const s = loanStage(loan, HOURS[loan.centerId], now());
  if (s.stage === 'reserved') return { ...pickupText(s.pickup), s, label: '等待取貨' };
  if (s.stage === 'borrowed') {
    const due = fmtDate(s.due);
    const closed = s.dueClosed && s.level !== 'overdue' ? `，當天休館，${fmtSmart(s.returnBy)} 前送回` : '';
    if (s.level === 'overdue') return { tone: 'danger', text: `逾期 ${-s.daysLeft} 天`, s, label: '借用中' };
    if (s.level === 'urgent') return { tone: 'danger', text: `${s.daysLeft === 0 ? '今天' : '明天'}到期${closed}`, s, label: '借用中' };
    if (s.level === 'soon') return { tone: 'warn', text: `${s.daysLeft} 天後到期${closed}`, s, label: '借用中' };
    return { tone: 'ok', text: `${due} 到期${closed}`, s, label: '借用中' };
  }
  if (s.late && s.suspendedNow) return { tone: 'danger', text: `停權到 ${fmtDate(s.suspendedUntil)}`, s, label: '已歸還' };
  return { tone: 'muted', text: `${fmtDate(loan.returnedAt)} 已歸還`, s, label: '已歸還' };
}

const TONE_RANK = { danger: 0, warn: 1, info: 2, ok: 3, muted: 4 };

// ---------- 共用元件 ----------
function centerActions(c) {
  return `<div class="btn-row">
    <button class="btn" data-act="call" data-phone="${c.phone}">📞 撥號</button>
    <button class="btn" data-act="map" data-center="${c.id}">🧭 導航</button>
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
    return (rank[a.p.status] - rank[b.p.status]) || ((a.dist ?? 0) - (b.dist ?? 0));
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
  return openStatus(HOURS[c.id], now()).open ? `<p class="line tone-${pt.tone}">現在預約：${pt.text}</p>` : '';
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
  return myLoc ? '' : '<button class="btn ghost" data-act="locate">📍 依距離排序</button>';
}

// ---------- 即時庫存 ----------
// 由 serve.mjs 的 /api/stock 提供（爬臺北市輔具資源整合資訊網，快取 10 分鐘）。
// 拿不到時 stock 維持 null，畫面退回沒有庫存資訊的版本。
const OFFICIAL = 'https://tpap.taipei/app37/rentView';
const CENTER_SHORT = { heyi: '合宜', west: '西區', south: '南區' };
// 官網的中心編號
const OFFICIAL_CENTER = { heyi: 1, south: 2, west: 3 };
let stock = null;
fetch('/api/stock')
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (!d?.categories) return;
    stock = d;
    // 正在填表單時不要重畫，避免清掉使用者輸入
    if (!document.getElementById('loan-form') && !document.getElementById('demo-form')) render();
  })
  .catch(() => {});
const stockCat = (name) => stock?.categories.find((c) => c.name === name);
function stockNote() {
  if (!stock) return '';
  const t = new Date(stock.fetchedAt);
  return `<p class="small">即時庫存（${fmtTime(t)} 更新，來源：臺北市輔具資源整合資訊網）${stock.stale ? '・官網暫時連不上，顯示上次資料' : ''}</p>`;
}

// 畫面中間跳出的確認視窗（用 <dialog>），回傳 Promise<boolean>
function confirmDialog(title, text, okLabel) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'confirm-dialog';
    d.innerHTML = `<h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="btn-row"><button class="btn" value="no">取消</button><button class="btn danger-fill" value="yes">${esc(okLabel)}</button></div>`;
    const done = (ok) => { d.close(); d.remove(); resolve(ok); };
    d.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.value === 'yes')));
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(d);
    d.showModal();
  });
}

// ---------- 頁面 ----------
function home() {
  const loans = state.loans.map((l) => ({ l, st: loanStatus(l) }));
  const active = loans.filter((x) => !x.l.returnedAt).sort((a, b) => TONE_RANK[a.st.tone] - TONE_RANK[b.st.tone]);
  const returned = loans.filter((x) => x.l.returnedAt);
  const suspended = returned.find((x) => x.st.s.suspendedNow);
  return {
    title: '二手輔具借用小幫手',
    html: `
    ${suspended ? `<div class="alert danger">逾期歸還，<strong>${fmtDate(suspended.st.s.suspendedUntil)}</strong> 前不能再借。</div>` : ''}
    <div class="big-actions">
      <a class="big-btn" href="#/borrow"><span>🦽</span><div><strong>我要借二手輔具（免費）</strong></div></a>
      <a class="big-btn" href="#/loan/new"><span>📝</span><div><strong>記下預約</strong></div></a>
      <a class="big-btn" href="#/centers"><span>🏥</span><div><strong>輔具中心</strong></div></a>
    </div>
    ${active.length ? `<h2>我的借用</h2>${active.map(({ l, st }) => `
      <a class="card link tone-border-${st.tone}" href="#/loan/${l.id}">
        <div class="card-head"><h3>${esc(l.item)}</h3><span class="chip ${st.tone}">${st.label}</span></div>
        <p class="line tone-${st.tone}">${st.text}</p>
      </a>`).join('')}` : ''}
    ${returned.length ? `<details class="returned"><summary>已歸還（${returned.length}）</summary>${returned.map(({ l, st }) => `
      <a class="card link" href="#/loan/${l.id}"><div class="card-head"><h3>${esc(l.item)}</h3></div><p class="line tone-${st.tone}">${st.text}</p></a>`).join('')}</details>` : ''}
    <p class="footer-links"><a href="#/sources">資料來源</a></p>
    `,
    mount: runReminders,
  };
}

function borrow(_m, q) {
  const step = q.get('step') || 'county';
  const item = q.get('item') || '';
  if (step === 'out') {
    return {
      title: '借用資格',
      html: `<div class="alert warn">請至「輔具資源入口網」查詢各縣市</div>
      <div class="btn-row"><button class="btn primary big" data-act="link" data-url="${LINKS.portal}">開啟輔具資源入口網</button></div>
      <p class="small">有長照需求也可以撥長照專線</p>
      <div class="btn-row"><button class="btn" data-act="call" data-phone="1966">📞 撥打 1966</button></div>`,
    };
  }
  if (step === 'agree') {
    // 官網「二手輔具借用須知」最後的三點注意事項，原文照錄；三個都勾才能繼續
    return {
      title: '借用注意事項',
      html: `<h2>請閱讀並勾選以下三點</h2>
      <form id="agree-form" class="form">
        <ul class="checklist agree">${AGREEMENTS.map((t, i) => `<li><label><input type="checkbox" name="a${i}"> <span>${esc(t)}</span></label></li>`).join('')}</ul>
        <p class="small">法定傳染病說明請見衛生福利部疾病管制署公告</p>
        <div class="btn-row"><a class="btn" href="#/">我不同意</a><button class="btn primary" type="submit" disabled>我同意</button></div>
      </form>`,
      mount() {
        const f = document.getElementById('agree-form');
        const ok = f.querySelector('button[type=submit]');
        f.addEventListener('change', () => { ok.disabled = !AGREEMENTS.every((_, i) => f[`a${i}`].checked); });
        f.addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/borrow?step=item'; });
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
      return `<a class="item ${rec.has(it) ? 'rec' : ''}" href="${href}"><span>${rec.has(it) ? '👍 ' : ''}${esc(it === '其他輔具' ? '其他' : it)}</span>${badge}</a>`;
    };
    const recItems = all.filter((it) => rec.has(it));
    const others = all.filter((it) => !rec.has(it));
    return {
      title: '想借什麼？',
      html: `<details class="needs" ${picked.length ? 'open' : ''}><summary>🤔 不確定借哪種？點選需求</summary>
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
    const models = [...cat.models].sort((a, b) => (b.remaining > 0) - (a.remaining > 0));
    const modelCard = (m) => `<article class="card model">
      <div class="card-head"><h3>${esc(m.name)}</h3>${m.remaining > 0 ? `<span class="chip ok">剩 ${m.remaining}</span>` : `<span class="chip warn">排隊 ${m.waiting} 人</span>`}</div>
      ${m.spec ? `<p class="line">${esc(m.spec)}</p>` : ''}
      ${m.remaining > 0 && m.centers ? `<p class="centers-stock">${Object.entries(m.centers).map(([k, n]) => `<span class="${n > 0 ? 'has' : ''}">${CENTER_SHORT[k]} ${n}</span>`).join('')}</p>` : ''}
      ${m.desc ? `<details class="more"><summary>說明</summary><p class="small">${esc(m.desc).replace(/\n/g, '<br>')}</p></details>` : ''}
      <div class="btn-row">${m.remaining > 0
        ? Object.entries(m.centers || {}).filter(([, n]) => n > 0).map(([k]) => `<button class="btn primary" data-act="reserve" data-center="${k}" data-model="${m.id}">在${CENTER_SHORT[k]}預約</button>`).join('')
          || `<button class="btn primary" data-act="link" data-url="${OFFICIAL}/chooseCenterCategory/${m.id}">去官網預約這款</button>`
        : `<button class="btn" data-act="link" data-url="${OFFICIAL}/waitingRent/${m.id}">去官網登記到貨通知</button>`}</div>
    </article>`;
    return {
      title: `借${item}`,
      html: `${stockNote()}
      ${cat.remaining > 0 ? '' : '<div class="alert warn">目前都借完了，可以登記到貨通知排隊，或打電話問中心</div>'}
      <h2>選款式</h2>${models.map(modelCard).join('')}
      <h2>預約好了？</h2>
      <div class="btn-row"><a class="btn big" href="#/loan/new?item=${encodeURIComponent(item)}">📝 記下預約</a></div>
      <h2>輔具中心</h2>${locateButton()}${sortedCenters().map((x) => centerCard(x)).join('')}`,
    };
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
      <a class="btn primary big" href="#/borrow?step=agree">是，戶籍在臺北市</a>
      <a class="btn big" href="#/borrow?step=out">不是</a>
    </div>`,
  };
}

function centers() {
  return {
    title: '輔具中心',
    html: `<p class="small">已排除國定假日；臨時休館請以中心公告為準</p>
    ${locateButton()}
    ${sortedCenters().map((x) => centerCard(x)).join('')}`,
  };
}

function newLoan(_m, q) {
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
  if (st.s.stage === 'reserved') {
    rows.push(['最晚取貨', st.s.pickup.deadline ? fmtSmart(st.s.pickup.deadline) : '沒有開館時段', false]);
  }
  rows.push(['取貨', loan.pickedUpAt ? fmtDate(loan.pickedUpAt) : '尚未取貨', !!loan.pickedUpAt]);
  rows.push([loan.renewed ? '歸還期限（已續借）' : '歸還期限', loan.dueDate ? fmtDate(loan.dueDate) : '取貨後 3 個月', !!loan.returnedAt]);
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
  if (s.stage === 'reserved') {
    const p = s.pickup;
    body += p.intervals.length
      ? `<div class="card"><h3>可取貨時段</h3><ul class="plain">${p.intervals.map((iv) => `<li>${dayWord(iv.start)} ${fmtTime(iv.start)}–${fmtTime(iv.end)}</li>`).join('')}</ul>
         <p class="small">沒去拿會自動取消</p></div>`
      : '';
    if (p.status === 'impossible' || p.status === 'expired') {
      body += `<div class="card"><h3>${p.status === 'impossible' ? '先打電話確認' : '重新預約'}</h3>
        <div class="btn-row"><button class="btn primary" data-act="call" data-phone="${c.phone}">📞 撥號</button>
        <button class="btn" data-act="link" data-url="${LINKS.reserve}">去官網預約</button></div></div>`;
    }
    body += `<div class="card"><h3>出門前檢查</h3>${checklist(loan, 'pickup')}</div>
      <div class="card"><h3>${esc(shortName(c))}</h3><p class="line">${openLine(c)}</p>${centerActions(c)}${centerInfo(c)}</div>
      <details class="confirm"><summary class="btn primary big">✅ 已完成借用（已取貨）</summary>
        <form class="card form" id="pickup-form">
          <label>取貨日<input type="date" name="pickedUpAt" value="${toDateInput(now())}"></label>
          <label>歸還期限（看借用單）<input type="date" name="dueDate" value="${toDateInput(defaultDueDate(now()))}"></label>
          <button class="btn primary" type="submit">確認已完成借用</button></form></details>`;
  } else if (s.stage === 'borrowed') {
    body += `<div class="days tone-${st.tone}"><strong>${s.daysLeft < 0 ? `逾期 ${-s.daysLeft}` : s.daysLeft}</strong><span>${s.daysLeft < 0 ? '天' : '天後到期'}</span></div>`;
    if (s.level === 'overdue') {
      body += `<div class="alert danger">逾期會停權。今天還，<strong>${fmtDate(addMonths(startOfDay(now()), 3))}</strong> 起才能再借。</div>`;
    }
    body += `<div class="card"><h3>歸還前準備</h3>${checklist(loan, 'return')}</div>`;
    body += s.canRenew
      ? `<form class="card form" id="renew-form"><h3>續借</h3>
          <p class="small">若具特殊需求，得申請續借 1 次。請先洽輔具中心辦理，辦妥後再更新歸還期限。</p>
          <div class="btn-row"><button type="button" class="btn" data-act="call" data-phone="${c.phone}">📞 洽輔具中心</button></div>
          <label>新的歸還期限（依中心核定）<input type="date" name="dueDate" value="${toDateInput(addMonths(new Date(loan.dueDate), 3))}"></label>
          <button class="btn" type="submit">已辦妥續借</button></form>`
      : '<div class="alert info">已續借 1 次，請於期限內歸還。</div>';
    body += `<details class="confirm"><summary class="btn primary big">✅ 已歸還</summary>
        <form class="card form" id="return-form">
          <label>歸還日<input type="date" name="returnedAt" value="${toDateInput(now())}"></label>
          <button class="btn primary" type="submit">確認已歸還</button></form></details>
      <div class="card"><h3>${esc(shortName(c))}</h3><p class="line">${openLine(c)}</p>${centerActions(c)}${centerInfo(c)}</div>`;
  } else {
    body += s.late
      ? `<div class="alert ${s.suspendedNow ? 'danger' : 'info'}">${s.suspendedNow ? `逾期歸還，停權到 <strong>${fmtDate(s.suspendedUntil)}</strong>（還有 ${diffDays(now(), s.suspendedUntil)} 天）` : '停權已結束，可以再借。'}</div>`
      : '<div class="alert ok">準時歸還，可以再借。</div>';
  }
  return {
    title: loan.item,
    html: `<section class="detail-head"><h2>${esc(loan.item)}</h2><p class="small">${esc(shortName(c))}</p>
      <p class="status tone-${st.tone}">${st.text}</p></section>
      ${timeline(loan, st)}
      ${body}
      <div class="danger-zone"><button class="btn ghost" data-act="delete" data-loan="${loan.id}">刪除這筆紀錄</button></div>`,
    mount() {
      const pf = document.getElementById('pickup-form');
      if (pf) {
        let touched = false;
        pf.dueDate.addEventListener('input', () => { touched = true; });
        pf.pickedUpAt.addEventListener('input', () => {
          if (!touched && pf.pickedUpAt.value) pf.dueDate.value = toDateInput(defaultDueDate(fromDateInput(pf.pickedUpAt.value)));
        });
        pf.addEventListener('submit', (e) => {
          e.preventDefault();
          loan.pickedUpAt = fromDateInput(pf.pickedUpAt.value).toISOString();
          loan.dueDate = fromDateInput(pf.dueDate.value).toISOString();
          loan.notified = [];
          save(); render();
        });
      }
      const rf = document.getElementById('renew-form');
      if (rf) rf.addEventListener('submit', (e) => {
        e.preventDefault();
        loan.dueDate = fromDateInput(rf.dueDate.value).toISOString();
        loan.renewed = true;
        loan.notified = [];
        save(); toast('已更新歸還期限'); render();
      });
      const tf = document.getElementById('return-form');
      if (tf) tf.addEventListener('submit', (e) => {
        e.preventDefault();
        loan.returnedAt = fromDateInput(tf.returnedAt.value).toISOString();
        save(); render();
      });
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
      <li><strong>國定假日</strong><br>行政院人事行政總處「中華民國政府行政機關辦公日曆表」115、116 年，政府資料開放授權條款第 1 版。<br><button class="linkish" data-act="link" data-url="https://data.gov.tw/dataset/14718">data.gov.tw/dataset/14718</button></li>
      <li><strong>座標</strong><br>OpenStreetMap Nominatim 依地址查詢，© OpenStreetMap contributors（ODbL），用來算距離。導航用中心名稱搜尋。</li>
    </ul>
    <ul class="plain">
      <li>預約在官網完成，這裡不代替預約，也不需要登入。</li>
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
      <label>把時間設成<input type="datetime-local" name="t" value="${toDTInput(now())}"></label>
      <div class="btn-row"><button class="btn primary" type="submit">套用</button>
        <button class="btn" type="button" data-act="shift" data-days="1">+1 天</button>
        <button class="btn" type="button" data-act="shift" data-days="7">+7 天</button></div>
      <button class="btn ghost" type="button" data-act="realtime">回到真實時間</button>
    </form>
    <div class="card"><h3>示範情境</h3>
      <p class="small">時間設為 11/7（六）16:30，建立 3 筆紀錄：剛預約的輪椅、快到期的照顧床、逾期歸還的氣墊床。</p>
      <div class="btn-row"><button class="btn primary" data-act="seed">載入示範情境</button>
      <button class="btn ghost" data-act="wipe">清除所有資料</button></div></div>`,
    mount() {
      document.getElementById('demo-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = e.target.t.value;
        if (!v) return;
        state.demoOffset = fromDTInput(v).getTime() - Date.now();
        save(); toast('已套用示範時間'); render();
      });
    },
  };
}

function seedDemo() {
  const t = new Date(2026, 10, 7, 16, 30);
  state.demoOffset = t.getTime() - Date.now();
  const iso = (d) => d.toISOString();
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
  // 在台北通選好中心後，直接把這款放進官網購物車（官網保留 1 小時），接著官網的「下一步」就是填資料，
  // 填資料頁有「帶入台北通基本資料」。個資只在官網填寫，不經過我們的伺服器。
  async reserve(el) {
    const c = centerById(el.dataset.center);
    if (!await confirmDialog(`在${shortName(c)}預約？`, '接下來會到官網填資料並送出，官網會幫你保留 1 小時', '去填資料')) return;
    bridge.openLink(`${OFFICIAL}/returnList?centerId=${OFFICIAL_CENTER[el.dataset.center]}&typeId=${el.dataset.model}`);
  },
  need(el) {
    const q = new URLSearchParams((location.hash.split('?')[1]) || '');
    const ids = new Set((q.get('needs') || '').split(',').filter(Boolean));
    if (ids.has(el.dataset.id)) ids.delete(el.dataset.id); else ids.add(el.dataset.id);
    replaceTo(`#/borrow?step=item${ids.size ? `&needs=${[...ids].join(',')}` : ''}`);
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
  async delete(el) {
    const loan = state.loans.find((l) => l.id === el.dataset.loan);
    if (!await confirmDialog(`確定要刪除「${loan?.item || '這筆紀錄'}」嗎？`, '刪除後無法復原', '刪除')) return;
    state.loans = state.loans.filter((l) => l.id !== el.dataset.loan);
    save();
    replaceTo('#/');
  },
  shift(el) { state.demoOffset = (state.demoOffset || 0) + Number(el.dataset.days) * 86400000; save(); render(); },
  realtime() { state.demoOffset = 0; save(); toast('已回到真實時間'); render(); },
  seed() { seedDemo(); replaceTo('#/'); },
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
    : `<header class="topbar"><a class="home-link" href="#/">輔具借用小幫手</a><span class="topbar-title">${esc(view.title)}</span>${demoChip}</header>`;
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
  if (!document.getElementById('loan-form') && !document.getElementById('demo-form')) render();
}, 60000);
