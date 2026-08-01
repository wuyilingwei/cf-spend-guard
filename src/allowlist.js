// 白名单式调用闸门。凡不在册的方法+路径一律拒发。
//
// 用白名单而非黑名单，是因为这个工具的核心承诺是「永远不删除任何数据」：
// 黑名单漏一条就破功，白名单漏一条只是功能少一块。
//
// 收录标准：该调用只能影响「访问」或「调度」，且可逆。
// 任何会删除对象、删除桶、或改动生命周期规则（会级联删对象）的端点一律不收。

const ACCT = '[^/]+';
const ZONE = '[^/]+';
const NAME = '[^/]+';

const ALLOWED = [
  // Workers：列脚本、读写 cron 调度
  { method: 'GET', pattern: `^/accounts/${ACCT}/workers/scripts$` },
  { method: 'GET', pattern: `^/accounts/${ACCT}/workers/scripts/${NAME}/schedules$` },
  { method: 'PUT', pattern: `^/accounts/${ACCT}/workers/scripts/${NAME}/schedules$` },

  // Zone 与 WAF 自定义规则：读入口规则集、加规则、开关规则
  { method: 'GET', pattern: `^/zones(\\?.*)?$` },
  { method: 'GET', pattern: `^/zones/${ZONE}/rulesets/phases/[^/]+/entrypoint$` },
  { method: 'PUT', pattern: `^/zones/${ZONE}/rulesets/phases/[^/]+/entrypoint$` },
  { method: 'POST', pattern: `^/zones/${ZONE}/rulesets/${NAME}/rules$` },
  { method: 'PATCH', pattern: `^/zones/${ZONE}/rulesets/${NAME}/rules/${NAME}$` },

  // R2：只读桶清单，只开关公开访问域，绝不触碰对象与生命周期
  { method: 'GET', pattern: `^/accounts/${ACCT}/r2/buckets(\\?.*)?$` },
  { method: 'GET', pattern: `^/accounts/${ACCT}/r2/buckets/${NAME}/domains/managed$` },
  { method: 'PUT', pattern: `^/accounts/${ACCT}/r2/buckets/${NAME}/domains/managed$` },
  { method: 'GET', pattern: `^/accounts/${ACCT}/r2/buckets/${NAME}/domains/custom$` },
  { method: 'PUT', pattern: `^/accounts/${ACCT}/r2/buckets/${NAME}/domains/custom/${NAME}$` },
].map((r) => ({ method: r.method, re: new RegExp(r.pattern) }));

// 即便某天有人往白名单里加错东西，这几类也要二次拦下。
// 双保险：白名单是「只准做什么」，这里是「无论如何不准做什么」。
const NEVER = [
  { re: /^\/accounts\/[^/]+\/r2\/buckets\/[^/]+\/objects/, why: '触碰 R2 对象' },
  { re: /^\/accounts\/[^/]+\/r2\/buckets\/[^/]+\/lifecycle/, why: '改生命周期规则会级联删除对象' },
  { re: /^\/accounts\/[^/]+\/r2\/buckets\/[^/]+\/sippy/, why: '改变数据来源语义' },
];

export class BlockedCallError extends Error {
  constructor(method, path, why) {
    super(`调用被闸门拒绝：${method} ${path}${why ? `（${why}）` : '（不在白名单内）'}`);
    this.name = 'BlockedCallError';
    this.method = method;
    this.path = path;
  }
}

/**
 * 发请求前的硬闸门。不通过就抛，绝不放行。
 */
export function assertAllowed(method, path) {
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '');

  // DELETE 在本工具的任何合法流程里都不需要，一律拒
  if (m === 'DELETE') throw new BlockedCallError(m, p, 'DELETE 永不允许');

  for (const rule of NEVER) {
    if (rule.re.test(p)) throw new BlockedCallError(m, p, rule.why);
  }

  const hit = ALLOWED.some((rule) => rule.method === m && rule.re.test(p));
  if (!hit) throw new BlockedCallError(m, p);
  return true;
}

export const _internals = { ALLOWED, NEVER };
