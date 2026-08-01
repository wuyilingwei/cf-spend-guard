// 守卫自身永远豁免，配置无法覆盖：一旦把自己也切了就再也恢复不了。
export const SELF_SCRIPT = 'cf-spend-guard';

export const PRODUCTS = ['workers', 'r2', 'durable_objects', 'kv', 'd1'];

const DEFAULT_THRESHOLDS = { workers: 5, r2: 5, durable_objects: 5, kv: 2, d1: 2 };

// GraphQL Analytics 只保留 31 天，早于此的数据取不到
const RETENTION_DAYS = 31;

export function loadConfig(env, now = new Date()) {
  const mode = env.MODE === 'armed' ? 'armed' : 'dry-run';
  const startDay = clampDay(env.BILLING_CYCLE_START_DAY);

  const thresholds = { ...DEFAULT_THRESHOLDS, ...parseJson(env.THRESHOLDS_USD) };
  for (const [product, limit] of Object.entries(thresholds)) {
    if (!PRODUCTS.includes(product)) delete thresholds[product];
    else if (!Number.isFinite(limit) || limit < 0) thresholds[product] = DEFAULT_THRESHOLDS[product];
  }

  const exempt = new Set(
    String(env.EXEMPT_SCRIPTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  exempt.add(SELF_SCRIPT);

  return {
    mode,
    thresholds,
    exemptScripts: exempt,
    tripOnUnknown: env.TRIP_ON_UNKNOWN === 'true',
    restoreSecret: env.RESTORE_SECRET ?? '',
    alertWebhook: env.ALERT_WEBHOOK ?? '',
    cycle: billingCycle(now, startDay),
  };
}

/**
 * 计费周期至今的窗口。起点早于数据保留期时截断，并标记 truncated
 * 供上层提示「本轮估算不含周期早期用量，实际花费更高」。
 */
export function billingCycle(now, startDay) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), startDay));
  if (start > now) start.setUTCMonth(start.getUTCMonth() - 1);

  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);

  const daysInCycle = Math.round((next - start) / 86_400_000);
  const earliest = new Date(now.getTime() - RETENTION_DAYS * 86_400_000);
  const truncated = start < earliest;

  const from = truncated ? earliest : start;
  return {
    from,
    to: now,
    cycleStart: start,
    daysInCycle,
    elapsedDays: Math.max(0, (now - start) / 86_400_000),
    truncated,
  };
}

function clampDay(raw) {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, n));
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
