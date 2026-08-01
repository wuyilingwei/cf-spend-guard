import test from 'node:test';
import assert from 'node:assert/strict';
import { cutExternalAccess, restoreExternalAccess } from '../src/r2access.js';
import { assertAllowed } from '../src/allowlist.js';
import { trip } from '../src/enforce.js';
import { loadConfig } from '../src/config.js';

function fakeKv() {
  const store = new Map();
  return {
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
 * 所以测试同时验证「实现发出的调用确实都在允许集内」。
 * 按辖区分命名空间，列桶用游标翻页，与真实 API 一致。
 */
function fakeR2Api({ world = {}, pageSize = 100, unavailable = ['fedramp'], renameOnEnable = false } = {}) {
  const state = structuredClone(world);
  const calls = [];
  const jurOf = (h) => h?.['cf-r2-jurisdiction'] ?? 'default';

  return {
    accountId: 'acct',
    calls,
    state,
    async rest(path, { method = 'GET', body, headers } = {}) {
      assertAllowed(method, path);
      const jur = jurOf(headers);
      calls.push({ method, path, body, jurisdiction: jur });

      if (path.startsWith('/accounts/acct/r2/buckets?')) {
        if (unavailable.includes(jur)) throw new Error(`jurisdiction ${jur} not enabled`);
        const names = Object.keys(state[jur] ?? {});
        const cursor = new URL(`https://x/${path}`).searchParams.get('cursor');
        const start = cursor ? Number(cursor) : 0;
        return {
          buckets: names.slice(start, start + pageSize).map((name) => ({ name })),
          cursor: start + pageSize < names.length ? String(start + pageSize) : '',
        };
      }

      const pick = (name) => {
        const b = state[jur]?.[name];
        if (!b) throw new Error(`no bucket ${name} in ${jur}`);
        return b;
      };

      const managed = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/managed$/);
      if (managed) {
        const b = pick(managed[1]);
        if (method === 'PUT') {
          b.managed = body.enabled;
          if (body.enabled && renameOnEnable) b.domain = `pub-new-${managed[1]}.r2.dev`;
          return { enabled: b.managed, domain: b.domain, bucketId: `id-${managed[1]}` };
        }
        return { enabled: b.managed, domain: b.domain, bucketId: `id-${managed[1]}` };
      }

      const list = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/custom$/);
      if (list) {
        return {
          domains: Object.entries(pick(list[1]).custom ?? {}).map(([domain, d]) => ({ domain, ...d })),
        };
      }

      const one = path.match(/^\/accounts\/acct\/r2\/buckets\/([^/]+)\/domains\/custom\/(.+)$/);
      if (one && method === 'PUT') {
        const d = pick(one[1]).custom[decodeURIComponent(one[2])];
        d.enabled = body.enabled;
        if (body.minTLS !== undefined) d.minTLS = body.minTLS;
        if (body.ciphers !== undefined) d.ciphers = body.ciphers;
        return {};
      }

      throw new Error(`unexpected ${method} ${path}`);
    },
    async restAll() {
      return [];
    },
  };
}

const world = () => ({
  default: {
    'lrc-upload': {
      managed: true,
      domain: 'pub-abc.r2.dev',
      custom: { 'files.example.test': { enabled: true, minTLS: '1.2', ciphers: ['ECDHE-RSA-AES128-GCM-SHA256'] } },
    },
    'private-bucket': { managed: false, domain: 'pub-def.r2.dev', custom: {} },
  },
  eu: {
    'eu-archive': { managed: true, domain: 'pub-eu.r2.dev', custom: {} },
  },
});

test('关闭托管域与自定义域的公开访问', async () => {
  const api = fakeR2Api({ world: world() });
  const { snapshot } = await cutExternalAccess(api);

  assert.equal(api.state.default['lrc-upload'].managed, false);
  assert.equal(api.state.default['lrc-upload'].custom['files.example.test'].enabled, false);
  assert.equal(snapshot.managed['default/lrc-upload'].enabled, true);
  assert.equal(snapshot.custom['default/lrc-upload']['files.example.test'].enabled, true);
});

test('快照记下 r2.dev 主机名，重新启用换号时显式报出', async () => {
  const api = fakeR2Api({ world: world(), renameOnEnable: true });
  const { snapshot } = await cutExternalAccess(api);
  assert.equal(snapshot.managed['default/lrc-upload'].domain, 'pub-abc.r2.dev');

  const { actions } = await restoreExternalAccess(api, snapshot);
  const hit = actions.find((a) => a.target === 'default/lrc-upload');
  assert.match(hit.result, /^restored-new-domain:/);
});

test('停用自定义域时把原 minTLS 与 ciphers 一并回传，避免静默 TLS 降级', async () => {
  const api = fakeR2Api({ world: world() });
  await cutExternalAccess(api);

  const put = api.calls.find((c) => c.method === 'PUT' && c.path.includes('/domains/custom/'));
  assert.equal(put.body.enabled, false);
  assert.equal(put.body.minTLS, '1.2');
  assert.deepEqual(put.body.ciphers, ['ECDHE-RSA-AES128-GCM-SHA256']);
  assert.equal(api.state.default['lrc-upload'].custom['files.example.test'].minTLS, '1.2');
});

test('其它辖区的桶同样被断，且带上 jurisdiction 头', async () => {
  const api = fakeR2Api({ world: world() });
  await cutExternalAccess(api);

  assert.equal(api.state.eu['eu-archive'].managed, false);
  const euCalls = api.calls.filter((c) => c.path.includes('eu-archive'));
  assert.ok(euCalls.length > 0);
  assert.ok(euCalls.every((c) => c.jurisdiction === 'eu'));
});

