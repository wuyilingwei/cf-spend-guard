import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/index.js';
import { loadConfig } from '../src/config.js';

const config = (env = {}) => loadConfig(env);

const ok = (metrics) => ({ status: 'ok', metrics });

test('全部在阈值内时不跳闸', () => {
  const v = evaluate({ workers: ok({ requests: 1000 }) }, config());
  assert.equal(v.shouldTrip, false);
  assert.equal(v.products.workers.exceeded, false);
});

test('任一产品超标即跳闸', () => {
  const v = evaluate({ r2: ok({ class_a: 3_000_000 }) }, config());
  assert.equal(v.shouldTrip, true);
  assert.match(v.reason, /r2/);
});

test('刚好等于阈值不算超标', () => {
  const v = evaluate({ workers: ok({ requests: 20_000_000 }) }, config({ THRESHOLDS_USD: '{"workers":3}' }));
  assert.equal(v.products.workers.usd, 3);
  assert.equal(v.products.workers.exceeded, false);
});

test('取数失败默认不跳闸', () => {
  const v = evaluate({ workers: { status: 'unknown', note: 'boom' } }, config());
  assert.equal(v.shouldTrip, false);
  assert.equal(v.products.workers.status, 'unknown');
});

test('配置为按超标处理时取数失败会跳闸', () => {
  const v = evaluate({ workers: { status: 'unknown' } }, config({ TRIP_ON_UNKNOWN: 'true' }));
  assert.equal(v.shouldTrip, true);
});

test('探针缺失与探针报错同等对待', () => {
  const v = evaluate({}, config());
  assert.equal(v.products.workers.status, 'unknown');
  assert.equal(v.shouldTrip, false);
});

test('总额只累计取到数的产品', () => {
  const v = evaluate(
    { workers: ok({ requests: 12_000_000 }), r2: { status: 'unknown' } },
    config(),
  );
  assert.equal(v.totalUsd, 0.6);
});
