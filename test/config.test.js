import test from 'node:test';
import assert from 'node:assert/strict';
import { billingCycle, loadConfig, SELF_SCRIPT } from '../src/config.js';

test('守卫自身恒在豁免名单内', () => {
  const config = loadConfig({ EXEMPT_SCRIPTS: 'other-worker' });
  assert.ok(config.exemptScripts.has(SELF_SCRIPT));
  assert.ok(config.exemptScripts.has('other-worker'));
});

test('豁免名单无法把守卫自身排除掉', () => {
  const config = loadConfig({ EXEMPT_SCRIPTS: '' });
  assert.ok(config.exemptScripts.has(SELF_SCRIPT));
});

test('默认 dry-run，只有显式 armed 才会真断流', () => {
  assert.equal(loadConfig({}).mode, 'dry-run');
  assert.equal(loadConfig({ MODE: 'ARMED' }).mode, 'dry-run');
  assert.equal(loadConfig({ MODE: 'armed' }).mode, 'armed');
});

test('阈值可覆盖，非法值回退默认', () => {
  const config = loadConfig({ THRESHOLDS_USD: '{"workers":1,"r2":-5,"ghost":3}' });
  assert.equal(config.thresholds.workers, 1);
  assert.equal(config.thresholds.r2, 5);
  assert.equal(config.thresholds.ghost, undefined);
});

test('阈值 JSON 损坏时全部回退默认而不是崩溃', () => {
  const config = loadConfig({ THRESHOLDS_USD: 'not json' });
  assert.equal(config.thresholds.workers, 5);
});

test('取数失败默认不跳闸', () => {
  assert.equal(loadConfig({}).tripOnUnknown, false);
  assert.equal(loadConfig({ TRIP_ON_UNKNOWN: 'true' }).tripOnUnknown, true);
});

test('计费周期起点取本月内最近一次的起始日', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  const cycle = billingCycle(now, 5);
  assert.equal(cycle.cycleStart.toISOString(), '2026-08-05T00:00:00.000Z');
  assert.equal(cycle.daysInCycle, 31);
});

test('起始日尚未到达时回退到上月', () => {
  const now = new Date('2026-08-03T12:00:00Z');
  const cycle = billingCycle(now, 20);
  assert.equal(cycle.cycleStart.toISOString(), '2026-07-20T00:00:00.000Z');
});

test('查询窗口起点永不早于数据保留期', () => {
  // 月度周期最长 30.99 天，短于 31 天保留期，故截断分支正常情况下不会触发；
  // 这里守的是不变量本身，保证将来周期定义或保留期变化时不会静默查空
  for (const day of [1, 15, 28]) {
    for (const iso of ['2026-01-31T23:59:00Z', '2026-02-28T12:00:00Z', '2026-08-31T12:00:00Z']) {
      const now = new Date(iso);
      const cycle = billingCycle(now, day);
      const earliest = new Date(now.getTime() - 31 * 86_400_000);
      assert.ok(cycle.from >= earliest, `${iso} day=${day}`);
      assert.ok(cycle.from >= cycle.cycleStart);
    }
  }
});

test('周期完全落在保留期内时窗口起点即周期起点', () => {
  const now = new Date('2026-08-10T12:00:00Z');
  const cycle = billingCycle(now, 1);
  assert.equal(cycle.truncated, false);
  assert.equal(cycle.from.getTime(), cycle.cycleStart.getTime());
});

test('已过天数不超过周期长度', () => {
  const now = new Date('2026-08-31T23:59:00Z');
  const cycle = billingCycle(now, 1);
  assert.ok(cycle.elapsedDays <= cycle.daysInCycle);
});

test('起始日被夹在 1..28', () => {
  assert.equal(loadConfig({ BILLING_CYCLE_START_DAY: '31' }, new Date('2026-08-30T00:00:00Z')).cycle.cycleStart.getUTCDate(), 28);
  assert.equal(loadConfig({ BILLING_CYCLE_START_DAY: '0' }, new Date('2026-08-30T00:00:00Z')).cycle.cycleStart.getUTCDate(), 1);
});
