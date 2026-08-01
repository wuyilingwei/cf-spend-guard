# cf-spend-guard

Cloudflare 账户级用量守卫：估算各产品计费周期至今的花费，超过设定的美元上限时自动断流。

Cloudflare 原生的 Budget alerts 只发邮件，官方文档明确写着 *do not pause or cap usage*。
这个 Worker 补上真正会动手的那一层。

## 它做什么

每 10 分钟一轮：

1. 经 GraphQL Analytics API 采集 Workers / R2 / Durable Objects / KV / D1 的用量
2. 按官方价格表扣除免费额度后折算成美元
3. 任一产品超过其阈值 → 断流，并发通知

断流动作只有两个，都可逆，且执行前先把原状态快照进 KV：

- 每个 zone 上启用一条 `block` 规则（规则由本工具创建，默认停用）
- 清空所有 Worker 的 cron schedules（守卫自身除外）

**不删** route、**不删**自定义域、**不改** R2 桶配置。

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
| `TRIP_ON_UNKNOWN` | `false` | 探针取数失败时是否按超标处理 |

守卫自身永远在豁免名单内，配置无法覆盖 —— 否则跳闸后没有东西能把它恢复回来。

## 已知边界

这些是设计上就拦不住的，不是待修的缺陷：

- **估算不等于账单。** 唯一可程序化读取的用量源是 GraphQL Analytics，Cloudflare 明确
  声明该数据不应用作计费依据（计费会排除 DDoS 流量等）。Billable Usage 面板数据准确，
  但目前没有导出 API。
- **开了 `r2.dev` 的公开桶拦不住。** 该托管子域不在自有 zone 上，WAF 规则覆盖不到；
  要挡只能关掉公开访问开关，那属于本工具刻意排除的「删」类动作。走自定义域暴露的桶
  不受此限，WAF 规则能覆盖。
- **Durable Object alarm 停不掉。** 没有任何外部 API 能取消他人 DO 的 alarm。要兜住
  这条，只能在 DO 代码里开工前自行读取一个 killswitch 后 `deleteAlarm()`。
- **Container 与 Workflow 不受断流影响。** 它们不靠入站请求驱动，需要另行处理。
- **Workers CPU 时间只有分位数没有总和**，成本由 P50×请求数粗估，输出中标为低置信。
- **DO duration（GB-s）字段名未在文档中确定**，代码按候选字段逐个尝试，全失败时该项
  计为 0 并在通知中标注 —— 而这恰恰是最容易失控的计费项。
