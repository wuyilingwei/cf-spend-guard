export async function notify(webhook, payload) {
  if (!webhook) return { sent: false, reason: 'no webhook configured' };
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: summarize(payload), detail: payload }),
      signal: AbortSignal.timeout(10_000),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: String(err?.message ?? err) };
  }
}

function summarize(p) {
  const head = p.event === 'tripped' ? '已断流' : p.event === 'restored' ? '已恢复' : '用量报告';
  const lines = [`[cf-spend-guard] ${head}（${p.mode ?? ''}）`];
  if (p.reason) lines.push(`原因：${p.reason}`);
  for (const [product, r] of Object.entries(p.products ?? {})) {
    const state = r.status === 'unknown' ? '取数失败' : `$${r.usd?.toFixed(4)} / $${r.limit}`;
    lines.push(`- ${product}: ${state}${r.exceeded ? '  ← 超标' : ''}`);
  }
  if (p.truncated) lines.push('注意：周期起点早于 31 天数据保留期，估算偏低');
  return lines.join('\n');
}
