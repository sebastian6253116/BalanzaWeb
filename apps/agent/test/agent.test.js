import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syncOnce, hashRecords } from '../src/sync.js';
import { buildRecord } from '../../../packages/plu-format/src/index.js';

const articles = [
  { name: 'LOMO DE AGUJA', lfCode: 1, pluNumber: 1, barcode: 11001, priceCents: 1450, unitCode: 4, department: 21, validityDays: 365, packageType: 0, barcodeType: 7 },
  { name: 'LOMITO', lfCode: 2, pluNumber: 2, barcode: 11002, priceCents: 1599, unitCode: 4, department: 21, validityDays: 364, packageType: 0, barcodeType: 7 },
];

const scales = [{ id: 10, name: 'Caja 1', host: '192.168.0.201', port: 5001 }];

function makeConfig() {
  return { apiUrl: 'http://api.test', token: 'agent-token', pollIntervalSeconds: 60, state: { revision: 0, scaleHashes: {} } };
}

function fakeFetch({ status = 200, payload = null } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.includes('/agent/report')) return new Response(JSON.stringify({ recorded: true }), { status: 201 });
    if (status === 304) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

const payload = (revision, list = articles) => ({
  sede: { id: 1, name: 'Sede Centro', revision, pollIntervalSeconds: 45 },
  revision,
  deploymentId: revision * 10,
  catalog: { hash: 'abc', articles: list },
  targetScaleIds: null,
  scales,
});

const pushOk = async ({ records }) => ({ records: records.length, framesSent: 9, durationMs: 12 });

test('a new revision is pushed and acknowledged', async () => {
  const config = makeConfig();
  const fetchImpl = fakeFetch({ payload: payload(2) });
  let persisted = null;

  const result = await syncOnce({ config, fetchImpl, push: pushOk, persist: (c) => { persisted = c; } });

  assert.equal(result.changed, true);
  assert.equal(result.pushed.length, 1);
  assert.equal(result.failed, false);
  assert.equal(config.state.revision, 2);
  assert.equal(persisted.state.revision, 2);

  const reportCall = fetchImpl.calls.find((c) => c.url.endsWith('/agent/report'));
  const reportBody = JSON.parse(reportCall.body);
  assert.equal(reportBody.ok, true);
  assert.equal(reportBody.records, 2);
  assert.equal(reportBody.durationMs, 12);
});

test('a 304 does nothing at all', async () => {
  const config = makeConfig();
  config.state.revision = 5;
  const fetchImpl = fakeFetch({ status: 304 });
  let pushed = 0;

  const result = await syncOnce({ config, fetchImpl, push: async () => { pushed++; }, persist: () => {} });

  assert.equal(result.changed, false);
  assert.equal(pushed, 0);
  assert.equal(fetchImpl.calls.length, 1, 'only the sync request must go out');
  assert.equal(config.state.revision, 5);
});

test('a scale whose content did not change is skipped', async () => {
  const config = makeConfig();
  const records = articles.map((a) => buildRecord(a));
  config.state.scaleHashes[10] = hashRecords(records);
  const fetchImpl = fakeFetch({ payload: payload(2) });
  let pushed = 0;

  const result = await syncOnce({ config, fetchImpl, push: async () => { pushed++; }, persist: () => {} });

  assert.equal(pushed, 0);
  assert.deepEqual(result.skipped, [10]);
  assert.equal(config.state.revision, 2);
});

test('a failed push keeps the revision so it retries next poll', async () => {
  const config = makeConfig();
  const fetchImpl = fakeFetch({ payload: payload(3) });

  const result = await syncOnce({
    config,
    fetchImpl,
    push: async () => { throw new Error('no acknowledgement after 3 attempt(s)'); },
    persist: () => {},
  });

  assert.equal(result.failed, true);
  assert.equal(config.state.revision, 0, 'revision must not advance when a scale failed');
  assert.equal(config.state.scaleHashes[10], undefined);

  const reportCall = fetchImpl.calls.find((c) => c.url.endsWith('/agent/report'));
  assert.equal(JSON.parse(reportCall.body).ok, false);
});

test('only the scales targeted by the deployment are pushed', async () => {
  const config = makeConfig();
  const twoScales = [...scales, { id: 11, name: 'Caja 2', host: '192.168.0.202', port: 5001 }];
  const fetchImpl = fakeFetch({ payload: { ...payload(4), scales: twoScales, targetScaleIds: [11] } });
  const pushed = [];

  await syncOnce({ config, fetchImpl, push: async ({ host }) => { pushed.push(host); return { records: 2, framesSent: 9, durationMs: 5 }; }, persist: () => {} });

  assert.deepEqual(pushed, ['192.168.0.202']);
});

test('the remote poll interval applies unless a local override is set', async () => {
  const config = makeConfig();
  const fetchImpl = fakeFetch({ payload: payload(2) });
  await syncOnce({ config, fetchImpl, push: pushOk, persist: () => {} });
  assert.equal(config.pollIntervalSeconds, 45);

  const override = makeConfig();
  override.allowLocalOverride = true;
  override.pollIntervalSeconds = 300;
  await syncOnce({ config: override, fetchImpl: fakeFetch({ payload: payload(2) }), push: pushOk, persist: () => {} });
  assert.equal(override.pollIntervalSeconds, 300);
});
