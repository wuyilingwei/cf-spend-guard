# cf-spend-guard

Cloudflare 账户级用量守卫：估算各产品计费周期至今的花费，超过设定的美元上限时自动断流。

Cloudflare 原生的 Budget alerts 只发邮件，官方文档明确写着 *do not pause or cap usage*。
这个 Worker 补上真正会动手的那一层。

## 它做什么

每 10 分钟一轮：

1. 经 GraphQL Analytics API 采集 Workers / R2 / Durable Objects / KV / D1 的用量
2. 按官方价格表扣除免费额度后折算成美元
3. 某个产品超过它自己的预算 → 执行该产品对应的处置，并发通知

处置按产品分派，不是一处超标就全账户熄火：

| 超标产品 | 动作 |
| :--- | :--- |
| **R2** | 关掉公开访问开关：`r2.dev` 托管域 + bucket 自定义域。**对象与桶一律不碰** |

| 其它 | 每个 zone 启用一条 `block` 规则 + 清空所有 Worker 的 cron schedules |

只有 R2 超标时不会牵连站点和定时任务；反之亦然。所有动作都可逆，执行前先把原状态
快照进 KV。

R2 这一路有两个细节值得说明：

- **停用自定义域用 `PUT {enabled:false}`，不用 `DELETE`。** 前者只翻开关，域名仍连着
  bucket，证书与 minTLS 配置保留，恢复就是再 `PUT {enabled:true}`；后者会销毁配置连带
  删掉 CNAME 记录，恢复得重走归属验证和签证书。
- **逐辖区枚举桶。** R2 的 `default` / `eu` / `fedramp` 是三个独立命名空间，默认列表
  未必包含后两者。漏掉一个辖区，就等于那里的桶超预算时永远不会被断。列桶用游标翻页
  （`cursor`，不是 `page`）。

### 永不删除数据是机制保证的，不是靠自觉

所有对外调用都要先过 `src/allowlist.js` 的白名单闸门，不在册的方法+路径直接抛错拒发：

- `DELETE` 无条件拒绝
- 触碰 `/objects` 的路径拒绝
- 触碰 `/lifecycle` 的路径拒绝（改生命周期规则会级联删对象）

用白名单而非黑名单，是因为黑名单漏一条就破功，白名单漏一条只是少个功能。测试里对此
有可执行断言。

## 部署

```bash
npm install
```

建 KV 命名空间，把返回的 id 填进 `wrangler.jsonc`：

```bash
npx wrangler kv namespace create STATE
```

配置密钥。API Token 需要三项权限：Account Analytics 读、Workers Scripts 编辑、Zone WAF 编辑。

```bash
npx wrangler secret put CF_API_TOKEN
```

```bash
npx wrangler secret put CF_ACCOUNT_ID
```

```bash
npx wrangler secret put RESTORE_SECRET
```

可选的通知地址：

```bash
npx wrangler secret put ALERT_WEBHOOK
```

部署：

```bash
npx wrangler deploy
```

## 上线顺序

`MODE` 默认是 `dry-run`，只估算和通知，不动任何东西。**先这样跑几天**，把 `/status`
的估算值和 dashboard 的 Billable Usage 面板对一对，确认量级对得上，再改成 `armed`。

跳过这一步的风险是估算偏差直接把站点切了。

## 端点

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/status` | 当前估算与跳闸状态，只读不执行 |
| POST | `/check` | 立刻跑一轮完整检查 |
| POST | `/restore` | 回放快照恢复 |

`/check` 与 `/restore` 需要 `x-guard-secret` 请求头，值为 `RESTORE_SECRET`。

```bash
curl -X POST https://<your-worker-host>/restore -H "x-guard-secret: $SECRET"
```

## 配置

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `MODE` | `dry-run` | 改成 `armed` 才会真正断流 |
| `THRESHOLDS_USD` | 见 wrangler.jsonc | 每产品美元上限，任一超标即跳闸 |
| `BILLING_CYCLE_START_DAY` | `1` | 计费周期起始日，取值 1–28 |
| `EXEMPT_SCRIPTS` | 空 | 额外豁免的 Worker 名，逗号分隔 |
| `R2_BUCKETS` | 空 | R2 预算覆盖哪些桶，逗号分隔。留空=全部桶 |
| `TRIP_ON_UNKNOWN` | `false` | 探针取数失败时是否按超标处理 |

守卫自身永远在豁免名单内，配置无法覆盖 —— 否则跳闸后没有东西能把它恢复回来。

## R2 断访问能做到什么、做不到什么

**先说最要紧的一条：关闭外部访问不会降低存储费。**

R2 的出站流量是免费的，账单主体是存储 `$0.015/GB-月`。关掉公开访问只能止住 Class B
操作费（`$0.36/百万`），存储那部分一分不少。

所以这个动作的定位是**止血与防外泄，不是控本**。如果你关了之后发现账单没降，那是预期
行为，不是没生效 —— 生效与否只看 API 读回的 `enabled` 字段，不要用账单或流量去判断。

工具**绝不会自行升级动作**。判据不达标只会通知人工，不会自己去加 lifecycle 过期规则或
删对象 —— 那条路径正是「关了但账单不降 → 判定没生效 → 加大动作」通向数据丢失的典型
剧本，已在设计上堵死。

### 关了公开访问之后仍然读得到的路径

| 路径 | 为什么拦不住 |
| :--- | :--- |
| Worker / Pages Functions 的 R2 绑定 | 不走公开域。Pages 的 production 与 preview 是两套独立绑定，各有持久 URL |
| 已签发的预签名 URL 与临时凭证 | 最长可再读 7 天，官方无吊销入口。除非吊销父 token —— 但那会自锁，工具不碰 |
| 边缘缓存副本 | 命中缓存不回源 R2，TTL 内继续对外交付。需要另行 purge |
| Cache Reserve | 它本身就建在 R2 之上，独立计费、30 天保留 |
| 事件通知 → Queues | 由**写入**触发，与读开关正交，照常计费 |

## 已知边界

这些是设计上就拦不住的，不是待修的缺陷：

- **估算不等于账单。** 唯一可程序化读取的用量源是 GraphQL Analytics，Cloudflare 明确
  声明该数据不应用作计费依据（计费会排除 DDoS 流量等）。Billable Usage 面板数据准确，
  但目前没有导出 API。
- **预签名 URL 可能仍然有效。** 关闭公开访问开关拦不住已经签发出去的 URL，它们会继续
  产生 Class B 计费直到过期。
- **走 Worker 绑定读取 R2 不受 R2 处置影响**，那条路径由 Worker 侧的断流覆盖 —— 也就是
  说只有 R2 超标、Worker 没超标时，经 Worker 代理的读取仍然通。
- **Durable Object alarm 停不掉。** 没有任何外部 API 能取消他人 DO 的 alarm。要兜住
  这条，只能在 DO 代码里开工前自行读取一个 killswitch 后 `deleteAlarm()`。
- **Container 与 Workflow 不受断流影响。** 它们不靠入站请求驱动，需要另行处理。
- **Workers CPU 时间只有分位数没有总和**，成本由 P50×请求数粗估，输出中标为低置信。
- **DO duration（GB-s）字段名未在文档中确定**，代码按候选字段逐个尝试，全失败时该项
  计为 0 并在通知中标注 —— 而这恰恰是最容易失控的计费项。