test('游标翻页取全量，不止第一页', async () => {
  const many = { default: {}, eu: {} };
  for (let i = 0; i < 7; i++) many.default[`bucket-${i}`] = { managed: true, domain: `d${i}`, custom: {} };
  const api = fakeR2Api({ world: many, pageSize: 2 });

  const { snapshot } = await cutExternalAccess(api);
  assert.equal(Object.keys(snapshot.managed).length, 7);
});

test('显式桶清单限定作用域，不牵连无关的桶', async () => {
  const api = fakeR2Api({ world: world() });
  await cutExternalAccess(api, { only: new Set(['lrc-upload']) });

  assert.equal(api.state.default['lrc-upload'].managed, false);
  assert.equal(api.state.eu['eu-archive'].managed, true);
});

test('形状可疑的桶名被跳过，不拼进路径', async () => {
  const api = fakeR2Api({ world: { default: { 'lrc-upload': { managed: true, domain: 'd', custom: {} } }, eu: {} } });
  api.rest = (
    (orig) => async (path, init) => {
      if (path.startsWith('/accounts/acct/r2/buckets?')) {
        return { buckets: [{ name: 'foo/lifecycle?x=' }, { name: 'lrc-upload' }], cursor: '' };
      }
      return orig(path, init);
    }
  )(api.rest);

  const { actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.result === 'skipped-bad-name'));
  assert.ok(!api.calls.some((c) => c.path.includes('lifecycle')));
});

test('PUT 后读回仍为 enabled 视为失败', async () => {
  const api = fakeR2Api({ world: world() });
  api.rest = (
    (orig) => async (path, init) => {
      const res = await orig(path, init);
      if (init?.method === 'PUT' && path.endsWith('/domains/managed')) return { ...res, enabled: true };
      return res;
    }
  )(api.rest);

  const { actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.kind === 'r2-managed' && a.result === 'error'));
});

test('未开通的辖区被记为 unavailable 而非错误', async () => {
  const api = fakeR2Api({ world: world() });
  const { actions } = await cutExternalAccess(api);
  assert.equal(actions.find((a) => a.kind === 'r2-list' && a.target === 'fedramp').result, 'unavailable');
});

test('default 辖区列桶失败要报为 error 而不是被吞掉', async () => {
  const api = fakeR2Api({ world: world(), unavailable: ['default', 'eu', 'fedramp'] });
  const { actions } = await cutExternalAccess(api);
  assert.equal(actions.find((a) => a.target === 'default').result, 'error');
});

test('本就关闭的开关不被动，也不会在恢复时被打开', async () => {
  const api = fakeR2Api({ world: world() });
  const { snapshot, actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.target === 'default/private-bucket' && a.result === 'already-off'));

  await restoreExternalAccess(api, snapshot);
  assert.equal(api.state.default['private-bucket'].managed, false);
});

test('恢复把本工具关掉的开关原样打开', async () => {
  const api = fakeR2Api({ world: world() });
  const { snapshot } = await cutExternalAccess(api);
  await restoreExternalAccess(api, snapshot);

  assert.equal(api.state.default['lrc-upload'].managed, true);
  assert.equal(api.state.default['lrc-upload'].custom['files.example.test'].enabled, true);
  assert.equal(api.state.eu['eu-archive'].managed, true);
});

test('恢复时辖区信息不丢，仍带正确的头', async () => {
  const api = fakeR2Api({ world: world() });
  const { snapshot } = await cutExternalAccess(api);
  const mark = api.calls.length;
  await restoreExternalAccess(api, snapshot);

  const euRestore = api.calls.slice(mark).filter((c) => c.path.includes('eu-archive'));
  assert.ok(euRestore.length > 0);
  assert.ok(euRestore.every((c) => c.jurisdiction === 'eu'));
});

test('全程不发出任何触碰对象、生命周期或桶锁的调用', async () => {
  const api = fakeR2Api({ world: world() });
  const { snapshot } = await cutExternalAccess(api);
  await restoreExternalAccess(api, snapshot);

  for (const c of api.calls) {
    assert.notEqual(c.method, 'DELETE', `${c.method} ${c.path}`);
    for (const forbidden of [/\/objects/, /\/lifecycle/, /\/lock/, /r2-catalog/, /slurper/, /temp-access/]) {
      assert.doesNotMatch(c.path, forbidden, c.path);
    }
  }
  assert.ok(api.calls.filter((c) => c.path.startsWith('/accounts/acct/r2/buckets?')).every((c) => c.method === 'GET'));
});

test('只有 R2 超标时不牵连 Worker 与 zone', async () => {
  const api = fakeR2Api({ world: world() });
  const kv = fakeKv();

  const { snapshot, actions } = await trip(api, kv, loadConfig({}), 'r2 超标', new Set(['r2']));

  assert.deepEqual(snapshot.crons, {});
  assert.deepEqual(snapshot.zones, []);
  assert.ok(snapshot.r2);
  assert.ok(actions.every((a) => a.kind.startsWith('r2-')));
  assert.deepEqual((await kv.get('state', 'json')).scope, ['r2']);
});

test('单个桶失败不阻断其余桶', async () => {
  const api = fakeR2Api({ world: world() });
  api.rest = (
    (orig) => async (path, init) => {
      if (path.includes('private-bucket')) throw new Error('boom');
      return orig(path, init);
    }
  )(api.rest);

  const { actions } = await cutExternalAccess(api);
  assert.ok(actions.some((a) => a.target === 'default/private-bucket' && a.result === 'error'));
  assert.equal(api.state.default['lrc-upload'].managed, false);
});

test('没有 R2 快照时恢复不报错也不误开', async () => {
  const api = fakeR2Api({ world: world() });
  const { actions } = await restoreExternalAccess(api, null);
  assert.deepEqual(actions, []);
  assert.equal(api.calls.length, 0);
});
