import { CloudflareApi } from './cfapi.js';
import { loadConfig } from './config.js';
import { estimateCost } from './pricing.js';
import { collectUsage } from './usage.js';
import { notify } from './notify.js';
import { readState, restore, trip } from './enforce.js';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return json(await runCheck(env, { evaluateOnly: true }));
    }

    if (url.pathname === '/check' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
      return json(await runCheck(env));
    }

    if (url.pathname === '/restore' && request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401);
      const config = loadConfig(env);
      const api = new CloudflareApi({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID });
      const result = await restore(api, env.STATE);
      await notify(config.alertWebhook, { event: 'restored', mode: config.mode, ...result });
      return json(result);
    }

    return json({ error: 'not found' }, 404);
  },
};

/**
 * 一轮完整检查：采集 → 折算 → 判定 → （必要且已 armed 时）断流。
 */
export async function runCheck(env, { evaluateOnly = false } = {}) {
  const config = loadConfig(env);
  const api = new CloudflareApi({ token: env.CF_API_TOKEN, accountId: env.CF_ACCOUNT_ID });

  const usage = await collectUsage(api, config.cycle);
  const verdict = evaluate(usage, config);

  const state = await readState(env.STATE);
  const report = {
    event: 'report',
    mode: config.mode,
    cycleFrom: config.cycle.from.toISOString(),
    cycleTo: config.cycle.to.toISOString(),
    truncated: config.cycle.truncated,
    alreadyTripped: state.tripped === true,
    ...verdict,
  };

  if (evaluateOnly || !verdict.shouldTrip || state.tripped) return report;

  if (config.mode !== 'armed') {
    report.event = 'would-trip';
    await notify(config.alertWebhook, report);
    return report;
  }

  const result = await trip(api, env.STATE, config, verdict.reason);
  report.event = 'tripped';
  report.actions = result.actions;
  await notify(config.alertWebhook, report);
  return report;
}

/**
 * 逐产品折算并对比阈值。任一产品超标即需断流。
 * 取数失败的产品按 tripOnUnknown 处理，默认不因数据源故障误杀。
 */
export function evaluate(usage, config) {
  const products = {};
  const exceeded = [];

  for (const [product, limit] of Object.entries(config.thresholds)) {
    const probe = usage[product];
    if (!probe || probe.status !== 'ok') {
      products[product] = { status: 'unknown', limit, note: probe?.note ?? 'no data' };
      if (config.tripOnUnknown) exceeded.push(`${product} 取数失败且已配置为按超标处理`);
      continue;
    }

    const { usd, breakdown } = estimateCost(product, probe.metrics);
    const over = usd > limit;
    products[product] = {
      status: 'ok',
      usd,
      limit,
      exceeded: over,
      breakdown,
      metrics: probe.metrics,
      confidence: probe.confidence,
      note: probe.note,
    };
    if (over) exceeded.push(`${product} 估算 $${usd.toFixed(4)} 超过上限 $${limit}`);
  }

  const totalUsd = Object.values(products).reduce((a, p) => a + (p.usd ?? 0), 0);
  return {
    products,
    totalUsd: Math.round(totalUsd * 1e6) / 1e6,
    shouldTrip: exceeded.length > 0,
    reason: exceeded.join('；'),
  };
}

function authorized(request, env) {
  const given = request.headers.get('x-guard-secret') ?? '';
  const want = env.RESTORE_SECRET ?? '';
  if (!want || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
