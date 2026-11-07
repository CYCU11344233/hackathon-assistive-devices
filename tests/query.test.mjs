import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuery, actionUrl, fromMinguo } from '../server/query.mjs';
import { buildParams } from '../server/reserve.mjs';

const html = readFileSync(new URL('./fixtures/doQuery.html', import.meta.url), 'utf8');

test('解析官網查詢結果：候補和借用清單', () => {
  const q = parseQuery(html);
  assert.equal(q.waits.length, 2);
  assert.equal(q.waits[0].status, '配對成功');
  assert.equal(q.waits[0].date, '2026-09-01');
  assert.equal(q.rents.length, 3);
  assert.deepEqual(
    { no: q.rents[0].no, center: q.rents[0].center, cancelled: q.rents[0].cancelled, item: q.rents[0].items[0].item, deadline: q.rents[0].items[0].deadline },
    { no: '260901019', center: '臺北市西區輔具中心', cancelled: false, item: '便盆椅', deadline: '2026-09-02' },
  );
  assert.equal(q.rents[1].cancelled, true);
  // 已過期限的沒有取消按鈕
  assert.equal(q.rents[0].items[0].cancelUrl, null);
});

test('取消按鈕的網址', () => {
  assert.equal(actionUrl(`<button onclick="if(confirm('確認?')){location.href = '/app37/rentView/x?id=1&amp;n=2';}">取消</button>`), '/app37/rentView/x?id=1&n=2');
  assert.equal(actionUrl('<a href="/app37/rentView/cancel/9">取消</a>'), '/app37/rentView/cancel/9');
  assert.equal(actionUrl(' '), null);
  assert.equal(fromMinguo('115 / 09 / 02'), '2026-09-02');
});

test('候補表單欄位：可複選中心', () => {
  const f = {
    name: '金大森', idno: 'a123456789', twnspcode: '63000040', addr: '吉林路', liveCnt: '63000', liveTwnsp: '63000040', liveAddr: '吉林路',
    phone: '0912345678', mobile: '0912345678', userName: '金大森', userIdno: 'A123456789', userBirth: '1988-12-12', handicap: '1', lcms: '0', selective: '1',
  };
  const p = buildParams(f, { modelId: 2, centers: ['heyi', 'west'] });
  assert.equal(p.get('waitTypeId'), '2');
  assert.deepEqual(p.getAll('waitValid'), ['true', 'true']);
  assert.deepEqual(p.getAll('centerCategory_2'), ['1', '3']);
  assert.equal(buildParams(f).get('waitTypeId'), null);
});
