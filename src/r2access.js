// R2 的处置与其它产品不同：超预算时中断外部访问，但绝不碰对象。
//
// 「中断外部访问」= 关掉两类公开入口的开关：
//   1. Cloudflare 托管的 r2.dev 子域（不在自有 zone 上，WAF 规则够不着，只能关开关）
//   2. bucket 上挂的自定义域（用 PUT 改 enabled，不用 DELETE 摘除）
// 两者都是可逆开关，桶与对象原封不动。
//
// 走 Worker 绑定读取的路径不在此列，那条由 Worker 侧的断流覆盖。

/**
 * @returns {{snapshot: object, actions: object[]}}
 */
export async function cutExternalAccess(api) {
  const snapshot = { managed: {}, custom: {} };
  const actions = [];

  for (const bucket of await listBuckets(api)) {
    await withBucket(actions, bucket, 'managed', async () => {
      const managed = await api.rest(domainsManaged(api, bucket));
      const enabled = managed?.enabled === true;
      snapshot.managed[bucket] = enabled;
      if (!enabled) return 'already-off';
      await api.rest(domainsManaged(api, bucket), { method: 'PUT', body: { enabled: false } });
      return 'disabled';
    });

    const customs = await safeList(actions, bucket, () => api.rest(domainsCustom(api, bucket)));
    for (const entry of customs) {
      const domain = entry?.domain;
      if (!domain) continue;
      await withBucket(actions, `${bucket}:${domain}`, 'custom', async () => {
        const enabled = entry?.enabled === true;
        (snapshot.custom[bucket] ??= {})[domain] = enabled;
        if (!enabled) return 'already-off';
        await api.rest(`${domainsCustom(api, bucket)}/${domain}`, {
          method: 'PUT',
          body: { enabled: false },
        });
        return 'disabled';
      });
    }
  }

  return { snapshot, actions };
}

/**
 * 只恢复本工具关掉的那些开关。跳闸前本就关着的保持关着 ——
 * 那是使用者自己的配置，不该被守卫顺手打开。
 */
export async function restoreExternalAccess(api, snapshot) {
  const actions = [];
  if (!snapshot) return { actions };

  for (const [bucket, wasEnabled] of Object.entries(snapshot.managed ?? {})) {
    if (!wasEnabled) {
      actions.push({ kind: 'r2-managed', target: bucket, result: 'left-off' });
      continue;
    }
    await withBucket(actions, bucket, 'managed', async () => {
      await api.rest(domainsManaged(api, bucket), { method: 'PUT', body: { enabled: true } });
      return 'restored';
    });
  }

  for (const [bucket, domains] of Object.entries(snapshot.custom ?? {})) {
    for (const [domain, wasEnabled] of Object.entries(domains ?? {})) {
      if (!wasEnabled) {
        actions.push({ kind: 'r2-custom', target: `${bucket}:${domain}`, result: 'left-off' });
        continue;
      }
      await withBucket(actions, `${bucket}:${domain}`, 'custom', async () => {
        await api.rest(`${domainsCustom(api, bucket)}/${domain}`, {
          method: 'PUT',
          body: { enabled: true },
        });
        return 'restored';
      });
    }
  }

  return { actions };
}

async function listBuckets(api) {
  const res = await api.rest(`/accounts/${api.accountId}/r2/buckets`);
  const buckets = Array.isArray(res) ? res : (res?.buckets ?? []);
  return buckets.map((b) => b?.name).filter(Boolean);
}

function domainsManaged(api, bucket) {
  return `/accounts/${api.accountId}/r2/buckets/${bucket}/domains/managed`;
}

function domainsCustom(api, bucket) {
  return `/accounts/${api.accountId}/r2/buckets/${bucket}/domains/custom`;
}

async function safeList(actions, target, fn) {
  try {
    const res = await fn();
    return Array.isArray(res) ? res : (res?.domains ?? []);
  } catch (err) {
    actions.push({ kind: 'r2-custom', target, result: 'error', error: String(err?.message ?? err) });
    return [];
  }
}

async function withBucket(actions, target, kind, fn) {
  try {
    actions.push({ kind: `r2-${kind}`, target, result: await fn() });
  } catch (err) {
    actions.push({ kind: `r2-${kind}`, target, result: 'error', error: String(err?.message ?? err) });
  }
}
