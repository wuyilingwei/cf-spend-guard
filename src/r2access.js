// R2 的处置与其它产品不同：超预算时中断外部访问，但绝不碰对象。
//
// 「中断外部访问」= 关掉两类公开入口的开关：
//   1. Cloudflare 托管的 r2.dev 子域（不在自有 zone 上，WAF 规则够不着，只能关开关）
//   2. bucket 上挂的自定义域（用 PUT 改 enabled，不用 DELETE 摘除 ——
//      DELETE 会销毁配置并连带删掉 CNAME，恢复得重走归属验证与签证书）
//
// 注意这个动作的实际效果边界：R2 出站流量免费，账单主体是存储 GB-月，
// 关访问只能止住 Class B 操作费，**不降低存储成本**。它是止血与防外泄，不是控本。
// 因此本模块绝不自行升级动作 —— 关完就停手，不达预期只通知人工。

// 桶按辖区分属不同命名空间，默认列表未必包含 eu/fedramp。
// 逐个辖区枚举，漏一个辖区就等于那些桶超预算时永远不会被断。
const JURISDICTIONS = ['default', 'eu', 'fedramp'];

// 桶名与域名一律校验后再拼路径：若取值含 / ? #，
// 模板拼接会把请求截断到另一个端点上（例如 foo/lifecycle?x= 会落到 lifecycle）
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DOMAIN_NAME = /^[a-z0-9.-]+$/i;

export async function cutExternalAccess(api, { only } = {}) {
  const snapshot = { managed: {}, custom: {} };
  const actions = [];

  for (const bucket of await listBuckets(api, actions, only)) {
    const key = bucketKey(bucket);

    await record(actions, key, 'managed', async () => {
      const before = await api.rest(managedPath(api, bucket), { headers: jurHeader(bucket) });
      // 连同 domain 一并快照：重新启用是否复用同一 r2.dev 主机名官方未确认，
      // 若换号则已发布的 URL 全部失效，事后至少要能查出原主机名
      snapshot.managed[key] = {
        enabled: before?.enabled === true,
        domain: before?.domain ?? null,
        bucketId: before?.bucketId ?? null,
      };
      if (before?.enabled !== true) return 'already-off';

      const after = await api.rest(managedPath(api, bucket), {
        method: 'PUT',
        body: { enabled: false },
        headers: jurHeader(bucket),
      });
      // 生效判据只认 API 读回的 enabled，不用流量或账单指标
      if (after && after.enabled === true) throw new Error('PUT 后读回仍为 enabled');
      return 'disabled';
    });

    for (const entry of await listCustomDomains(api, bucket, actions)) {
      const domain = entry?.domain;
      if (!domain) continue;
      await record(actions, `${key}:${domain}`, 'custom', async () => {
        if (!DOMAIN_NAME.test(domain)) throw new Error(`域名形状可疑，拒绝处理：${domain}`);
        (snapshot.custom[key] ??= {})[domain] = {
          enabled: entry?.enabled === true,
          minTLS: entry?.minTLS ?? null,
          ciphers: entry?.ciphers ?? null,
        };
        if (entry?.enabled !== true) return 'already-off';

        await api.rest(customDomainPath(api, bucket, domain), {
          method: 'PUT',
          // 官方未声明该 PUT 是合并还是整份替换语义。同家族的 lifecycle/lock 都是替换，
          // 只发 enabled 有把 minTLS/ciphers 静默重置成默认值的风险（等于 TLS 降级），
          // 故把原值一并回传
          body: withTls({ enabled: false }, entry),
          headers: jurHeader(bucket),
        });
        return 'disabled';
      });
    }
  }

  return { snapshot, actions };
}

/**
 * 只恢复本工具关掉的那些开关。跳闸前本就关着的保持关着 ——
 * 那是使用者自己的配置，恢复时顺手打开等于把私有桶重新公开。
 */
export async function restoreExternalAccess(api, snapshot) {
  const actions = [];
  if (!snapshot) return { actions };

  for (const [key, prev] of Object.entries(snapshot.managed ?? {})) {
    const bucket = parseKey(key);
    if (prev?.enabled !== true) {
      actions.push({ kind: 'r2-managed', target: key, result: 'left-off' });
      continue;
    }
    await record(actions, key, 'managed', async () => {
      const after = await api.rest(managedPath(api, bucket), {
        method: 'PUT',
        body: { enabled: true },
        headers: jurHeader(bucket),
      });
      // 主机名换了要显式报出来：字节还在，但按原地址取不回
      if (prev.domain && after?.domain && after.domain !== prev.domain) {
        return `restored-new-domain:${after.domain}`;
      }
      return 'restored';
    });
  }

  for (const [key, domains] of Object.entries(snapshot.custom ?? {})) {
    const bucket = parseKey(key);
    for (const [domain, prev] of Object.entries(domains ?? {})) {
      if (prev?.enabled !== true) {
        actions.push({ kind: 'r2-custom', target: `${key}:${domain}`, result: 'left-off' });
        continue;
      }
      await record(actions, `${key}:${domain}`, 'custom', async () => {
        await api.rest(customDomainPath(api, bucket, domain), {
          method: 'PUT',
          body: withTls({ enabled: true }, prev),
          headers: jurHeader(bucket),
        });
        return 'restored';
      });
    }
  }

  return { actions };
}

