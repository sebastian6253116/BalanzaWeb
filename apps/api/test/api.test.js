import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureFirstUser } from '../src/bootstrap.js';
import { parseTxpText } from '../../../packages/plu-format/src/index.js';

let server;
let base;
let db;
let adminToken;

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin12345';

before(async () => {
  db = openDatabase(':memory:');
  ensureFirstUser(db, { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  server = createServer(createApp({ db }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

async function login(username, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login failed: ${body.error}`);
  return body.token;
}

const api = (path, { token = adminToken, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const articles = [
  { name: 'LOMO DE AGUJA', lfCode: 1, pluNumber: 1, barcode: 11001, priceCents: 1450, unitCode: 4, department: 21, validityDays: 365, packageType: 0 },
  { name: 'LOMITO', lfCode: 2, pluNumber: 2, barcode: 11002, priceCents: 1599, unitCode: 4, department: 21, validityDays: 364, packageType: 0 },
];

test('the API refuses anonymous access', async () => {
  const res = await fetch(`${base}/api/sedes`);
  assert.equal(res.status, 401);
});

test('wrong credentials are rejected', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
});

test('login returns the user with roles and permissions', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.token);
  assert.deepEqual(body.user.roles.map((r) => r.key), ['admin']);
  assert.ok(body.user.permissions.includes('users.manage'));
  assert.ok(body.user.permissions.includes('deployments.create'));
});

test('full flow: sede, scale, pairing, enrol, upload, deploy, sync, report', async () => {
  const sede = await (await api('/api/sedes', { method: 'POST', body: { name: 'Sede Centro', pollIntervalSeconds: 30 } })).json();
  assert.ok(sede.id);

  const scale = await (await api(`/api/sedes/${sede.id}/scales`, { method: 'POST', body: { name: 'Caja 1', host: '192.168.0.201', port: 5001 } })).json();
  assert.equal(scale.port, 5001);

  const upload = await api('/api/articles', { method: 'PUT', body: { articles } });
  assert.equal(upload.status, 200);

  const pairing = await (await api(`/api/sedes/${sede.id}/pairing-code`, { method: 'POST' })).json();
  assert.match(pairing.code, /^[A-Z2-9]{8}$/);

  const enroll = await fetch(`${base}/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code, machineId: 'pc-caja1' }),
  });
  const enrolled = await enroll.json();
  assert.equal(enroll.status, 201);
  const agentHeaders = { authorization: `Bearer ${enrolled.token}` };

  const deploy = await (await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} })).json();
  assert.equal(deploy.revision, 2);
  assert.equal(deploy.articleCount, 2);

  const sync = await fetch(`${base}/agent/sync?revision=1`, { headers: agentHeaders });
  const syncBody = await sync.json();
  assert.equal(syncBody.revision, 2);
  assert.equal(syncBody.catalog.articles.length, 2);
  assert.equal(syncBody.scales[0].host, '192.168.0.201');

  const unchanged = await fetch(`${base}/agent/sync?revision=2`, { headers: agentHeaders });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.text()).length, 0);

  const report = await fetch(`${base}/agent/report`, {
    method: 'POST',
    headers: { ...agentHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ scaleId: scale.id, revision: 2, ok: true, records: 2, frames: 9, durationMs: 120 }),
  });
  assert.equal(report.status, 201);

  const status = await (await api(`/api/sedes/${sede.id}/status`)).json();
  assert.equal(status.scales[0].last_result, 'ok');
  assert.equal(status.results.length, 1);
});

test('a viewer can read but cannot write', async () => {
  const created = await api('/api/users', {
    method: 'POST',
    body: { username: 'consulta', name: 'Consulta', password: 'viewer12345', roles: ['viewer'] },
  });
  assert.equal(created.status, 201);

  const viewerToken = await login('consulta', 'viewer12345');

  const read = await api('/api/articles', { token: viewerToken });
  assert.equal(read.status, 200);

  const write = await api('/api/articles', { token: viewerToken, method: 'PUT', body: { articles } });
  assert.equal(write.status, 403);

  const users = await api('/api/users', { token: viewerToken });
  assert.equal(users.status, 403);
});

test('role permissions are editable and take effect immediately', async () => {
  const roles = await (await api('/api/roles')).json();
  const viewer = roles.roles.find((role) => role.key === 'viewer');
  assert.deepEqual(viewer.permissions.sort(), ['articles.read', 'scales.read', 'sedes.read', 'status.read']);
  assert.equal(roles.permissions.length, 10);

  const updated = await api('/api/roles/viewer/permissions', {
    method: 'PUT',
    body: { permissions: ['articles.read', 'articles.write'] },
  });
  assert.equal(updated.status, 200);

  const viewerToken = await login('consulta', 'viewer12345');
  const write = await api('/api/articles', { token: viewerToken, method: 'PUT', body: { articles } });
  assert.equal(write.status, 200, 'the permission change must apply without a new login');

  await api('/api/roles/viewer/permissions', {
    method: 'PUT',
    body: { permissions: ['articles.read', 'scales.read', 'sedes.read', 'status.read'] },
  });
});

test('unknown permissions are rejected', async () => {
  const res = await api('/api/roles/viewer/permissions', { method: 'PUT', body: { permissions: ['galaxy.destroy'] } });
  assert.equal(res.status, 422);
});

test('password changes invalidate open sessions', async () => {
  const users = await (await api('/api/users')).json();
  const viewer = users.users.find((user) => user.username === 'consulta');
  const token = await login('consulta', 'viewer12345');

  const change = await api(`/api/users/${viewer.id}/password`, { method: 'PUT', body: { password: 'nuevaClave123' } });
  assert.equal(change.status, 200);

  const after = await api('/api/articles', { token });
  assert.equal(after.status, 401);
});

