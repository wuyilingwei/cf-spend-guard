// 「只断不删」：仅新增/启用一条 WAF block 规则，并清空 cron schedules。
// 两者都可逆，且执行前把原状态快照进 KV，恢复即回放。
// 不删 route、不删自定义域、不改 R2 桶配置。

const RULE_TAG = 'cf-spend-guard:block';
const WAF_PHASE = 'http_request_firewall_custom';
const KEY_STATE = 'state';
const KEY_SNAPSHOT = 'snapshot';

export async function readState(kv) {
  return (await kv.get(KEY_STATE, 'json')) ?? { tripped: false };
}

export async function writeState(kv, state) {
  await kv.put(KEY_STATE, JSON.stringify(state));
}

/**
 * 跳闸。先存快照再动手，任一子步骤失败不阻断其余步骤，最终汇总结果。
 */
export async function trip(api, kv, config, reason) {
  const snapshot = { at: new Date().toISOString(), crons: {}, zones: [] };
  const actions = [];

  const scripts = await listScripts(api);
  for (const name of scripts) {
    if (config.exemptScripts.has(name)) {
      actions.push({ kind: 'cron', target: name, result: 'exempt' });
      continue;
    }
    try {
      const schedules = await getSchedules(api, name);
      snapshot.crons[name] = schedules;
      if (schedules.length > 0) {
        await putSchedules(api, name, []);
        actions.push({ kind: 'cron', target: name, result: 'cleared', was: schedules });
      } else {
        actions.push({ kind: 'cron', target: name, result: 'none' });
      }
    } catch (err) {
      actions.push({ kind: 'cron', target: name, result: 'error', error: msg(err) });
    }
  }

  const zones = await listZones(api);
  for (const zone of zones) {
    try {
      const { rulesetId, ruleId, wasEnabled } = await ensureBlockRule(api, zone.id);
      snapshot.zones.push({ id: zone.id, name: zone.name, rulesetId, ruleId, wasEnabled });
      if (!wasEnabled) await setRuleEnabled(api, zone.id, rulesetId, ruleId, true);
      actions.push({ kind: 'waf', target: zone.name, result: wasEnabled ? 'already' : 'blocked' });
    } catch (err) {
      actions.push({ kind: 'waf', target: zone.name, result: 'error', error: msg(err) });
    }
  }

  await kv.put(KEY_SNAPSHOT, JSON.stringify(snapshot));
  await writeState(kv, { tripped: true, at: snapshot.at, reason });
  return { snapshot, actions };
}

/**
 * 恢复。回放快照里的 cron，并关闭 block 规则（保留规则本体，下次跳闸直接启用）。
 */
export async function restore(api, kv) {
  const snapshot = await kv.get(KEY_SNAPSHOT, 'json');
  if (!snapshot) throw new Error('no snapshot to restore from');
  const actions = [];

  for (const [name, schedules] of Object.entries(snapshot.crons ?? {})) {
    if (!schedules?.length) continue;
    try {
      await putSchedules(api, name, schedules);
      actions.push({ kind: 'cron', target: name, result: 'restored', to: schedules });
    } catch (err) {
      actions.push({ kind: 'cron', target: name, result: 'error', error: msg(err) });
    }
  }

  for (const zone of snapshot.zones ?? []) {
    // 跳闸前本就启用的规则不动，那是使用者自己配的
    if (zone.wasEnabled) {
      actions.push({ kind: 'waf', target: zone.name, result: 'left-as-was' });
      continue;
    }
    try {
      await setRuleEnabled(api, zone.id, zone.rulesetId, zone.ruleId, false);
      actions.push({ kind: 'waf', target: zone.name, result: 'unblocked' });
    } catch (err) {
      actions.push({ kind: 'waf', target: zone.name, result: 'error', error: msg(err) });
    }
  }

  await writeState(kv, { tripped: false, at: new Date().toISOString(), restoredFrom: snapshot.at });
  return { actions };
}

async function listScripts(api) {
  const scripts = await api.rest('/accounts/' + api.accountId + '/workers/scripts');
  return (scripts ?? []).map((s) => s.id).filter(Boolean);
}

async function getSchedules(api, script) {
  const res = await api.rest(`/accounts/${api.accountId}/workers/scripts/${script}/schedules`);
  return (res?.schedules ?? []).map((s) => ({ cron: s.cron })).filter((s) => s.cron);
}

async function putSchedules(api, script, schedules) {
  await api.rest(`/accounts/${api.accountId}/workers/scripts/${script}/schedules`, {
    method: 'PUT',
    body: schedules,
  });
}

async function listZones(api) {
  const zones = await api.restAll(`/zones?account.id=${api.accountId}`);
  return (zones ?? []).map((z) => ({ id: z.id, name: z.name }));
}

/**
 * 确保 zone 上存在本工具的 block 规则，默认停用。返回它当前是否已启用，
 * 以便恢复时不会误关使用者自己配的同名规则。
 */
async function ensureBlockRule(api, zoneId) {
  let ruleset;
  try {
    ruleset = await api.rest(`/zones/${zoneId}/rulesets/phases/${WAF_PHASE}/entrypoint`);
  } catch {
    ruleset = await api.rest(`/zones/${zoneId}/rulesets/phases/${WAF_PHASE}/entrypoint`, {
      method: 'PUT',
      body: { rules: [] },
    });
  }

  const existing = (ruleset.rules ?? []).find((r) => r.description === RULE_TAG);
  if (existing) {
    return { rulesetId: ruleset.id, ruleId: existing.id, wasEnabled: existing.enabled === true };
  }

  const updated = await api.rest(`/zones/${zoneId}/rulesets/${ruleset.id}/rules`, {
    method: 'POST',
    body: { action: 'block', expression: 'true', description: RULE_TAG, enabled: false },
  });
  const created = (updated.rules ?? []).find((r) => r.description === RULE_TAG);
  if (!created) throw new Error('block rule created but not found in ruleset');
  return { rulesetId: ruleset.id, ruleId: created.id, wasEnabled: false };
}

async function setRuleEnabled(api, zoneId, rulesetId, ruleId, enabled) {
  await api.rest(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${ruleId}`, {
    method: 'PATCH',
    body: { enabled },
  });
}

function msg(err) {
  return String(err?.message ?? err);
}
