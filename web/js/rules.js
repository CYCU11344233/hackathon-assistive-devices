// 借用規則引擎：全部是純函式，方便測試。
// 規則來源：臺北市二手輔具借用須知 https://tpap.taipei/app37/rentView/intaipei

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

export const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
const CN_DAY = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

// 免費借期 3 個月；逾期停權到歸還後滿 3 個月；預約後 2 天內（含當日）取貨。
export const LOAN_MONTHS = 3;
export const SUSPEND_MONTHS = 3;
export const PICKUP_DAYS = 2;
export const REMINDER_DAYS = [14, 7, 1, 0];

/** 解析「周二至周六 9:00-12:00 13:30-17:00」這類開放時間文字。 */
export function parseHours(text) {
  const dm = text.match(/[周週星期]+\s*([一二三四五六日天])\s*[至到~～\-－]\s*[周週星期]*\s*([一二三四五六日天])/);
  if (!dm) throw new Error(`無法解析開放日：${text}`);
  const from = CN_DAY[dm[1]];
  const to = CN_DAY[dm[2]];
  const days = [];
  for (let d = from; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === to) break;
  }
  const ranges = [...text.matchAll(/(\d{1,2}):(\d{2})\s*[-~～－]\s*(\d{1,2}):(\d{2})/g)]
    .map((m) => [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  if (!ranges.length) throw new Error(`無法解析開放時段：${text}`);
  return { days, ranges };
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** 加月份；遇到月底會停在該月最後一天（例如 11/30 + 3 個月 = 2/28）。 */
export function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

/** 兩個日期相差幾天（以日曆日計算，b − a）。 */
export function diffDays(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

/** 本地日期的 'YYYY-MM-DD'。 */
export function dateKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 某一天的開放時段。 */
export function intervalsOnDate(hours, date) {
  const day0 = startOfDay(date);
  if (!hours.days.includes(day0.getDay())) return [];
  // 國定假日休館（hours.closed 是 'YYYY-MM-DD' 的集合或 Map，由呼叫端放入）
  if (hours.closed && hours.closed.has(dateKey(day0))) return [];
  return hours.ranges.map(([s, e]) => ({
    start: new Date(day0.getTime() + s * MIN),
    end: new Date(day0.getTime() + e * MIN),
  }));
}

/** 現在是否營業，以及何時關門或下次何時開門。 */
export function openStatus(hours, now, searchDays = 14) {
  for (const iv of intervalsOnDate(hours, now)) {
    if (now >= iv.start && now < iv.end) return { open: true, closesAt: iv.end };
  }
  for (let i = 0; i <= searchDays; i++) {
    for (const iv of intervalsOnDate(hours, addDays(now, i))) {
      if (iv.start > now) return { open: false, nextOpen: iv.start };
    }
  }
  return { open: false, nextOpen: null };
}

/**
 * 預約後可以取貨的時段：預約當天與隔天（含當日共 2 天）的開放時段。
 * 回傳的 deadline 是最後一個可取貨時段的結束時間；沒有任何時段時為 null。
 */
export function pickupWindow(hours, reservedAt) {
  const intervals = [];
  for (let i = 0; i < PICKUP_DAYS; i++) {
    for (const iv of intervalsOnDate(hours, addDays(reservedAt, i))) {
      if (iv.end <= reservedAt) continue;
      intervals.push({ start: iv.start < reservedAt ? new Date(reservedAt) : iv.start, end: iv.end });
    }
  }
  return { intervals, deadline: intervals.length ? intervals[intervals.length - 1].end : null };
}

/**
 * 依「現在」判斷取貨狀態。
 * - impossible：依公告時間，預約後根本沒有可取貨的開館時段
 * - expired：取貨期限已過
 * - urgent：剩下的開館時間不到 2 小時
 * - ok：還來得及
 */
export function pickupStatus(hours, reservedAt, now) {
  const { intervals, deadline } = pickupWindow(hours, reservedAt);
  if (!deadline) return { status: 'impossible', intervals, deadline };
  if (now >= deadline) return { status: 'expired', intervals, deadline };
  let remainingMin = 0;
  let nextStart = null;
  for (const iv of intervals) {
    if (iv.end <= now) continue;
    const s = iv.start > now ? iv.start : now;
    remainingMin += (iv.end - s) / MIN;
    if (!nextStart) nextStart = s;
  }
  return {
    status: remainingMin < 120 ? 'urgent' : 'ok',
    intervals,
    deadline,
    remainingMin: Math.round(remainingMin),
    openNow: intervals.some((iv) => now >= iv.start && now < iv.end),
    nextStart,
  };
}

/** 某天（含）以前最後一個開館時段的結束時間；用來提醒「到期日中心休息，要提早還」。 */
export function lastOpenBy(hours, date, searchDays = 14) {
  for (let i = 0; i <= searchDays; i++) {
    const ivs = intervalsOnDate(hours, addDays(date, -i));
    if (ivs.length) return ivs[ivs.length - 1].end;
  }
  return null;
}

export function defaultDueDate(pickedUpAt) {
  return addMonths(startOfDay(pickedUpAt), LOAN_MONTHS);
}

export function suspendedUntil(returnedAt) {
  return addMonths(startOfDay(returnedAt), SUSPEND_MONTHS);
}

/**
 * 一筆借用目前的階段。
 * loan: { reservedAt, centerId, pickedUpAt?, dueDate?, renewed?, returnedAt? }（日期皆為 ISO 字串或 Date）
 */
export function loanStage(loan, hours, now) {
  if (loan.returnedAt) {
    const returned = new Date(loan.returnedAt);
    const late = loan.dueDate ? diffDays(new Date(loan.dueDate), returned) > 0 : false;
    const until = late ? suspendedUntil(returned) : null;
    return {
      stage: 'returned',
      late,
      suspendedUntil: until,
      suspendedNow: !!until && now < until,
    };
  }
  if (!loan.pickedUpAt) {
    const p = pickupStatus(hours, new Date(loan.reservedAt), now);
    return { stage: 'reserved', pickup: p };
  }
  const due = new Date(loan.dueDate);
  const daysLeft = diffDays(now, due);
  let level = 'ok';
  if (daysLeft < 0) level = 'overdue';
  else if (daysLeft <= 1) level = 'urgent';
  else if (daysLeft <= 14) level = 'soon';
  const returnBy = lastOpenBy(hours, due);
  const dueClosed = !!returnBy && diffDays(returnBy, due) > 0;
  return { stage: 'borrowed', due, daysLeft, level, canRenew: !loan.renewed, returnBy, dueClosed };
}

/** 對應要發的提醒；key 用來避免同一階段重複通知。沒有要提醒時回傳 null。 */
export function reminderFor(loan, hours, now, fmt = (d) => d.toLocaleString()) {
  const s = loanStage(loan, hours, now);
  const item = loan.item || '輔具';
  if (s.stage === 'reserved') {
    const p = s.pickup;
    if (p.status === 'impossible') {
      return { key: 'pickup-impossible', title: `${item}：預約後可能來不及取貨`, content: '依公告開放時間，預約後 2 天內沒有開館時段，請打電話給中心確認。' };
    }
    if (p.status === 'expired') {
      return { key: 'pickup-expired', title: `${item}：取貨期限已過`, content: '預約可能已自動取消，需要的話請重新預約。' };
    }
    if (p.status === 'urgent') {
      return { key: 'pickup-urgent', title: `${item}：請在 ${fmt(p.deadline)} 前取貨`, content: `剩下的開館時間約 ${p.remainingMin} 分鐘，逾期會自動取消。` };
    }
    return null;
  }
  if (s.stage === 'borrowed') {
    if (s.daysLeft < 0) {
      return { key: 'overdue', title: `${item}：已超過歸還期限 ${-s.daysLeft} 天`, content: '逾期會被停止借用資格，歸還後滿 3 個月才能再借，請盡快歸還。' };
    }
    for (const d of REMINDER_DAYS) {
      if (s.daysLeft <= d && (d === 0 || s.daysLeft > nextLower(d))) {
        const when = s.daysLeft === 0 ? '今天' : `${s.daysLeft} 天後`;
        // 續借規定原文：「若具特殊需求，得限續借 1 次」（二手輔具借用須知）
        const renew = s.canRenew ? '若具特殊需求，得申請續借 1 次，請先洽輔具中心辦理。' : '已續借 1 次，請於期限內歸還。';
        return { key: `due-${d}`, title: `${item}：${when}到期`, content: `${renew}歸還前請用 75% 酒精消毒並晾乾。` };
      }
    }
  }
  return null;
}

function nextLower(d) {
  const i = REMINDER_DAYS.indexOf(d);
  return i < REMINDER_DAYS.length - 1 ? REMINDER_DAYS[i + 1] : -1;
}