test('logout invalidates the session', async () => {
  const token = await login(ADMIN_USERNAME, ADMIN_PASSWORD);
  const before = await api('/api/sedes', { token });
  assert.equal(before.status, 200);
  await api('/api/auth/logout', { token, method: 'POST' });
  const after = await api('/api/sedes', { token });
  assert.equal(after.status, 401);
});

test('the catalogue is validated before it can reach a scale', async () => {
  const bad = [articles[0], { ...articles[1], barcode: articles[0].barcode }];
  const res = await api('/api/articles', { method: 'PUT', body: { articles: bad } });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.validation.errors[0].message, /duplicate barcode/);
});

test('suggest proposes the next free barcode and LF code', async () => {
  const res = await api('/api/articles/suggest');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.barcode > 12904, 'must stay above the codes already assigned');
  assert.ok(body.lfCode > 0);
});

test('a new article is created, validated, edited and deleted', async () => {
  const created = await api('/api/articles', {
    method: 'POST',
    body: { name: 'PRODUCTO NUEVO', barcode: 13001, lfCode: 900, priceCents: 250, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.article.name, 'PRODUCTO NUEVO');
  assert.equal(createdBody.pendingSedes, 1, 'the sede must be flagged as pending');

  const duplicate = await api('/api/articles', {
    method: 'POST',
    body: { name: 'OTRO', barcode: 13001, lfCode: 901, priceCents: 100, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
  });
  assert.equal(duplicate.status, 409);

  const patched = await api(`/api/articles/${createdBody.article.id}`, {
    method: 'PATCH',
    body: { priceCents: 999 },
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).article.price_cents, 999);

  const clash = await api(`/api/articles/${createdBody.article.id}`, { method: 'PATCH', body: { barcode: 11001 } });
  assert.equal(clash.status, 409);

  const removed = await api(`/api/articles/${createdBody.article.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const catalog = await (await api('/api/catalog')).json();
  assert.equal(catalog.articles.some((a) => a.barcode === 13001), false);
});

test('an article created from the web reaches the scale payload on publish', async () => {
  const sedes = await (await api('/api/sedes')).json();
  const sede = sedes.sedes[0];

  const created = await api('/api/articles', {
    method: 'POST',
    body: { name: 'PRODUCTO NUEVO', barcode: 13001, lfCode: 900, priceCents: 250, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
  });
  assert.equal(created.status, 201);
  const article = (await created.json()).article;

  const pending = await (await api('/api/sedes')).json();
  assert.equal(pending.sedes.find((s) => s.id === sede.id).pendingChanges, true);

  const pairing = await (await api(`/api/sedes/${sede.id}/pairing-code`, { method: 'POST' })).json();
  const enroll = await fetch(`${base}/agent/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  });
  const enrolled = await enroll.json();

  const deploy = await (await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} })).json();
  assert.equal(deploy.status, undefined);
  assert.equal(deploy.articleCount, 3);

  const sync = await fetch(`${base}/agent/sync?revision=0`, { headers: { authorization: `Bearer ${enrolled.token}` } });
  const payload = await sync.json();
  const pushed = payload.catalog.articles.find((a) => a.barcode === 13001);
  assert.ok(pushed, 'the new article must be in the payload the agent builds records from');
  assert.equal(pushed.name, 'PRODUCTO NUEVO');
  assert.equal(pushed.unitCode, 4);
  assert.equal(pushed.priceCents, 250);

  await api(`/api/articles/${article.id}`, { method: 'DELETE' });
});

test('the article master exports as a .Txp with the published catalogue', async () => {
  db.run(
    `INSERT INTO articles (barcode, name, lf_code, plu_number, price_cents, unit_code, department,
       validity_days, package_type, barcode_type, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    19001, 'INACTIVO', 950, 0, 100, 4, 21, 30, 0, 7, new Date().toISOString(),
  );

  try {
    const guide = await (await api('/api/articles')).json();

    const anonymous = await fetch(`${base}/api/articles/export`);
    assert.equal(anonymous.status, 401);

    const res = await api('/api/articles/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    assert.match(res.headers.get('content-disposition'), /maestro-balanza-\d{8}\.txp/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const body = await res.text();
    assert.equal(body.startsWith('\uFEFF'), false, 'the export must not include a BOM');
    const rows = parseTxpText(body);
    assert.equal(rows.length, guide.articles.length);
    assert.equal(rows[0].barcode, guide.articles[0].barcode);
    assert.equal(rows.some((row) => row.barcode === 19001), false, 'inactive articles must not leak');
    assert.ok(rows.every((row) => row.raw.length === 26));
  } finally {
    db.run('DELETE FROM articles WHERE barcode = ?', 19001);
  }
});

test('exporting the master requires articles.read', async () => {
  const roleRes = await api('/api/roles', {
    method: 'POST',
    body: { name: 'Solo sedes', permissions: ['sedes.read'] },
  });
  assert.equal(roleRes.status, 201);
  const role = await roleRes.json();

  const userRes = await api('/api/users', {
    method: 'POST',
    body: {
      username: 'solo-sedes',
      name: 'Solo Sedes',
      password: 'solo-sedes-123',
      roles: [role.key],
    },
  });
  assert.equal(userRes.status, 201);

  const token = await login('solo-sedes', 'solo-sedes-123');
  const res = await api('/api/articles/export', { token });
  assert.equal(res.status, 403);
});

