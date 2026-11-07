// 代送預約的表單邏輯（不連官網）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMinguo, validate, buildParams, maskParams } from '../server/reserve.mjs';

// TownPass 開發版的假帳號資料
const form = {
  name: '王小明', idno: 'a123456789', twnspcode: '63000040', addr: '吉林路 69 號 4 樓',
  liveCnt: '63000', liveTwnsp: '63000040', liveAddr: '吉林路 69 號 4 樓',
  phone: '0932166777', mobile: '0932166777', email: '',
  userName: '王小明', userIdno: 'A123456789', userBirth: '1988-12-12',
  handicap: '0', lcms: '0', selective: '1',
};

test('生日轉民國年', () => {
  assert.equal(toMinguo('1988-12-12'), '077/12/12');
  assert.equal(toMinguo('2010-1-5'), '099/01/05');
  assert.equal(toMinguo('abc'), '');
});

test('照官網規則檢查', () => {
  assert.deepEqual(validate(form), []);
  assert.ok(validate({ ...form, mobile: '0212345678' }).some((e) => e.includes('09')));
  assert.ok(validate({ ...form, lcms: '' }).some((e) => e.includes('長照')));
  assert.ok(validate({ ...form, twnspcode: '65000010' }).some((e) => e.includes('臺北市')));
});

test('組成官網欄位，身分證轉大寫；回傳給前端時遮住', () => {
  const p = buildParams(form);
  assert.equal(p.get('idno'), 'A123456789');
  assert.equal(p.get('userBirthdt'), '077/12/12');
  assert.equal(p.get('cntcode'), '63000');
  assert.equal(p.get('_action_submitData'), '完成');
  assert.equal(maskParams(p).idno, 'A********9');
});
