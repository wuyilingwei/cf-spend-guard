import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, proratedStorageGbMonth, R2_CLASS_A, R2_FREE } from '../src/pricing.js';

test('免费额度内不计费', () => {
  const { usd } = estimateCost('workers', { requests: 9_000_000, cpu_ms: 1_000_000 });
  assert.equal(usd, 0);
});

test('只对超出免费额度的部分计价', () => {
  const { usd, breakdown } = estimateCost('workers', { requests: 12_000_000, cpu_ms: 0 });
  assert.equal(breakdown.requests, 0.6);
  assert.equal(usd, 0.6);
});

test('R2 Class A 单价远高于 Class B', () => {
  const a = estimateCost('r2', { class_a: 2_000_000 }).usd;
  const b = estimateCost('r2', { class_b: 11_000_000 }).usd;
  assert.equal(a, 4.5);
  assert.equal(b, 0.36);
  assert.ok(a > b);
});

test('多项用量累加', () => {
  const { usd } = estimateCost('kv', { reads: 12_000_000, writes: 2_000_000 });
  assert.equal(usd, 1 + 5);
});

test('未知指标被忽略而不是抛错', () => {
  const { usd, breakdown } = estimateCost('d1', { rows_read: 0, bogus_metric: 999 });
  assert.equal(usd, 0);
  assert.equal(breakdown.bogus_metric, undefined);
});

test('非有限数值不参与计价', () => {
  const { usd } = estimateCost('r2', { class_a: Number.NaN, class_b: 11_000_000 });
  assert.equal(usd, 0.36);
});

test('未知产品抛错', () => {
  assert.throws(() => estimateCost('nope', {}), /unknown product/);
});

test('存储按周期已过天数折算', () => {
  assert.equal(proratedStorageGbMonth(30, 15, 30), 15);
  assert.equal(proratedStorageGbMonth(30, 30, 30), 30);
  assert.equal(proratedStorageGbMonth(30, 0, 30), 0);
});

test('R2 免费操作不与 Class A 重叠', () => {
  for (const action of R2_FREE) assert.ok(!R2_CLASS_A.has(action), action);
});
