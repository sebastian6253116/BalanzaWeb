import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';

import { syncOnce, hashRecords } from '../src/sync.js';
import { buildRecord } from '../../../packages/plu-format/src/index.js';

const agentScript = fileURLToPath(new URL('../src/index.js', import.meta.url));
const agentVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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

test('force pushes every target scale even when the cached hash matches', async () => {
  const config = makeConfig();
  config.state.revision = 7;
  const records = articles.map((a) => buildRecord(a));
  config.state.scaleHashes[10] = hashRecords(records);
  const fetchImpl = fakeFetch({ payload: payload(8) });
  const pushedHosts = [];

  const result = await syncOnce({
    config,
    fetchImpl,
    push: async ({ host, records: pushedRecords }) => {
      pushedHosts.push(host);
      return { records: pushedRecords.length, framesSent: 9, durationMs: 4 };
    },
    persist: () => {},
    force: true,
  });

  assert.deepEqual(pushedHosts, ['192.168.0.201'], 'the cached hash must not skip the scale');
  assert.deepEqual(result.skipped, []);
  assert.equal(result.pushed.length, 1);
  assert.equal(result.failed, false);
  assert.match(fetchImpl.calls[0].url, /revision=0$/, 'a forced push requests revision 0');
  assert.equal(config.state.revision, 8, 'the revision still advances after a successful push');
});

test('force false still skips scales whose cached hash matches', async () => {
  const config = makeConfig();
  const records = articles.map((a) => buildRecord(a));
  config.state.scaleHashes[10] = hashRecords(records);
  const fetchImpl = fakeFetch({ payload: payload(2) });
  let pushed = 0;

  const result = await syncOnce({
    config,
    fetchImpl,
    push: async () => { pushed++; },
    persist: () => {},
    force: false,
  });

  assert.equal(pushed, 0);
  assert.deepEqual(result.skipped, [10]);
  assert.match(fetchImpl.calls[0].url, /revision=0$/);
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

async function startFakeScale({ ackAll = false } = {}) {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => {
    const isHello = msg.length > 1 && msg[0] === 0x0e && msg[1] === 0x01;
    if (!isHello && !ackAll) return;
    const reply = isHello
      ? Buffer.concat([Buffer.from([0x0e, 0x01, 0x00]), Buffer.from('RONGTA_PV2.0\0', 'latin1')])
      : Buffer.alloc(0);
    socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return {
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

async function unusedPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function tempAgentHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env = { ...process.env, BALANZA_AGENT_HOME: home };
  delete env.BALANZA_AGENT_CONFIG;
  delete env.BALANZA_AGENT_LOG_DIR;
  return { home, env };
}

function runAgent(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [agentScript, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('probe reports the scale model when the hello is acknowledged', async () => {
  const { home, env } = tempAgentHome('balanza-probe-ok-');
  const scale = await startFakeScale();

  try {
    const run = await runAgent(['probe', '--host', '127.0.0.1', '--port', String(scale.port)], env);
    assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
    assert.match(run.stdout, /RONGTA_PV2\.0/);
    assert.match(run.stdout, new RegExp(`hello reply from 127\\.0\\.0\\.1:${scale.port}`));
  } finally {
    await scale.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('probe fails with a hint when nothing answers the hello', async () => {
  const { home, env } = tempAgentHome('balanza-probe-down-');
  const port = await unusedPort();

  try {
    const run = await runAgent(
      ['probe', '--host', '127.0.0.1', '--port', String(port), '--timeout', '100', '--retries', '1'],
      env,
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /no acknowledgement/);
    assert.match(run.stderr, /hint: the scale did not answer the hello frame/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('probe --full prints every step and confirms the session opened', async () => {
  const { home, env } = tempAgentHome('balanza-probe-full-ok-');
  const scale = await startFakeScale({ ackAll: true });

  try {
    const run = await runAgent(
      ['probe', '--host', '127.0.0.1', '--port', String(scale.port), '--timeout', '300', '--full'],
      env,
    );
    assert.equal(run.status, 0, `probe --full failed: ${run.stderr}`);
    assert.match(run.stdout, /hello: \d+ ms/);
    assert.match(run.stdout, /start: \d+ ms/);
    assert.match(run.stdout, /goodbye: \d+ ms/);
    assert.match(run.stdout, /session opened on 127\.0\.0\.1/);
  } finally {
    await scale.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('probe --full fails at start with its own hint after printing hello', async () => {
  const { home, env } = tempAgentHome('balanza-probe-full-start-');
  // This responder answers hello only, exactly like the DR PORTILLO scale.
  const scale = await startFakeScale();

  try {
    const run = await runAgent(
      ['probe', '--host', '127.0.0.1', '--port', String(scale.port), '--timeout', '100', '--retries', '1', '--full'],
      env,
    );
    assert.equal(run.status, 1);
    assert.match(run.stdout, /hello: \d+ ms/);
    assert.doesNotMatch(run.stdout, /start: \d+ ms/);
    assert.match(run.stderr, /start: no acknowledgement/);
    assert.match(run.stderr, /answered hello but refused to start/);
  } finally {
    await scale.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('probe without a host fails with a clear message', () => {
  const { home, env } = tempAgentHome('balanza-probe-nohost-');

  try {
    const run = spawnSync(process.execPath, [agentScript, 'probe'], { env, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /probe requires --host/);
    assert.doesNotMatch(run.stderr, /hint:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('version prints the package version and the usage line lists it', () => {
  const home = mkdtempSync(join(tmpdir(), 'balanza-version-'));
  const env = { ...process.env, BALANZA_AGENT_HOME: home };
  delete env.BALANZA_AGENT_CONFIG;
  delete env.BALANZA_AGENT_LOG_DIR;

  try {
    const version = spawnSync(process.execPath, [agentScript, 'version'], { env, encoding: 'utf8' });
    assert.equal(version.status, 0, `version failed: ${version.stderr}`);
    assert.equal(version.stdout.trim(), `balanza-agent ${agentVersion}`);

    for (const args of [[], ['not-a-command']]) {
      const usage = spawnSync(process.execPath, [agentScript, ...args], { env, encoding: 'utf8' });
      assert.equal(usage.status, 2);
      assert.match(usage.stdout, /version/, 'the usage line must list the version command');
      assert.match(usage.stdout, /once \[--force\]/, 'the usage line must expose once --force');
      assert.match(usage.stdout, /\[--full\]/, 'the usage line must expose probe --full');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
