// 爬蟲解析測試：tests/fixtures 是 2026-11-07 從臺北市輔具資源整合資訊網存下來的頁面
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCategories, parseModels, parseCenters } from '../server/stock.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('大類：12 類，各有編號和剩餘數', () => {
  const cats = parseCategories(fx('additem.html'));
  assert.equal(cats.length, 12);
  assert.deepEqual(cats[0], { id: 1, name: '輪椅', remaining: 0 });
  assert.deepEqual(cats.find((c) => c.name === '拐杖'), { id: 3, name: '拐杖', remaining: 29 });
});

test('規格：有貨的有剩餘數，沒貨的有等待人數', () => {
  const potty = parseModels(fx('vehicleDetail-4.html'));
  assert.equal(potty.length, 4);
  assert.deepEqual(potty[0], { id: 54, name: '有輪', spec: '可收折', remaining: 1, desc: '四輪可收折便盆椅，不附帶便盆。', waiting: 0 });
  assert.equal(potty[2].waiting, 2);
  const wheel = parseModels(fx('vehicleDetail-1.html'));
  assert.equal(wheel[0].name, '一般介護輪');
  assert.match(wheel[0].spec, /座寬15或16吋/);
  assert.equal(wheel[0].waiting, 12);
});

test('各中心剩餘數量', () => {
  assert.deepEqual(parseCenters(fx('map-54.html')), { heyi: 1, west: 0, south: 0 });
});
