// 在台北通裡填資料、送出二手輔具預約。
// 資料先用台北通帳號（bridge userinfo）帶入；送出由 serve.mjs 的 /api/reserve 代送到官網。
// 伺服器平常是「演練模式」（只檢查、不送出），用 LIVE_RESERVE=1 啟動才會真的送出。

import * as bridge from './bridge.js';

// 臺北市行政區代碼（和官網 twnspcode 一樣）
export const TAIPEI_DISTRICTS = {
  松山區: '63000010', 信義區: '63000020', 大安區: '63000030', 中山區: '63000040',
  中正區: '63000050', 大同區: '63000060', 萬華區: '63000070', 文山區: '63000080',
  南港區: '63000090', 內湖區: '63000100', 士林區: '63000110', 北投區: '63000120',
};
const COUNTIES = [
  ['63000', '臺北市'], ['65000', '新北市'], ['10017', '基隆市'], ['10003', '桃園市'], ['10018', '新竹市'], ['10004', '新竹縣'],
  ['10005', '苗栗縣'], ['66000', '臺中市'], ['10007', '彰化縣'], ['10008', '南投縣'], ['10009', '雲林縣'], ['10020', '嘉義市'],
  ['10010', '嘉義縣'], ['67000', '臺南市'], ['64000', '高雄市'], ['10013', '屏東縣'], ['10002', '宜蘭縣'], ['10015', '花蓮縣'],
  ['10014', '臺東縣'], ['10016', '澎湖縣'], ['09020', '金門縣'], ['09007', '連江縣'],
];

let config = { liveReserve: false };
fetch('/api/config').then((r) => r.json()).then((c) => { config = c; }).catch(() => {});

let userInfo; // undefined：還沒問；null：拿不到
async function loadUserInfo() {
  if (userInfo === undefined) userInfo = await bridge.getUserInfo().catch(() => null);
  return userInfo;
}

