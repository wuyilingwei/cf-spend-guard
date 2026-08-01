// Workers Paid 价格表与免费额度，取自官方 pricing 页面（2026-08 查证）。
// included = 每月免费额度，unit = 计价单位量，price = 每单位美元。

export const PRICING = {
  workers: {
    requests: { included: 10_000_000, unit: 1_000_000, price: 0.3 },
    cpu_ms: { included: 30_000_000, unit: 1_000_000, price: 0.02 },
  },
  r2: {
    class_a: { included: 1_000_000, unit: 1_000_000, price: 4.5 },
    class_b: { included: 10_000_000, unit: 1_000_000, price: 0.36 },
    storage_gb_month: { included: 10, unit: 1, price: 0.015 },
  },
  durable_objects: {
    requests: { included: 1_000_000, unit: 1_000_000, price: 0.15 },
    duration_gb_s: { included: 400_000, unit: 1_000_000, price: 12.5 },
    rows_read: { included: 25_000_000_000, unit: 1_000_000, price: 0.001 },
    rows_written: { included: 50_000_000, unit: 1_000_000, price: 1.0 },
    storage_gb_month: { included: 5, unit: 1, price: 0.2 },
  },
  kv: {
    reads: { included: 10_000_000, unit: 1_000_000, price: 0.5 },
    writes: { included: 1_000_000, unit: 1_000_000, price: 5.0 },
    deletes: { included: 1_000_000, unit: 1_000_000, price: 5.0 },
    lists: { included: 1_000_000, unit: 1_000_000, price: 5.0 },
    storage_gb_month: { included: 1, unit: 1, price: 0.5 },
  },
  d1: {
    rows_read: { included: 25_000_000_000, unit: 1_000_000, price: 0.001 },
    rows_written: { included: 50_000_000, unit: 1_000_000, price: 1.0 },
    storage_gb_month: { included: 5, unit: 1, price: 0.75 },
  },
};

// R2 操作分级。未列出的按 Class B 计（偏保守方向：低估风险小于漏算）。
export const R2_CLASS_A = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject',
  'CompleteMultipartUpload', 'CreateMultipartUpload', 'ListMultipartUploads',
  'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption',
  'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);

export const R2_FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

/**
 * 用量折算美元。免费额度先扣除，只对超出部分计价。
 * @param {string} product PRICING 的键
 * @param {Record<string, number>} metrics 该产品的用量
 * @returns {{usd: number, breakdown: Record<string, number>}}
 */
export function estimateCost(product, metrics) {
  const table = PRICING[product];
  if (!table) throw new Error(`unknown product: ${product}`);

  const breakdown = {};
  let usd = 0;
  for (const [metric, used] of Object.entries(metrics)) {
    const rule = table[metric];
    if (!rule || !Number.isFinite(used)) continue;
    const billable = Math.max(0, used - rule.included);
    const cost = (billable / rule.unit) * rule.price;
    breakdown[metric] = round(cost);
    usd += cost;
  }
  return { usd: round(usd), breakdown };
}

/**
 * 存储类计费是 GB-月，周期未走完时按已过天数折算。
 */
export function proratedStorageGbMonth(avgGb, elapsedDays, daysInCycle) {
  if (!Number.isFinite(avgGb) || daysInCycle <= 0) return 0;
  return avgGb * (elapsedDays / daysInCycle);
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}
