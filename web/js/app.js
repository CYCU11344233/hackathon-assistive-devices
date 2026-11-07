import {
  parseHours, openStatus, pickupStatus, loanStage, reminderFor, defaultDueDate,
  addMonths, addDays, diffDays, startOfDay, WEEKDAY_NAMES,
} from './rules.js';
import { CENTERS, ITEMS, LINKS, CHECKLISTS } from './data.js';
import * as bridge from './bridge.js';

const HOURS = Object.fromEntries(CENTERS.map((c) => [c.id, parseHours(c.hoursText)]));
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
const fmtDate = (d) => { d = new Date(d); return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_NAMES[d.getDay()]}）`; };
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
function centerInfo(c) {
  return `<details class="more"><summary>地址與時間</summary>
    <p class="small">${esc(c.address)}<br>${esc(c.entrance)}<br>${esc(c.hoursText.replace(/周/g, '週'))}（12:00–13:30 午休）</p></details>`;
}

function centerCard({ c, p, dist }, showPickup = true) {
  const pt = pickupText(p);
  return `<article class="card">
    <div class="card-head"><h3>${esc(shortName(c))}</h3>${dist != null ? `<span class="dist">${dist.toFixed(1)} 公里</span>` : ''}</div>
    <p class="line">${openLine(c)}</p>
    ${showPickup ? `<p class="line tone-${pt.tone}">現在預約：${pt.text}</p>` : ''}
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