/** 台北通帳號 → 表單預設值 */
function fromAccount(a) {
  if (!a) return {};
  const ad = (a.addresses || []).find((x) => x.priority) || (a.addresses || [])[0] || {};
  const town = ad.town || '';
  // residentAddress 例：臺北市中山區吉林路 69 號 4 樓 → 去掉縣市和行政區
  let addr = a.residentAddress || '';
  for (const p of [ad.city, town]) if (p && addr.startsWith(p)) addr = addr.slice(p.length);
  const bd = (a.birthday || '').replace(/\//g, '-');
  return {
    name: a.realName || '', idno: a.idNo || '', mobile: a.phoneNo || '', phone: a.phoneNo || '',
    email: a.email || '', twnspcode: TAIPEI_DISTRICTS[town] || '', addr: addr.trim(),
    userBirth: /^\d{4}-\d{2}-\d{2}$/.test(bd) ? bd : '',
  };
}

const radios = (name, opts) => `<div class="radios">${opts.map(([v, label]) => `
  <label class="radio"><input type="radio" name="${name}" value="${v}" required> ${label}</label>`).join('')}</div>`;

/**
 * 預約頁。ctx 由 app.js 傳入：{ esc, toast, confirmDialog, replaceTo, addLoan, centerName, model, item, center, render }
 */
export function reservePage(ctx) {
  const { esc, model, item, center } = ctx;
  const a = userInfo ? fromAccount(userInfo) : {};
  const v = (k) => esc(a[k] || '');
  return {
    title: '填寫預約資料',
    html: `<div class="card summary">
        <p class="small">預約</p>
        <h3>${esc(item)}・${esc(model.name)}${model.spec ? `（${esc(model.spec)}）` : ''}</h3>
        <p>${esc(ctx.centerName)}</p>
        <p class="line tone-${ctx.pickup.tone}">現在預約：${esc(ctx.pickup.text)}${ctx.pickup.tone === 'danger' ? '，建議換中心或先打電話' : ''}</p>
      </div>
      ${config.liveReserve ? '<div class="alert danger">會真的送到官網預約</div>' : '<div class="alert info">演練模式：會檢查資料，但不會真的送到官網</div>'}
      <div id="ui-note">${userInfo ? '<div class="alert ok">已帶入台北通帳號資料，請確認</div>' : ''}</div>
      <div id="errors"></div>
      <form id="reserve-form" class="form">
        <h2>聯絡人</h2>
        <label>姓名<input name="name" value="${v('name')}" autocomplete="name"></label>
        <label>身分證字號<input name="idno" value="${v('idno')}" autocapitalize="characters"></label>
        <label class="radio"><input type="checkbox" name="foreign"> 外籍</label>
        <label>手機（簡訊通知）<input name="mobile" type="tel" inputmode="numeric" value="${v('mobile')}" placeholder="09xxxxxxxx"></label>
        <label>電話（查詢預約用）<input name="phone" type="tel" value="${v('phone')}"></label>
        <label>Email（可不填）<input name="email" type="email" value="${v('email')}"></label>

        <h2>戶籍地址（臺北市）</h2>
        <label>行政區<select name="twnspcode"><option value="">請選擇</option>${Object.entries(TAIPEI_DISTRICTS).map(([n, c]) => `<option value="${c}" ${a.twnspcode === c ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>地址<input name="addr" value="${v('addr')}" placeholder="路名、門牌"></label>

        <h2>居住地址</h2>
        <label class="radio"><input type="checkbox" name="sameLive" checked> 和戶籍地址相同</label>
        <div class="live-fields" hidden>
          <label>縣市<select name="liveCnt"><option value="">請選擇</option>${COUNTIES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('')}</select></label>
          <label>行政區<select name="liveTwnsp"><option value="">先選縣市</option></select></label>
          <label>地址<input name="liveAddr" placeholder="路名、門牌"></label>
        </div>

        <h2>使用輔具的人</h2>
        <label class="radio"><input type="checkbox" name="sameUser" checked> 就是聯絡人本人</label>
        <div class="user-fields" hidden>
          <label>姓名<input name="userName"></label>
          <label>身分證字號<input name="userIdno" autocapitalize="characters"></label>
          <label class="radio"><input type="checkbox" name="userForeign"> 外籍</label>
        </div>
        <label>出生年月日<input name="userBirth" type="date" value="${v('userBirth')}"></label>
        <fieldset><legend>身障資格</legend>${radios('handicap', [['1', '有證明'], ['0', '無證明']])}</fieldset>
        <fieldset><legend>長照資格</legend>${radios('lcms', [['1', '有資格'], ['0', '無資格']])}</fieldset>
        <fieldset><legend>福利資格</legend>${radios('selective', [['1', '一般收入戶'], ['2', '中低收入戶'], ['3', '低收入戶']])}</fieldset>

        <button class="btn primary big" type="submit">送出預約</button>
        <p class="small">送出後官網會保留這件輔具，請在 2 天內（含當天）開館時間去取貨</p>
        <button class="btn ghost" type="button" data-act="officialReserve" data-center="${center}" data-model="${model.id}">改到官網填寫</button>
      </form>`,
    async mount() {
      const f = document.getElementById('reserve-form');
      // 第一次進來時向台北通拿帳號資料，拿到就重畫一次帶入
      if (userInfo === undefined) {
        loadUserInfo().then((u) => { if (u && document.getElementById('reserve-form')) ctx.render(); });
      }
      const toggle = () => {
        f.querySelector('.live-fields').hidden = f.sameLive.checked;
        f.querySelector('.user-fields').hidden = f.sameUser.checked;
      };
      f.addEventListener('change', async (e) => {
        toggle();
        if (e.target.name === 'liveCnt') {
          const sel = f.liveTwnsp;
          sel.innerHTML = '<option value="">載入中…</option>';
          const r = await fetch(`/api/twnsp?cnt=${f.liveCnt.value}`).then((x) => x.json()).catch(() => ({ options: [] }));
          sel.innerHTML = `<option value="">請選擇</option>${(r.options || []).map((o) => `<option value="${o.code}">${esc(o.name)}</option>`).join('')}`;
        }
      });
      toggle();
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = (n) => (f[n]?.value ?? '').trim();
        const checked = (n) => f.querySelector(`input[name=${n}]:checked`)?.value || '';
        const form = {
          name: val('name'), idno: val('idno'), foreign: f.foreign.checked,
          mobile: val('mobile'), phone: val('phone') || val('mobile'), email: val('email'),
          twnspcode: val('twnspcode'), addr: val('addr'),
          liveCnt: f.sameLive.checked ? '63000' : val('liveCnt'),
          liveTwnsp: f.sameLive.checked ? val('twnspcode') : val('liveTwnsp'),
          liveAddr: f.sameLive.checked ? val('addr') : val('liveAddr'),
          userName: f.sameUser.checked ? val('name') : val('userName'),
          userIdno: f.sameUser.checked ? val('idno') : val('userIdno'),
          userForeign: f.sameUser.checked ? f.foreign.checked : f.userForeign.checked,
          userBirth: val('userBirth'),
          handicap: checked('handicap'), lcms: checked('lcms'), selective: checked('selective'),
        };
        const ok = await ctx.confirmDialog(`確定在${ctx.centerName}預約？`, `${item}・${model.name}`, '送出', 'primary');
        if (!ok) return;
        const btn = f.querySelector('button[type=submit]');
        btn.disabled = true; btn.textContent = '送出中…';
        const res = await fetch('/api/reserve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ center, modelId: model.id, live: config.liveReserve, form }),
        }).then((r) => r.json()).catch(() => ({ errors: ['連不上伺服器，請稍後再試'] }));
        btn.disabled = false; btn.textContent = '送出預約';
        if (res.errors?.length || res.ok === false) {
          const msgs = res.errors || res.lines || ['官網沒有接受這筆預約'];
          document.getElementById('errors').innerHTML = `<div class="alert danger"><strong>沒有送出</strong><ul>${msgs.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
          window.scrollTo(0, 0);
          return;
        }
        // 成功（或演練）就直接記到「我的借用」，不用使用者自己再記一次
        const id = ctx.addLoan({ item, model: `${model.name}${model.spec ? ` ${model.spec}` : ''}`, centerId: center, official: !res.dryRun });
        ctx.toast(res.dryRun ? '演練模式：資料檢查通過，已記到我的借用（沒有真的送出）' : '已在官網預約成功，記到我的借用了', 5000);
        ctx.replaceTo(`#/loan/${id}`);
      });
    },
  };
}