/**
 * 逐辖区 + 游标翻页枚举全部桶。R2 列桶用 cursor 而非 page，
 * 用错分页方式会静默只拿到第一页，然后报告「已全部关闭」。
 * only 给出显式桶名清单时只处理这些桶 —— 账户级预算触发却关掉全账户的桶，
 * 会误伤与超支无关的项目。
 */
async function listBuckets(api, actions, only) {
  const found = [];
  for (const jurisdiction of JURISDICTIONS) {
    let cursor = '';
    for (let guard = 0; guard < 100; guard++) {
      let page;
      try {
        const qs = new URLSearchParams({ per_page: '100' });
        if (cursor) qs.set('cursor', cursor);
        page = await api.rest(`/accounts/${api.accountId}/r2/buckets?${qs}`, {
          headers: jurHeader({ jurisdiction }),
        });
      } catch (err) {
        // 未开通的辖区会报错，属正常；只有 default 辖区失败才值得警觉
        actions.push({
          kind: 'r2-list',
          target: jurisdiction,
          result: jurisdiction === 'default' ? 'error' : 'unavailable',
          error: String(err?.message ?? err),
        });
        break;
      }

      for (const b of page?.buckets ?? []) {
        const name = b?.name;
        if (!name) continue;
        if (!BUCKET_NAME.test(name)) {
          actions.push({ kind: 'r2-list', target: name, result: 'skipped-bad-name' });
          continue;
        }
        if (only && only.size > 0 && !only.has(name)) continue;
        found.push({ name, jurisdiction });
      }
      cursor = page?.cursor ?? '';
      if (!cursor) break;
    }
  }
  return found;
}

async function listCustomDomains(api, bucket, actions) {
  try {
    const res = await api.rest(customPath(api, bucket), { headers: jurHeader(bucket) });
    return res?.domains ?? [];
  } catch (err) {
    actions.push({
      kind: 'r2-custom',
      target: bucketKey(bucket),
      result: 'error',
      error: String(err?.message ?? err),
    });
    return [];
  }
}

function withTls(body, prev) {
  const out = { ...body };
  if (prev?.minTLS) out.minTLS = prev.minTLS;
  if (Array.isArray(prev?.ciphers) && prev.ciphers.length) out.ciphers = prev.ciphers;
  return out;
}

function managedPath(api, bucket) {
  return `/accounts/${api.accountId}/r2/buckets/${safeName(bucket)}/domains/managed`;
}

function customPath(api, bucket) {
  return `/accounts/${api.accountId}/r2/buckets/${safeName(bucket)}/domains/custom`;
}

function customDomainPath(api, bucket, domain) {
  return `${customPath(api, bucket)}/${encodeURIComponent(domain)}`;
}

function safeName(bucket) {
  const name = bucket?.name ?? '';
  if (!BUCKET_NAME.test(name)) throw new Error(`桶名形状可疑，拒绝拼入路径：${name}`);
  return name;
}

function jurHeader(bucket) {
  const j = bucket?.jurisdiction;
  return j && j !== 'default' ? { 'cf-r2-jurisdiction': j } : undefined;
}

// 快照键带上辖区：不同辖区是各自独立的命名空间，同名桶可以并存。
// (name, jurisdiction) 全程作复合主键，禁止任何只按名字寻址的路径。
function bucketKey(bucket) {
  return `${bucket.jurisdiction}/${bucket.name}`;
}

function parseKey(key) {
  const at = key.indexOf('/');
  return at < 0
    ? { jurisdiction: 'default', name: key }
    : { jurisdiction: key.slice(0, at), name: key.slice(at + 1) };
}

async function record(actions, target, kind, fn) {
  try {
    actions.push({ kind: `r2-${kind}`, target, result: await fn() });
  } catch (err) {
    actions.push({ kind: `r2-${kind}`, target, result: 'error', error: String(err?.message ?? err) });
  }
}
