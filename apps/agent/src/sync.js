/**
 * One synchronisation cycle.
 *
 * Contract with the cloud:
 *   - `GET /agent/sync?revision=N` answers 304 when there is nothing new, and the
 *     agent must then do **nothing at all** (no file building, no traffic to the scales).
 *   - When a revision arrives, records are built locally and pushed only to the
 *     scales whose content actually changed.
 *   - The local revision only advances when every target scale acknowledged. A
 *     failed scale is retried with exponential backoff, so a dead scale does not
 *     fill the deployment history with identical failures.
 */
import { createHash } from 'node:crypto';
import { buildRecord, indexTableNumbers } from '../../../packages/plu-format/src/index.js';

const DEFAULT_BACKOFF_BASE_SECONDS = 60;
const DEFAULT_BACKOFF_MAX_SECONDS = 900;

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
  force = false,
  now = () => Date.now(),
}) {
  const state = config.state ?? { revision: 0, scaleHashes: {}, scaleRetries: {} };
  // A config file written by an older agent has no scaleRetries: treat it as empty.
  const retriesByScale = { ...(state.scaleRetries ?? {}) };
  const backoffBaseSeconds = positiveSeconds(config.backoffBaseSeconds, DEFAULT_BACKOFF_BASE_SECONDS);
  const backoffMaxSeconds = positiveSeconds(config.backoffMaxSeconds, DEFAULT_BACKOFF_MAX_SECONDS);
  const cycleNow = now();
  // A due retry must be fetched even when state.revision is already the newest
  // deployment: otherwise the API answers 304 and the scale never recovers.
  const hasDueRetry = Object.values(retriesByScale).some((retry) => {
    const nextAttemptMs = Date.parse(retry.nextAttemptAt);
    return Number.isFinite(nextAttemptMs) && nextAttemptMs <= cycleNow;
  });
  // Asking for revision 0 makes the API answer with the current deployment
  // instead of 304, which is what a forced push or a due retry needs.
  const revision = force || hasDueRetry ? 0 : state.revision ?? 0;

  const response = await fetchImpl(`${config.apiUrl}/agent/sync?revision=${revision}`, {
    headers: { authorization: `Bearer ${config.token}` },
  });

  if (response.status === 304) {
    log('no changes (304) — nothing to do');
    return {
      changed: false,
      revision: state.revision ?? 0,
      pushed: [],
      skipped: [],
      failed: false,
      retrying: pendingRetries(retriesByScale, cycleNow),
    };
  }
  if (!response.ok) {
    throw new Error(`sync failed: HTTP ${response.status}`);
  }

  const payload = await response.json();

  // A scale deleted or disabled in the web must not keep showing up in `status`.
  const payloadScales = Array.isArray(payload.scales) ? payload.scales : [];
  const knownScaleIds = new Set(payloadScales.map((scale) => String(scale.id)));
  for (const scaleId of Object.keys(retriesByScale)) {
    if (!knownScaleIds.has(scaleId)) delete retriesByScale[scaleId];
  }

  if (!payload.catalog?.articles?.length || !payloadScales.length) {
    log(`revision ${payload.revision ?? 0} has ${payload.catalog?.articles?.length ?? 0} articles and ${payloadScales.length} scales — nothing to push`);
    config.state = {
      ...state,
      revision: payload.revision ?? 0,
      lastSyncAt: new Date(cycleNow).toISOString(),
      scaleRetries: retriesByScale,
    };
    persist(config);
    return {
      changed: true,
      revision: payload.revision,
      pushed: [],
      skipped: [],
      failed: false,
      retrying: pendingRetries(retriesByScale, cycleNow),
    };
  }

  const records = payload.catalog.articles.map((article) => buildRecord(article));
  const hash = hashRecords(records);
  const indexTable = indexTableNumbers(payload.catalog.articles);
  const targetIds = payload.targetScaleIds;
  const targets = payloadScales.filter((scale) => !targetIds || targetIds.includes(scale.id));

  const pushed = [];
  const skipped = [];
  const retrying = [];
  let failed = false;

  for (const scale of targets) {
    // A forced push ignores the cache: every target must receive hello so the
    // scale adopts the PC clock, even when its catalogue content is unchanged.
    if (!force && state.scaleHashes?.[scale.id] === hash) {
      skipped.push(scale.id);
      // The scale already holds this catalogue, so a retry entry is stale.
      delete retriesByScale[scale.id];
      log(`scale ${scale.name} (${scale.host}): content unchanged, skipped`);
      continue;
    }

    // A scale that failed recently waits for its next attempt instead of being
    // retried on every poll. `force` is the documented way to retry right now.
    const retry = retriesByScale[scale.id];
    const nextAttemptMs = retry ? Date.parse(retry.nextAttemptAt) : NaN;
    if (!force && Number.isFinite(nextAttemptMs) && nextAttemptMs > cycleNow) {
      const remaining = Math.max(1, Math.ceil((nextAttemptMs - cycleNow) / 1000));
      failed = true;
      retrying.push({
        scaleId: scale.id,
        name: retry.name ?? scale.name,
        nextAttemptAt: retry.nextAttemptAt,
        failures: retry.failures,
        lastError: retry.lastError,
      });
      log(`scale ${scale.name} (${scale.host}:${scale.port}): retry in ${remaining}s after ${retry.failures} failure(s) — ${retry.lastError}`);
      continue;
    }

    let result;
    try {
      result = await push({ host: scale.host, port: scale.port, records, indexTable, timeoutMs, retries });
    } catch (err) {
      failed = true;
      const failures = (retry?.failures ?? 0) + 1;
      const delaySeconds = backoffDelaySeconds(failures, backoffBaseSeconds, backoffMaxSeconds);
      retriesByScale[scale.id] = {
        name: scale.name,
        failures,
        nextAttemptAt: new Date(now() + delaySeconds * 1000).toISOString(),
        lastError: err.message,
      };
      log(`scale ${scale.name} (${scale.host}:${scale.port}): FAILED — ${err.message}`);
      // The history only gets a row on the first failure, when the error text
      // changes and every tenth attempt: identical rows every poll told the
      // operator nothing.
      if (shouldReportFailure(retry, failures, err.message)) {
        await report({
          config,
          fetchImpl,
          body: {
            scaleId: scale.id,
            revision: payload.revision,
            deploymentId: payload.deploymentId,
            ok: false,
            error: `${err.message} (retry in ${delaySeconds}s, attempt ${failures})`,
          },
        }).catch(() => {});
      }
      continue;
    }

    // The scale already received the catalogue, so record the delivery before
    // reporting it: a failed report must not park a scale that is up to date.
    pushed.push({ scaleId: scale.id, name: scale.name, result });
    delete retriesByScale[scale.id];
    state.scaleHashes = { ...(state.scaleHashes ?? {}), [scale.id]: hash };
    log(`scale ${scale.name} (${scale.host}:${scale.port}): ${result.records} records in ${result.durationMs} ms`);
    await report({ config, fetchImpl, body: { scaleId: scale.id, revision: payload.revision, deploymentId: payload.deploymentId, ok: true, records: result.records, frames: result.framesSent, durationMs: result.durationMs } }).catch((reportError) => {
      log(`scale ${scale.name}: catalogue delivered but the report failed — ${reportError.message}`);
    });
  }

  config.state = {
    ...state,
    revision: failed ? (state.revision ?? 0) : payload.revision,
    lastSyncAt: new Date(cycleNow).toISOString(),
    scaleRetries: retriesByScale,
  };
  if (payload.sede?.pollIntervalSeconds && config.allowLocalOverride !== true) {
    config.pollIntervalSeconds = payload.sede.pollIntervalSeconds;
  }
  persist(config);

  return { changed: true, revision: config.state.revision, pushed, skipped, failed, retrying };
}