// ---------- 頁面 ----------
function home() {
  const loans = state.loans.map((l) => ({ l, st: loanStatus(l) }));
  const active = loans.filter((x) => !x.l.returnedAt).sort((a, b) => TONE_RANK[a.st.tone] - TONE_RANK[b.st.tone]);
  const returned = loans.filter((x) => x.l.returnedAt);
  const suspended = returned.find((x) => x.st.s.suspendedNow);
  return {
    title: '輔具借用小幫手',
    html: `
    ${suspended ? `<div class="alert danger">逾期歸還，<strong>${fmtDate(suspended.st.s.suspendedUntil)}</strong> 前不能再借。</div>` : ''}
    ${active.length ? `<h2>我的借用</h2>${active.map(({ l, st }) => `
      <a class="card link tone-border-${st.tone}" href="#/loan/${l.id}">
        <div class="card-head"><h3>${esc(l.item)}</h3><span class="chip ${st.tone}">${st.label}</span></div>
        <p class="line tone-${st.tone}">${st.text}</p>
      </a>`).join('')}` : ''}
    <div class="big-actions">
      <a class="big-btn" href="#/borrow"><span>🦽</span><div><strong>我要借輔具</strong></div></a>
      <a class="big-btn" href="#/loan/new"><span>📝</span><div><strong>記下預約</strong></div></a>
      <a class="big-btn" href="#/centers"><span>🏥</span><div><strong>輔具中心</strong></div></a>
    </div>
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
      html: `<div class="alert warn">只借給<strong>設籍臺北市</strong>的市民。</div>
      <div class="card"><h3>可以打長照專線</h3>
        <div class="btn-row"><button class="btn primary" data-act="call" data-phone="1966">📞 撥打 1966</button>
        <button class="btn" data-act="link" data-url="${LINKS.chooseCounty}">官方說明</button></div>
      </div>`,
    };
  }
  if (step === 'item') {
    return {
      title: '想借什麼？',
      html: `
      <div class="item-grid">${ITEMS.map((it) => `<a class="item" href="#/borrow?step=plan&item=${encodeURIComponent(it)}">${esc(it)}</a>`).join('')}
        <a class="item" href="#/borrow?step=stair">爬梯機</a>
        <a class="item" href="#/borrow?step=plan&item=${encodeURIComponent('其他輔具')}">其他</a>
      </div>`,
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
  if (step === 'plan') {
    return {
      title: `借${item}`,
      html: `<ol class="steps">
        <li><strong>選中心</strong>（看下面）</li>
        <li><strong>到官網預約</strong>
          <div class="btn-row"><button class="btn primary" data-act="link" data-url="${LINKS.reserve}">去官網預約</button></div></li>
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
      <a class="btn primary big" href="#/borrow?step=item">是，戶籍在臺北市</a>
      <a class="btn big" href="#/borrow?step=out">不是</a>
    </div>`,
  };
}

function centers() {
  return {
    title: '輔具中心',
    html: `<p class="small">國定假日可能休館，出發前先打電話。</p>
    ${locateButton()}
    ${sortedCenters().map((x) => centerCard(x)).join('')}`,
  };
}

function newLoan(_m, q) {
  const item = q.get('item') || '';
  const isKnown = ITEMS.includes(item);
  const t = now();
  return {
    title: '記下預約',
    html: `<form id="loan-form" class="form">
      <label>輔具
        <select name="item">${ITEMS.map((it) => `<option ${it === item ? 'selected' : ''}>${esc(it)}</option>`).join('')}
          <option value="__other" ${item && !isKnown ? 'selected' : ''}>其他</option></select>
      </label>
      <label class="other-item" ${item && !isKnown ? '' : 'hidden'}>輔具名稱<input name="itemOther" value="${item && !isKnown && item !== '其他輔具' ? esc(item) : ''}" placeholder="例如：洗澡便盆椅"></label>
      <fieldset><legend>中心</legend>${CENTERS.map((c, i) => `
        <label class="radio"><input type="radio" name="center" value="${c.id}" ${i === 0 ? 'checked' : ''}> ${esc(shortName(c))}</label>`).join('')}
      </fieldset>
      <label>預約時間<input type="datetime-local" name="reservedAt" value="${toDTInput(t)}" required></label>
      <div id="pickup-preview" class="alert info"></div>
      <label class="radio"><input type="checkbox" name="picked"> 我已經取貨了</label>
      <div class="picked-fields" hidden>
        <label>取貨日<input type="date" name="pickedUpAt" value="${toDateInput(t)}"></label>
        <label>歸還期限（看借用單）<input type="date" name="dueDate" value="${toDateInput(defaultDueDate(t))}"></label>
      </div>
      <button class="btn primary big" type="submit">儲存</button>
    </form>`,
    mount() {
      const f = document.getElementById('loan-form');
      let dueTouched = false;
      const preview = () => {
        const c = f.center.value;
        const r = f.reservedAt.value ? fromDTInput(f.reservedAt.value) : now();
        const p = pickupStatus(HOURS[c], r, now());
        const pt = pickupText(p);
        const box = document.getElementById('pickup-preview');
        box.className = `alert ${pt.tone === 'muted' ? 'warn' : pt.tone}`;
        box.innerHTML = `${pt.text}${p.status === 'impossible' ? '，建議換中心' : ''}`;
        f.querySelector('.other-item').hidden = f.item.value !== '__other';
        f.querySelector('.picked-fields').hidden = !f.picked.checked;
      };
      f.addEventListener('input', (e) => {
        if (e.target.name === 'dueDate') dueTouched = true;
        if (e.target.name === 'pickedUpAt' && !dueTouched && f.pickedUpAt.value) {
          f.dueDate.value = toDateInput(defaultDueDate(fromDateInput(f.pickedUpAt.value)));
        }
        preview();
      });
      f.addEventListener('change', preview);
      preview();
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = f.item.value === '__other' ? (f.itemOther.value.trim() || '輔具') : f.item.value;
        const loan = {
          id: newId(),
          item: name,
          centerId: f.center.value,
          reservedAt: fromDTInput(f.reservedAt.value).toISOString(),
          renewed: false,
          notified: [],
          checks: { pickup: [], return: [] },
        };
        if (f.picked.checked && f.pickedUpAt.value && f.dueDate.value) {
          loan.pickedUpAt = fromDateInput(f.pickedUpAt.value).toISOString();
          loan.dueDate = fromDateInput(f.dueDate.value).toISOString();
        }
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
      <form class="card form" id="pickup-form"><h3>我已經取貨了</h3>
        <label>取貨日<input type="date" name="pickedUpAt" value="${toDateInput(now())}"></label>
        <label>歸還期限（看借用單）<input type="date" name="dueDate" value="${toDateInput(defaultDueDate(now()))}"></label>
        <button class="btn primary" type="submit">儲存</button></form>`;
  } else if (s.stage === 'borrowed') {
    body += `<div class="days tone-${st.tone}"><strong>${s.daysLeft < 0 ? `逾期 ${-s.daysLeft}` : s.daysLeft}</strong><span>${s.daysLeft < 0 ? '天' : '天後到期'}</span></div>`;
    if (s.level === 'overdue') {
      body += `<div class="alert danger">逾期會停權。今天還，<strong>${fmtDate(addMonths(startOfDay(now()), 3))}</strong> 起才能再借。</div>`;
    }
    body += `<div class="card"><h3>歸還前準備</h3>${checklist(loan, 'return')}</div>`;
    body += s.canRenew
      ? `<form class="card form" id="renew-form"><h3>續借（限 1 次）</h3>
          <p class="small">先打電話辦好，再改日期</p>
          <div class="btn-row"><button type="button" class="btn" data-act="call" data-phone="${c.phone}">📞 撥號</button></div>
          <label>新的歸還期限<input type="date" name="dueDate" value="${toDateInput(addMonths(new Date(loan.dueDate), 3))}"></label>
          <button class="btn" type="submit">已續借</button></form>`
      : '<div class="alert info">已續借過，到期請歸還。</div>';
    body += `<form class="card form" id="return-form"><h3>我已經歸還了</h3>
        <label>歸還日<input type="date" name="returnedAt" value="${toDateInput(now())}"></label>
        <button class="btn primary" type="submit">儲存</button></form>
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
      <li><strong>座標</strong><br>OpenStreetMap Nominatim 依地址查詢，© OpenStreetMap contributors（ODbL）。合宜輔具中心為花博公園園區的約略位置。</li>
    </ul>
    <ul class="plain">
      <li>預約在官網完成，這裡不代替預約。</li>
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
  delete(el) {
    if (el.dataset.confirm !== '1') {
      el.dataset.confirm = '1';
      el.textContent = '再按一次確認刪除';
      el.classList.add('danger');
      return;
    }
    state.loans = state.loans.filter((l) => l.id !== el.dataset.loan);
    save();
    replaceTo('#/');
  },
  shift(el) { state.demoOffset = (state.demoOffset || 0) + Number(el.dataset.days) * 86400000; save(); render(); },
  realtime() { state.demoOffset = 0; save(); toast('已回到真實時間'); render(); },
  seed() { seedDemo(); replaceTo('#/'); },
  wipe(el) {
    if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = '再按一次確認清除'; return; }
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

window.addEventListener('hashchange', render);
render();
// 頁面停留時，每分鐘更新一次倒數
setInterval(() => {
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;
  if (!document.getElementById('loan-form') && !document.getElementById('demo-form')) render();
}, 60000);
