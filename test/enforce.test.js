import test from 'node:test';
import assert from 'node:assert/strict';
import { restore, trip } from '../src/enforce.js';
import { loadConfig } from '../src/config.js';

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

/**
 * 最小可用的 API 替身：记录所有写操作，供断言「只断不删」与恢复正确性。
 */
function fakeApi({ scripts = {}, zones = [], wafEnabled = {} } = {}) {
  const calls = [];
  const schedules = { ...scripts };
  const enabled = { ...wafEnabled };

  return {
    accountId: 'acct',
    calls,
    schedules,
    enabled,
    async restAll(path) {
      if (path.startsWith('/zones?')) return zones;
      return [];
    },
    async rest(path, { method = 'GET', body } = {}) {
      calls.push({ method, path, body });

      if (path === '/accounts/acct/workers/scripts') {
        return Object.keys(schedules).map((id) => ({ id }));
      }

      const sched = path.match(/^\/accounts\/acct\/workers\/scripts\/(.+)\/schedules$/);
      if (sched) {
        const name = sched[1];
        if (method === 'PUT') {
          schedules[name] = body;
          return {};
        }
        return { schedules: schedules[name] ?? [] };
      }

      const entry = path.match(/^\/zones\/(.+)\/rulesets\/phases\/.+\/entrypoint$/);
      if (entry) {
        const zoneId = entry[1];
        return {
          id: `rs-${zoneId}`,
          rules: [{ id: `rule-${zoneId}`, description: 'cf-spend-guard:block', enabled: enabled[zoneId] === true }],
        };
      }

      const rule = path.match(/^\/zones\/(.+)\/rulesets\/.+\/rules\/(.+)$/);
      if (rule && method === 'PATCH') {
        enabled[rule[1]] = body.enabled;
        return {};
      }

      throw new Error(`unexpected call ${method} ${path}`);
    },
  };
}

const config = loadConfig({ EXEMPT_SCRIPTS: 'keep-me' });

test('跳闸清空 cron 并启用 block 规则', async () => {
  const api = fakeApi({
    scripts: { 'app-worker': [{ cron: '*/5 * * * *' }] },
    zones: [{ id: 'z1', name: 'example.test' }],
  });
  const kv = fakeKv();

  await trip(api, kv, config, 'test', new Set(['workers']));

  assert.deepEqual(api.schedules['app-worker'], []);
  assert.equal(api.enabled.z1, true);
  assert.equal((await kv.get('state', 'json')).tripped, true);
});

test('守卫自身与豁免名单的 cron 不被清空', async () => {
  const api = fakeApi({
    scripts: {
      'cf-spend-guard': [{ cron: '*/10 * * * *' }],
      'keep-me': [{ cron: '0 * * * *' }],
      'app-worker': [{ cron: '*/5 * * * *' }],
    },
  });

  await trip(api, fakeKv(), config, 'test', new Set(['workers']));

  assert.deepEqual(api.schedules['cf-spend-guard'], [{ cron: '*/10 * * * *' }]);
  assert.deepEqual(api.schedules['keep-me'], [{ cron: '0 * * * *' }]);
  assert.deepEqual(api.schedules['app-worker'], []);
});

test('恢复把 cron 原样放回并关闭 block 规则', async () => {
  const api = fakeApi({
    scripts: { 'app-worker': [{ cron: '*/5 * * * *' }, { cron: '0 3 * * *' }] },
    zones: [{ id: 'z1', name: 'example.test' }],
  });
  const kv = fakeKv();

  await trip(api, kv, config, 'test', new Set(['workers']));
  await restore(api, kv);

  assert.deepEqual(api.schedules['app-worker'], [{ cron: '*/5 * * * *' }, { cron: '0 3 * * *' }]);
  assert.equal(api.enabled.z1, false);
  assert.equal((await kv.get('state', 'json')).tripped, false);
});

test('跳闸前本就启用的 block 规则，恢复时不动它', async () => {
  const api = fakeApi({
    scripts: {},
    zones: [{ id: 'z1', name: 'example.test' }],
    wafEnabled: { z1: true },
  });
  const kv = fakeKv();

  await trip(api, kv, config, 'test', new Set(['workers']));
  await restore(api, kv);

  assert.equal(api.enabled.z1, true);
});

test('全程不发出任何删除类调用', async () => {
  const api = fakeApi({
    scripts: { 'app-worker': [{ cron: '*/5 * * * *' }] },
    zones: [{ id: 'z1', name: 'example.test' }],
  });
  const kv = fakeKv();

  await trip(api, kv, config, 'test', new Set(['workers']));
  await restore(api, kv);

  assert.equal(api.calls.some((c) => c.method === 'DELETE'), false);
  assert.equal(api.calls.some((c) => /routes|domains|buckets/.test(c.path)), false);
});

test('单个脚本失败不影响其余脚本被处理', async () => {
  const api = fakeApi({
    scripts: { 'bad-worker': [{ cron: '* * * * *' }], 'app-worker': [{ cron: '*/5 * * * *' }] },
  });
  const original = api.rest;
  api.rest = async (path, init) => {
    if (path.includes('bad-worker')) throw new Error('boom');
    return original(path, init);
  };

  const result = await trip(api, fakeKv(), config, 'test', new Set(['workers']));

  assert.deepEqual(api.schedules['app-worker'], []);
  assert.ok(result.actions.some((a) => a.target === 'bad-worker' && a.result === 'error'));
});

test('没有快照时恢复应报错而不是静默成功', async () => {
  await assert.rejects(() => restore(fakeApi(), fakeKv()), /no snapshot/);
});
