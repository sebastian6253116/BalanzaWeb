/**
 * One synchronisation cycle.
 *
 * Contract with the cloud:
 *   - `GET /agent/sync?revision=N` answers 304 when there is nothing new, and the
 *     agent must then do **nothing at all** (no file building, no traffic to the scales).
 *   - When a revision arrives, records are built locally and pushed only to the
 *     scales whose content actually changed.
 *   - The local revision only advances when every target scale acknowledged, so a
 *     failed push is retried on the next poll instead of being silently skipped.
 */
import { createHash } from 'node:crypto';
import { buildRecord, indexTableNumbers } from '../../../packages/plu-format/src/index.js';

export function hashRecords(records) {
  const hash = createHash('sha256');
  for (const record of records) hash.update(record);
  return hash.digest('hex');
}

export async function syncOnce({
  config,
  fetchImpl = fetch,
  push,
  persist = () => {},
  log = () => {},
  timeoutMs = 1500,
  retries = 3,
}) {
  const state = config.state ?? { revision: 0, scaleHashes: {} };

  const response = await fetchImpl(`${config.apiUrl}/agent/sync?revision=${state.revision ?? 0}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });

  if (response.status === 304) {
    log('no changes (304) — nothing to do');
    return { changed: false, revision: state.revision ?? 0 };
  }
  if (!response.ok) {
    throw new Error(`sync failed: HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (!payload.catalog?.articles?.length || !payload.scales?.length) {
    log(`revision ${payload.revision ?? 0} has ${payload.catalog?.articles?.length ?? 0} articles and ${payload.scales?.length ?? 0} scales — nothing to push`);
    config.state = { ...state, revision: payload.revision ?? 0, lastSyncAt: new Date().toISOString() };
    persist(config);
    return { changed: true, revision: payload.revision, pushed: [], skipped: [] };
  }

  const records = payload.catalog.articles.map((article) => buildRecord(article));
  const hash = hashRecords(records);
  const indexTable = indexTableNumbers(payload.catalog.articles);
  const targetIds = payload.targetScaleIds;
  const targets = payload.scales.filter((scale) => !targetIds || targetIds.includes(scale.id));

  const pushed = [];
  const skipped = [];
  let failed = false;

  for (const scale of targets) {
    if (state.scaleHashes?.[scale.id] === hash) {
      skipped.push(scale.id);
      log(`scale ${scale.name} (${scale.host}): content unchanged, skipped`);
      continue;
    }
    try {
      const result = await push({ host: scale.host, port: scale.port, records, indexTable, timeoutMs, retries });
      pushed.push({ scaleId: scale.id, name: scale.name, result });
      log(`scale ${scale.name} (${scale.host}:${scale.port}): ${result.records} records in ${result.durationMs} ms`);
      await report({ config, fetchImpl, body: { scaleId: scale.id, revision: payload.revision, deploymentId: payload.deploymentId, ok: true, records: result.records, frames: result.framesSent, durationMs: result.durationMs } });
      state.scaleHashes = { ...(state.scaleHashes ?? {}), [scale.id]: hash };
    } catch (err) {
      failed = true;
      log(`scale ${scale.name} (${scale.host}:${scale.port}): FAILED — ${err.message}`);
      await report({ config, fetchImpl, body: { scaleId: scale.id, revision: payload.revision, deploymentId: payload.deploymentId, ok: false, error: err.message } }).catch(() => {});
    }
  }

  config.state = {
    ...state,
    revision: failed ? (state.revision ?? 0) : payload.revision,
    lastSyncAt: new Date().toISOString(),
  };
  if (payload.sede?.pollIntervalSeconds && config.allowLocalOverride !== true) {
    config.pollIntervalSeconds = payload.sede.pollIntervalSeconds;
  }
  persist(config);

  return { changed: true, revision: config.state.revision, pushed, skipped, failed };
}

async function report({ config, fetchImpl, body }) {
  const response = await fetchImpl(`${config.apiUrl}/agent/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`report failed: HTTP ${response.status}`);
}
