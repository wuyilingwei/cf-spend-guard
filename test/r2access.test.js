import test from 'node:test';
import assert from 'node:assert/strict';
import { cutExternalAccess, restoreExternalAccess } from '../src/r2access.js';
import { assertAllowed } from '../src/allowlist.js';
import { trip } from '../src/enforce.js';
import { loadConfig } from '../src/config.js';

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k, t) {
      const v = store.get(k);
      return v === undefined ? null : t === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

/**
 * R2 替身。每次调用都先过真实的白名单闸门，
 * 这样测试同时验证「实现发出的调用确实都是被允许的」。
 */
function fakeR2Api({ buckets = {} } = {}) {
  const state = structuredClone(buckets);
  const calls = [];
  return {
    accountId: 'acct',
    calls,
    state,
    async rest(path, { method = 'GET', body } = {}) {
      assertAllowed(method, path);
      calls.push({ method, path, body });

      if (path === '/accounts/acct/r2/buckets') {
        return { buckets: Object.keys(state).map((name) => ({ name })) };
      }

      const managed = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/managed$/);
      if (managed) {
        const b = state[managed[1]];
        if (method === 'PUT') {
          b.managed = body.enabled;
          return {};
        }
        return { enabled: b.managed, domain: `${managed[1]}.r2.dev` };
      }

      const customList = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/custom$/);
      if (customList) {
        const b = state[customList[1]];
        return { domains: Object.entries(b.custom ?? {}).map(([domain, enabled]) => ({ domain, enabled })) };
      }

      const customOne = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/custom\/(.+)$/);
      if (customOne && method === 'PUT') {
        state[customOne[1]].custom[customOne[2]] = body.enabled;
        return {};
      }

      throw new Error(`unexpected ${method} ${path}`);
    },
    async restAll() {
      return [];
    },
  };
}

const sample = () => ({
  'lrc-upload': { managed: true, custom: { 'files.example.test': true } },
  'private-bucket': { managed: false, custom: {} },
});

test('关闭托管域与自定义域的公开访问', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const { snapshot } = await cutExternalAccess(api);

  assert.equal(api.state['lrc-upload'].managed, false);
  assert.equal(api.state['lrc-upload'].custom['files.example.test'], false);
  assert.equal(snapshot.managed['lrc-upload'], true);
  assert.equal(snapshot.custom['lrc-upload']['files.example.test'], true);
});

test('本就关闭的开关不被动，也不会在恢复时被打开', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const { snapshot, actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.target === 'private-bucket' && a.result === 'already-off'));

  await restoreExternalAccess(api, snapshot);
  assert.equal(api.state['private-bucket'].managed, false);
});

test('恢复把本工具关掉的开关原样打开', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const { snapshot } = await cutExternalAccess(api);
  await restoreExternalAccess(api, snapshot);

  assert.equal(api.state['lrc-upload'].managed, true);
  assert.equal(api.state['lrc-upload'].custom['files.example.test'], true);
});

test('全程不发出任何触碰对象或桶本身的调用', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const { snapshot } = await cutExternalAccess(api);
  await restoreExternalAccess(api, snapshot);

  for (const c of api.calls) {
    assert.notEqual(c.method, 'DELETE', `${c.method} ${c.path}`);
    assert.doesNotMatch(c.path, /\/objects/, c.path);
    assert.doesNotMatch(c.path, /\/lifecycle/, c.path);
  }
  // 只读桶清单，不新建不删除
  const bucketRootCalls = api.calls.filter((c) => c.path === '/accounts/acct/r2/buckets');
  assert.ok(bucketRootCalls.every((c) => c.method === 'GET'));
});

test('只有 R2 超标时不牵连 Worker 与 zone', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const kv = fakeKv();
  const config = loadConfig({});

  const { snapshot, actions } = await trip(api, kv, config, 'r2 超标', new Set(['r2']));

  assert.deepEqual(snapshot.crons, {});
  assert.deepEqual(snapshot.zones, []);
  assert.ok(snapshot.r2);
  assert.ok(actions.every((a) => a.kind.startsWith('r2-')));
  assert.deepEqual((await kv.get('state', 'json')).scope, ['r2']);
});

test('单个桶失败不阻断其余桶', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const original = api.rest;
  api.rest = async (path, init) => {
    if (path.includes('private-bucket')) throw new Error('boom');
    return original(path, init);
  };

  const { actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.target === 'private-bucket' && a.result === 'error'));
  assert.equal(api.state['lrc-upload'].managed, false);
});

test('没有 R2 快照时恢复不报错也不误开', async () => {
  const api = fakeR2Api({ buckets: sample() });
  const { actions } = await restoreExternalAccess(api, null);
  assert.deepEqual(actions, []);
  assert.equal(api.calls.length, 0);
});
