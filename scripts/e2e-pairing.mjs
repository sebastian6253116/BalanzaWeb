#!/usr/bin/env node
/**
 * End-to-end pairing test: web-generated code -> agent enrolment -> push -> feedback.
 *
 * Exercises the exact production path with the packaged agent binary:
 *   1. copies the development database into a throwaway one;
 *   2. starts the API and a fake RLS1000 that acknowledges like the real device;
 *   3. logs in as an administrator and generates a pairing code (the web button);
 *   4. enrols `balanza-agent.exe` with that code;
 *   5. runs one sync cycle and checks the push and the report that comes back;
 *   6. runs a second cycle and checks that nothing is sent (304);
 *   7. adds an unreachable scale and checks that the revision does NOT advance.
 *
 * Usage:
 *   node scripts/e2e-pairing.mjs [--keep] [--api-port 8080] [--udp-port 15001]
 *                                [--db data/e2e.db] [--source data/dev.db]
 *
 * Requires `npm run agent:build` first. The fake scale is a UDP listener, so this
 * test never touches real hardware; the hardware check is a separate step.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import dgram from 'node:dgram';
import { openDatabase } from '../apps/api/src/db.js';

const repoRoot = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const keep = args.includes('--keep');
const apiPort = Number(flag('api-port', 8080));
const udpPort = Number(flag('udp-port', 15001));
const dbPath = resolve(repoRoot, flag('db', 'data/e2e.db'));
const sourcePath = resolve(repoRoot, flag('source', 'data/dev.db'));
const adminUser = flag('user', 'admin');
const adminPassword = flag('password', 'admin123');
const agentExe = join(repoRoot, 'apps/agent/dist/balanza-agent.exe');

const baseUrl = `http://127.0.0.1:${apiPort}`;
const MODEL_REPLY = Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from('RONGTA_PV2.0\0', 'latin1')]);

let failures = 0;
function step(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`);
}

const children = [];
function track(child) {
  children.push(child);
  return child;
}

function runAgent(agentHome, agentArgs) {
  return new Promise((resolvePromise) => {
    const child = track(
      spawn(agentExe, agentArgs, {
        env: { ...process.env, BALANZA_AGENT_HOME: agentHome, BALANZA_AGENT_ECHO: '1' },
        windowsHide: true,
      }),
    );
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.stderr.on('data', (chunk) => (out += chunk.toString()));
    child.on('close', (code) => resolvePromise({ code, out }));
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise) => child.on('close', resolvePromise));
}

async function waitForApi(deadlineMs = 15000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'probe', password: 'probe' }),
      });
      if (response.status === 401 || response.status === 400) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let token = null;
async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function readAgentConfig(agentHome) {
  const path = join(agentHome, 'config', 'agent.config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

const agentHome = mkdtempSync(join(tmpdir(), 'balanza-e2e-'));
let udp = null;
let udpFrames = 0;
let apiChild = null;

try {
  if (!existsSync(agentExe)) {
    throw new Error(`missing ${agentExe}; run "npm run agent:build" first`);
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`missing source database ${sourcePath}`);
  }

  // --- 1. throwaway database ---------------------------------------------
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  const source = openDatabase(sourcePath);
  source.exec(`VACUUM INTO '${dbPath.replace(/\\/g, '/')}'`);
  source.close();
  step('database copied', existsSync(dbPath), dbPath);

  const seed = openDatabase(dbPath);
  const sede = seed.get('SELECT * FROM sedes ORDER BY id LIMIT 1');
  if (!sede) throw new Error('the source database has no sede to pair');
  const articleCount = seed.get('SELECT COUNT(*) AS c FROM articles').c;
  // Real scales are disabled so the test never depends on hardware being plugged in.
  seed.run('UPDATE scales SET enabled = 0');
  seed.run('INSERT INTO scales (sede_id, name, host, port, enabled) VALUES (?, ?, ?, ?, 1)', sede.id, 'Simulada', '127.0.0.1', udpPort);
  seed.close();
  step('fake scale registered', true, `sede "${sede.name}" (${articleCount} articles)`);

  // --- 2. fake RLS1000 ---------------------------------------------------
  udp = dgram.createSocket('udp4');
  udp.on('message', (message, rinfo) => {
    udpFrames++;
    udp.send(MODEL_REPLY, rinfo.port, rinfo.address);
  });
  await new Promise((resolvePromise, reject) => {
    udp.once('error', reject);
    udp.bind(udpPort, '127.0.0.1', resolvePromise);
  });
  step('fake scale listening', true, `udp://127.0.0.1:${udpPort}`);

  // --- 3. API ------------------------------------------------------------
  apiChild = track(
    spawn(process.execPath, ['apps/api/src/index.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(apiPort), DB_PATH: dbPath },
      windowsHide: true,
    }),
  );
  apiChild.stdout.on('data', () => {});
  apiChild.stderr.on('data', (chunk) => process.stderr.write(chunk));
  step('api listening', await waitForApi(), baseUrl);

  // --- 4. login + pairing code (what the web does) -----------------------
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  step('admin login', login.status === 200, `HTTP ${login.status}`);
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  token = login.body.token;

  const pairing = await api(`/api/sedes/${sede.id}/pairing-code`, { method: 'POST' });
  step('pairing code generated', pairing.status === 201, `code ${pairing.body?.code} expires ${pairing.body?.expiresAt}`);
  const code = pairing.body.code;

  // --- 5. enrolment with the packaged binary -----------------------------
  const enroll = await runAgent(agentHome, ['enroll', '--api', baseUrl, '--code', code]);
  step('agent enrolled', enroll.code === 0, enroll.out.trim().split('\n').slice(-2).join(' | '));
  const config = readAgentConfig(agentHome);
  step('token stored locally', Boolean(config?.token) && config.token !== code, `agent ${config?.agentId} for "${config?.sede?.name}"`);

  const reuse = await api('/agent/enroll', { method: 'POST', body: JSON.stringify({ code }) });
  step('pairing code is single-use', reuse.status === 409, `HTTP ${reuse.status} ${reuse.body?.error ?? ''}`);

  // --- 6. first sync: push + report --------------------------------------
  const first = await runAgent(agentHome, ['once']);
  step('first cycle pushed', first.code === 0 && /pushed\s+Simulada:\s+\d+ records/.test(first.out), first.out.trim().split('\n').slice(0, 3).join(' | '));
  const pushedRecords = Number(first.out.match(/pushed\s+Simulada:\s+(\d+) records/)?.[1] ?? 0);
  step('all articles sent', pushedRecords === articleCount, `${pushedRecords}/${articleCount} records`);
  const framesBeforeSecond = udpFrames;
  step('fake scale acknowledged every frame', udpFrames > 0, `${udpFrames} datagrams`);

  const statusAfterPush = await api(`/api/sedes/${sede.id}/status`);
  const results = statusAfterPush.body.results ?? [];
  const agents = statusAfterPush.body.agents ?? [];
  step('feedback reached the web', results.some((r) => r.ok === 1 && r.records === articleCount), `${results.length} result row(s)`);
  step('agent visible as enrolled', agents.length === 1, `agent ${agents[0]?.id} machine ${agents[0]?.machine_id ?? 'n/a'}`);
  const simulated = (statusAfterPush.body.scales ?? []).find((s) => s.name === 'Simulada');
  step('scale marked ok', simulated?.last_result === 'ok', `last_result=${simulated?.last_result}`);
  step('revision advanced', readAgentConfig(agentHome).state.revision === sede.revision, `revision ${readAgentConfig(agentHome).state.revision}`);

  // --- 7. second sync: nothing to do -------------------------------------
  const second = await runAgent(agentHome, ['once']);
  step('second cycle is a no-op', second.code === 0 && /no changes/.test(second.out), second.out.trim());
  step('no frames sent on a 304', udpFrames === framesBeforeSecond, `${udpFrames - framesBeforeSecond} extra datagram(s)`);

  // --- 8. a failing scale must not advance the revision -------------------
  const db = openDatabase(dbPath);
  db.run('INSERT INTO scales (sede_id, name, host, port, enabled) VALUES (?, ?, ?, ?, 1)', sede.id, 'Fuera', '127.0.0.1', 15099);
  db.close();
  const deployment = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: JSON.stringify({}) });
  step('new deployment created', deployment.status === 201, `revision ${deployment.body?.revision}`);

  const failedCycle = await runAgent(agentHome, ['once']);
  step('failure reported by the agent', failedCycle.code === 0 && /some scales failed/.test(failedCycle.out), failedCycle.out.trim().split('\n').slice(-1)[0]);
  const revisionAfterFailure = readAgentConfig(agentHome).state.revision;
  step('revision did not advance', revisionAfterFailure === sede.revision, `still ${revisionAfterFailure}`);
  const statusAfterFailure = await api(`/api/sedes/${sede.id}/status`);
  const failureRow = (statusAfterFailure.body.results ?? []).find((r) => r.ok === 0);
  step('failure reached the web', Boolean(failureRow) && /no acknowledgement/.test(failureRow.error ?? ''), failureRow?.error ?? 'no error row');
  const fuera = (statusAfterFailure.body.scales ?? []).find((s) => s.name === 'Fuera');
  step('failed scale marked as error', (fuera?.last_result ?? '').startsWith('error:'), fuera?.last_result ?? 'n/a');

  // --- 9. recovery: remove the broken scale, the retry succeeds -----------
  const cleanup = openDatabase(dbPath);
  cleanup.run('DELETE FROM scales WHERE name = ?', 'Fuera');
  cleanup.close();
  const retry = await runAgent(agentHome, ['once']);
  // Simulada already holds this catalog, so the retry may legitimately skip it by hash;
  // what matters is that no failure is reported and the revision moves forward.
  step('retry after recovery is clean', retry.code === 0 && !/some scales failed/.test(retry.out), retry.out.trim().split('\n').slice(0, 2).join(' | '));
  step('revision advanced after recovery', readAgentConfig(agentHome).state.revision === deployment.body.revision, `revision ${readAgentConfig(agentHome).state.revision}`);
  const third = await runAgent(agentHome, ['once']);
  step('converged to a no-op', /no changes/.test(third.out), third.out.trim());
} catch (error) {
  step('UNEXPECTED ERROR', false, error.message);
  console.error(error.stack);
} finally {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  if (udp) udp.close();
  await Promise.race([waitForExit(apiChild ?? { on: () => {} }), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
  rmSync(agentHome, { recursive: true, force: true });
  if (!keep) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  } else {
    console.log(`kept: ${dbPath}`);
  }
  console.log('');
  console.log(failures === 0 ? 'RESULT: ALL CHECKS PASSED' : `RESULT: ${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
