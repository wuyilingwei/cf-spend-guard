import { R2_CLASS_A, R2_FREE, proratedStorageGbMonth } from './pricing.js';

// 每个产品独立发查询：GraphQL 数据集字段随平台演进，单个探针失败不应拖垮整轮判定。
// 失败的产品记为 unknown，由上层按 tripOnUnknown 决定处置。

const DO_MEMORY_GB = 0.128; // DO 实例固定 128 MB，duration 折 GB-s 用

export async function collectUsage(api, cycle) {
  const vars = {
    acct: api.accountId,
    from: cycle.from.toISOString(),
    to: cycle.to.toISOString(),
    fromDate: cycle.from.toISOString().slice(0, 10),
    toDate: cycle.to.toISOString().slice(0, 10),
  };

  const probes = {
    workers: probeWorkers,
    r2: probeR2,
    durable_objects: probeDurableObjects,
    kv: probeKv,
    d1: probeD1,
  };

  const entries = await Promise.all(
    Object.entries(probes).map(async ([product, probe]) => {
      try {
        return [product, await probe(api, vars, cycle)];
      } catch (err) {
        return [product, { status: 'unknown', metrics: {}, note: String(err?.message ?? err) }];
      }
    }),
  );
  return Object.fromEntries(entries);
}

async function probeWorkers(api, vars) {
  const data = await api.graphql(
    `query($acct:String!,$from:Time!,$to:Time!){
      viewer{accounts(filter:{accountTag:$acct}){
        workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
          sum{requests}
          quantiles{cpuTimeP50}
          dimensions{scriptName}
        }
      }}
    }`,
    vars,
  );

  const rows = data.workersInvocationsAdaptive ?? [];
  let requests = 0;
  let cpuUs = 0;
  for (const row of rows) {
    const n = row?.sum?.requests ?? 0;
    requests += n;
    cpuUs += n * (row?.quantiles?.cpuTimeP50 ?? 0);
  }

  return {
    status: 'ok',
    // 该数据集只暴露 CPU 时间分位数不暴露总和，故用 P50×请求数粗估
    confidence: { cpu_ms: 'low' },
    metrics: { requests, cpu_ms: cpuUs / 1000 },
  };
}

async function probeR2(api, vars, cycle) {
  const data = await api.graphql(
    `query($acct:String!,$from:Time!,$to:Time!){
      viewer{accounts(filter:{accountTag:$acct}){
        r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
          sum{requests}
          dimensions{actionType}
        }
        r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
          max{payloadSize,metadataSize}
          dimensions{date}
        }
      }}
    }`,
    vars,
  );

  let classA = 0;
  let classB = 0;
  for (const row of data.r2OperationsAdaptiveGroups ?? []) {
    const action = row?.dimensions?.actionType ?? '';
    const n = row?.sum?.requests ?? 0;
    if (R2_FREE.has(action)) continue;
    if (R2_CLASS_A.has(action)) classA += n;
    else classB += n;
  }

  const daily = (data.r2StorageAdaptiveGroups ?? []).map(
    (row) => ((row?.max?.payloadSize ?? 0) + (row?.max?.metadataSize ?? 0)) / 1e9,
  );
  const avgGb = daily.length ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;

  return {
    status: 'ok',
    metrics: {
      class_a: classA,
      class_b: classB,
      storage_gb_month: proratedStorageGbMonth(avgGb, cycle.elapsedDays, cycle.daysInCycle),
    },
  };
}

async function probeDurableObjects(api, vars, cycle) {
  const data = await api.graphql(
    `query($acct:String!,$from:Time!,$to:Time!){
      viewer{accounts(filter:{accountTag:$acct}){
        durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
          sum{requests}
        }
        durableObjectsStorageGroups(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
          max{storedBytes}
          dimensions{date}
        }
      }}
    }`,
    vars,
  );

  const requests = sumField(data.durableObjectsInvocationsAdaptiveGroups, (r) => r?.sum?.requests);
  const dailyGb = (data.durableObjectsStorageGroups ?? []).map((r) => (r?.max?.storedBytes ?? 0) / 1e9);
  const avgGb = dailyGb.length ? dailyGb.reduce((a, b) => a + b, 0) / dailyGb.length : 0;

  const duration = await probeDoDuration(api, vars);

  return {
    status: 'ok',
    confidence: duration.confidence,
    note: duration.note,
    metrics: {
      requests,
      duration_gb_s: duration.gbSeconds,
      storage_gb_month: proratedStorageGbMonth(avgGb, cycle.elapsedDays, cycle.daysInCycle),
    },
  };
}

