import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureFirstUser } from '../src/bootstrap.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin12345';
const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>';

let server;
let base;
let db;
let webDir;
let clock = 1_000_000;

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

function assertSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY)) {
    assert.equal(res.headers.get(name), value, `missing ${name}`);
  }
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
}

const login = (username, password) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

async function listen(app) {
  const instance = createServer(app);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return { instance, url: `http://127.0.0.1:${instance.address().port}` };
}

before(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'balanza-web-'));
  writeFileSync(join(webDir, 'index.html'), INDEX_HTML);
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log("ok");\n');

  db = openDatabase(':memory:');
  ensureFirstUser(db, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  const started = await listen(
    createApp({
      db,
      webDir,
      nowMs: () => clock,
      loginLimit: { max: 3, windowMs: 5 * 60_000 },
    }),
  );
  server = started.instance;
  base = started.url;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(webDir, { recursive: true, force: true });
});

test('GET /healthz is unauthenticated and never touches the database', async () => {
  const { instance, url } = await listen(createApp({ db: null }));
  try {
    const res = await fetch(`${url}/healthz`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptimeSeconds, 'number');
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
});

test('GET / serves the web index', async () => {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(body, /<div id="root">/);
});

test('hashed assets are served with an immutable cache', async () => {
  const res = await fetch(`${base}/assets/app-abc123.js`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(body, /console\.log/);
});

test('an extensionless path falls back to the SPA index', async () => {
  const res = await fetch(`${base}/sedes/1`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(body, /<div id="root">/);
});

test('a missing asset with an extension is a 404, not the index', async () => {
  const res = await fetch(`${base}/assets/does-not-exist.js`);
  const body = await res.text();
  assert.equal(res.status, 404);
  assert.doesNotMatch(body, /<div id="root">/);
});

test('path traversal attempts are rejected', async () => {
  for (const path of ['/../package.json', '/..%2fpackage.json', '/assets/..%5c..%5cpackage.json']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, `${path} must not escape the web root`);
    const body = await res.text();
    assert.doesNotMatch(body, /"name":\s*"balanzaweb"/, `${path} leaked the repo package.json`);
  }
});

test('security headers are present on API, static and 404 responses', async () => {
  const api = await fetch(`${base}/api/auth/me`);
  assert.equal(api.status, 401);
  assertSecurityHeaders(api);

  const asset = await fetch(`${base}/assets/app-abc123.js`);
  assertSecurityHeaders(asset);

  const missing = await fetch(`${base}/api/not-a-route`);
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing);
});

test('login is rate limited per client and username, and resets after the window', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await login(ADMIN_USERNAME, 'wrong-password');
    assert.equal(res.status, 401);
  }

  const blocked = await login(ADMIN_USERNAME, 'wrong-password');
  assert.equal(blocked.status, 429);
  const retryAfter = Number(blocked.headers.get('retry-after'));
  assert.ok(retryAfter > 0, 'retry-after must be a positive number of seconds');
  const blockedBody = await blocked.json();
  assert.match(blockedBody.error, /too many failed login attempts/);

  const blockedEvenWithGoodPassword = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  assert.equal(blockedEvenWithGoodPassword.status, 429);

  clock += 5 * 60_000 + 1_000;
  const afterWindow = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  assert.equal(afterWindow.status, 200);
  const afterBody = await afterWindow.json();
  assert.ok(afterBody.token);

  const me = await fetch(`${base}/api/auth/me`, {
    headers: { authorization: `Bearer ${afterBody.token}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, ADMIN_USERNAME);
});

test('a body over the limit is rejected with 413', async () => {
  const res = await fetch(`${base}/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(5 * 1024 * 1024 + 1024),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /too large/);
});

test('without webDir the app still serves the API and / is a documented 404', async () => {
  const otherDb = openDatabase(':memory:');
  const { instance, url } = await listen(createApp({ db: otherDb }));
  try {
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 404);
    assert.deepEqual(await root.json(), { error: 'no web build configured' });

    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    await new Promise((resolve) => instance.close(resolve));
    otherDb.close();
  }
});
