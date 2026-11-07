import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHours, openStatus, pickupWindow, pickupStatus, addMonths, defaultDueDate,
  loanStage, reminderFor, suspendedUntil,
} from '../web/js/rules.js';
import { CENTERS } from '../web/js/data.js';

const H = Object.fromEntries(CENTERS.map((c) => [c.id, parseHours(c.hoursText)]));
// 2026-11-07 是週六
const at = (m, d, h = 0, min = 0) => new Date(2026, m - 1, d, h, min);

test('解析開放時間', () => {
  assert.deepEqual(parseHours('周二至周六 9:00-12:00 13:30-17:00'), { days: [2, 3, 4, 5, 6], ranges: [[540, 720], [810, 1020]] });
  assert.deepEqual(parseHours('周一至周五 9:00-12:00 13:30-17:00').days, [1, 2, 3, 4, 5]);
  assert.equal(at(11, 7).getDay(), 6);
});

test('營業狀態：午休、週日、週一', () => {
  assert.equal(openStatus(H.heyi, at(11, 7, 10)).open, true);
  const lunch = openStatus(H.heyi, at(11, 7, 12, 30));
  assert.equal(lunch.open, false);
  assert.deepEqual(lunch.nextOpen, at(11, 7, 13, 30));
  // 週六 17:39 之後，合宜下次開門是週二 9:00
  assert.deepEqual(openStatus(H.heyi, at(11, 7, 17, 39)).nextOpen, at(11, 10, 9));
  // 南區週一有開
  assert.deepEqual(openStatus(H.south, at(11, 7, 17, 39)).nextOpen, at(11, 9, 9));
});

test('週六 16:30 在合宜預約：週日沒開，只剩今天 30 分鐘', () => {
  const p = pickupStatus(H.heyi, at(11, 7, 16, 30), at(11, 7, 16, 30));
  assert.equal(p.status, 'urgent');
  assert.deepEqual(p.deadline, at(11, 7, 17));
  assert.equal(p.remainingMin, 30);
});

test('週日在西區預約：週日、週一都沒開，沒有可取貨時段', () => {
  const w = pickupWindow(H.west, at(11, 8, 10));
  assert.equal(w.deadline, null);
  assert.equal(pickupStatus(H.west, at(11, 8, 10), at(11, 8, 10)).status, 'impossible');
});

test('週二在南區預約：最晚週三 17:00', () => {
  const p = pickupStatus(H.south, at(11, 10, 10), at(11, 10, 10));
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.deadline, at(11, 11, 17));
});

test('週五晚上在南區預約：週六沒開，沒有可取貨時段', () => {
  assert.equal(pickupStatus(H.south, at(11, 13, 18), at(11, 13, 18)).status, 'impossible');
});

test('過了取貨期限', () => {
  assert.equal(pickupStatus(H.south, at(11, 10, 10), at(11, 11, 17, 1)).status, 'expired');
});

test('借期 3 個月與月底', () => {
  assert.deepEqual(defaultDueDate(at(11, 7, 15)), new Date(2027, 1, 7));
  assert.deepEqual(addMonths(new Date(2026, 10, 30), 3), new Date(2027, 1, 28));
  assert.deepEqual(suspendedUntil(new Date(2027, 1, 10, 15)), new Date(2027, 4, 10));
});

test('到期提醒的階段', () => {
  const loan = (due) => ({ item: '輪椅', centerId: 'heyi', reservedAt: at(8, 1).toISOString(), pickedUpAt: at(8, 2).toISOString(), dueDate: due.toISOString() });
  const now = at(11, 7, 18);
  assert.equal(reminderFor(loan(at(11, 30)), H.heyi, now), null); // 23 天
  assert.equal(reminderFor(loan(at(11, 17)), H.heyi, now).key, 'due-14'); // 10 天
  assert.equal(reminderFor(loan(at(11, 12)), H.heyi, now).key, 'due-7'); // 5 天
  assert.equal(reminderFor(loan(at(11, 8)), H.heyi, now).key, 'due-1');
  assert.equal(reminderFor(loan(at(11, 7)), H.heyi, now).key, 'due-0');
  assert.equal(reminderFor(loan(at(11, 5)), H.heyi, now).key, 'overdue');
});

test('逾期歸還要停權 3 個月；準時歸還不用', () => {
  const base = { centerId: 'heyi', reservedAt: at(8, 1).toISOString(), pickedUpAt: at(8, 2).toISOString(), dueDate: at(11, 2).toISOString() };
  const late = loanStage({ ...base, returnedAt: at(11, 5, 10).toISOString() }, H.heyi, at(11, 7));
  assert.equal(late.late, true);
  assert.deepEqual(late.suspendedUntil, new Date(2027, 1, 5));
  assert.equal(late.suspendedNow, true);
  const onTime = loanStage({ ...base, returnedAt: at(11, 2, 16).toISOString() }, H.heyi, at(11, 7));
  assert.equal(onTime.late, false);
  assert.equal(onTime.suspendedUntil, null);
});

test('到期日剛好休館：要在前一個開館日送回', () => {
  const loan = { centerId: 'heyi', reservedAt: at(11, 7).toISOString(), pickedUpAt: at(11, 7).toISOString(), dueDate: new Date(2027, 1, 7).toISOString() };
  const s = loanStage(loan, H.heyi, at(11, 7, 18)); // 2027/2/7 是週日
  assert.equal(s.dueClosed, true);
  assert.deepEqual(s.returnBy, new Date(2027, 1, 6, 17));
  const s2 = loanStage({ ...loan, dueDate: new Date(2027, 1, 9).toISOString() }, H.heyi, at(11, 7, 18)); // 週二
  assert.equal(s2.dueClosed, false);
});

test('通知內容不會觸發台北通的訂閱指令', async () => {
  const { notify } = await import('../web/js/bridge.js');
  let got;
  notify('t', '已訂閱輪椅', (_t, c) => { got = c; });
  assert.equal(/已訂閱/.test(got), false);
});