/**
 * DO 的 duration（GB-s）是最容易失控的计费项，但官方文档未明确其字段名。
 * 按候选逐个尝试，全失败时返回 0 并标注，让上层告警而不是静默当成没花钱。
 */
async function probeDoDuration(api, vars) {
  const candidates = ['activeTime', 'wallTime', 'cpuTime'];
  for (const field of candidates) {
    try {
      const data = await api.graphql(
        `query($acct:String!,$from:Time!,$to:Time!){
          viewer{accounts(filter:{accountTag:$acct}){
            durableObjectsPeriodicGroups(limit:10000,filter:{datetime_geq:$from,datetime_leq:$to}){
              sum{${field}}
            }
          }}
        }`,
        vars,
      );
      const micros = sumField(data.durableObjectsPeriodicGroups, (r) => r?.sum?.[field]);
      return {
        gbSeconds: (micros / 1e6) * DO_MEMORY_GB,
        confidence: { duration_gb_s: field === 'activeTime' ? 'medium' : 'low' },
        note: `duration 取自 ${field}`,
      };
    } catch {
      continue;
    }
  }
  return {
    gbSeconds: 0,
    confidence: { duration_gb_s: 'none' },
    note: 'DO duration 字段全部候选均不可用，该项未计入',
  };
}

async function probeKv(api, vars, cycle) {
  const data = await api.graphql(
    `query($acct:String!,$fromDate:Date!,$toDate:Date!){
      viewer{accounts(filter:{accountTag:$acct}){
        kvOperationsAdaptiveGroups(limit:10000,filter:{date_geq:$fromDate,date_leq:$toDate}){
          sum{requests}
          dimensions{actionType}
        }
        kvStorageAdaptiveGroups(limit:10000,filter:{date_geq:$fromDate,date_leq:$toDate}){
          max{byteCount}
          dimensions{date}
        }
      }}
    }`,
    vars,
  );

  const byAction = { reads: 0, writes: 0, deletes: 0, lists: 0 };
  const map = { read: 'reads', write: 'writes', delete: 'deletes', list: 'lists' };
  for (const row of data.kvOperationsAdaptiveGroups ?? []) {
    const key = map[row?.dimensions?.actionType];
    if (key) byAction[key] += row?.sum?.requests ?? 0;
  }

  const dailyGb = (data.kvStorageAdaptiveGroups ?? []).map((r) => (r?.max?.byteCount ?? 0) / 1e9);
  const avgGb = dailyGb.length ? dailyGb.reduce((a, b) => a + b, 0) / dailyGb.length : 0;

  return {
    status: 'ok',
    metrics: {
      ...byAction,
      storage_gb_month: proratedStorageGbMonth(avgGb, cycle.elapsedDays, cycle.daysInCycle),
    },
  };
}

async function probeD1(api, vars) {
  const data = await api.graphql(
    `query($acct:String!,$fromDate:Date!,$toDate:Date!){
      viewer{accounts(filter:{accountTag:$acct}){
        d1AnalyticsAdaptiveGroups(limit:10000,filter:{date_geq:$fromDate,date_leq:$toDate}){
          sum{rowsRead,rowsWritten}
        }
      }}
    }`,
    vars,
  );

  return {
    status: 'ok',
    metrics: {
      rows_read: sumField(data.d1AnalyticsAdaptiveGroups, (r) => r?.sum?.rowsRead),
      rows_written: sumField(data.d1AnalyticsAdaptiveGroups, (r) => r?.sum?.rowsWritten),
    },
  };
}

function sumField(rows, pick) {
  return (rows ?? []).reduce((acc, row) => acc + (pick(row) ?? 0), 0);
}