async function report({ config, fetchImpl, body }) {
  const response = await fetchImpl(`${config.apiUrl}/agent/report`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`report failed: HTTP ${response.status}`);
}

/** Positive finite seconds from the config, or the fallback. */
function positiveSeconds(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 60 s, 120 s, 240 s... capped so a dead scale still gets one attempt every 15 min. */
function backoffDelaySeconds(failures, baseSeconds, maxSeconds) {
  return Math.min(baseSeconds * 2 ** (failures - 1), maxSeconds);
}

/** Only the first failure, a changed error and every tenth attempt reach the API. */
function shouldReportFailure(previous, failures, message) {
  if (failures === 1) return true;
  if (previous?.lastError !== message) return true;
  return failures % 10 === 0;
}

/** Retry entries that are still waiting, in the shape the CLI reports. */
function pendingRetries(retriesByScale, nowMs) {
  return Object.entries(retriesByScale)
    .filter(([, retry]) => {
      const nextAttemptMs = Date.parse(retry.nextAttemptAt);
      return Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs;
    })
    .map(([scaleId, retry]) => ({
      scaleId: Number(scaleId),
      name: retry.name ?? `scale ${scaleId}`,
      nextAttemptAt: retry.nextAttemptAt,
      failures: retry.failures,
      lastError: retry.lastError,
    }));
}
