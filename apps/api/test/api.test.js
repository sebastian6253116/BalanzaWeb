import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureFirstUser } from '../src/bootstrap.js';
import { parseTxpText } from '../../../packages/plu-format/src/index.js';
import { readSheetRows } from '../../../packages/xlsx/src/read.js';

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

let sedeCounter = 0;

/** Create a sede through the API (a new sede is backfilled from the general master). */
async function createSede(label = 'Sede Master') {
  sedeCounter += 1;
  const name = `${label} ${sedeCounter} ${Date.now()}`;
  const res = await api('/api/sedes', { method: 'POST', body: { name } });
  assert.equal(res.status, 201);
  return res.json();
}

/** Read one sede's article master through the scoped endpoint. */
async function getSedeMaster(sedeId) {
  const res = await api(`/api/articles?sedeId=${sedeId}`);
  assert.equal(res.status, 200);
  return res.json();
}

/** Read one sede's summary row from GET /api/sedes. */
async function getSedeSummary(sedeId) {
  const { sedes } = await (await api('/api/sedes')).json();
  const summary = sedes.find((sede) => sede.id === sedeId);
  assert.ok(summary, `sede ${sedeId} must be listed`);
  return summary;
}

/** Let the millisecond clock advance so `updated_at` ordering is unambiguous. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Sync every sede so a general edit made by a test never leaks into the next one. */
async function syncAllSedes() {
  const { sedes } = await (await api('/api/sedes')).json();
  for (const sede of sedes) {
    const res = await api(`/api/sedes/${sede.id}/articles/sync`, {
      method: 'POST',
      body: { expectedOverrides: Number(sede.overrides) || 0 },
    });
    assert.equal(res.status, 200);
  }
}

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
  assert.equal((await patched.json()).article.priceCents, 999);

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

test('the article master also exports as a real .xlsx workbook', async () => {
  const guide = await (await api('/api/articles')).json();

  const res = await api('/api/articles/export?format=xlsx');
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(res.headers.get('content-disposition'), /maestro-balanza-\d{8}\.xlsx/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 2).toString('ascii'), 'PK');
  assert.equal(Number(res.headers.get('content-length')), body.length);
  assert.ok(body.length > 0);
  assert.ok(guide.articles.length > 0);

  const unsupported = await api('/api/articles/export?format=csv');
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error, 'unsupported export format');

  const txp = await api('/api/articles/export?format=txp');
  assert.equal(txp.status, 200);
  assert.match(txp.headers.get('content-type'), /text\/plain/);
  assert.match(txp.headers.get('content-disposition'), /maestro-balanza-\d{8}\.txp/);
  parseTxpText(await txp.text());
});

test('the article master exports a vendor-layout workbook with no header row', async () => {
  const guide = await (await api('/api/articles')).json();
  assert.ok(guide.articles.length > 0);

  const res = await api('/api/articles/export?format=vendor');
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('content-type'),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(res.headers.get('content-disposition'), /maestro-balanza-\d{8}-fabricante\.xlsx/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.subarray(0, 2).toString('ascii'), 'PK');
  assert.equal(Number(res.headers.get('content-length')), body.length);

  const rows = readSheetRows(body);
  assert.equal(rows.length, guide.articles.length, 'one row per active article, no header');
  assert.equal(rows[0].length, 26, 'the vendor layout has 26 columns');
  assert.equal(rows[0][0], String(guide.articles[0].pluNumber), 'row 1 starts with the first PLU');
  assert.notEqual(rows[0][0], 'Teclado', 'the first row must be data, not a header');
  assert.equal(rows[0][5], String(guide.articles[0].priceCents), 'the price stays in cents');
  assert.equal(rows[0][8], '0.000', 'pack weight keeps its text form');
  assert.equal(rows[0][25], '0');

  const xlsx = await api('/api/articles/export?format=xlsx');
  assert.equal(xlsx.status, 200);
  const xlsxRows = readSheetRows(Buffer.from(await xlsx.arrayBuffer()));
  assert.equal(xlsxRows[0][0], 'Teclado', 'the regular spreadsheet still has a header row');
  assert.equal(xlsxRows[1][0], String(guide.articles[0].pluNumber));
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

// ---- per-sede article masters ----

test('creating an article in the general master copies it into every sede master', async () => {
  const sedeA = await createSede();
  const sedeB = await createSede();

  const res = await api('/api/articles', {
    method: 'POST',
    body: {
      name: 'PRODUCTO SEDES', barcode: 14001, lfCode: 1001, priceCents: 500,
      unitCode: 4, department: 21, validityDays: 30, packageType: 0, barcodeType: 7,
    },
  });
  assert.equal(res.status, 201);
  const created = (await res.json()).article;

  for (const sede of [sedeA, sedeB]) {
    const master = await getSedeMaster(sede.id);
    const copy = master.articles.find((article) => article.id === created.id);
    assert.ok(copy, `sede ${sede.name} must hold the new article`);
    for (const key of ['barcode', 'name', 'lfCode', 'pluNumber', 'priceCents', 'unitCode',
      'department', 'validityDays', 'packageType', 'barcodeType']) {
      assert.equal(copy[key], created[key], `${key} must match the general master`);
    }
  }

  await api(`/api/articles/${created.id}`, { method: 'DELETE' });
});

test('editing a price in one sede leaves the general master and the other sede untouched', async () => {
  const sedeA = await createSede();
  const sedeB = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles.find((item) => item.barcode === 11001);
  assert.ok(article);
  const generalPrice = article.priceCents;

  const res = await api(`/api/articles/${article.id}?sedeId=${sedeA.id}`, {
    method: 'PATCH',
    body: { priceCents: generalPrice + 100 },
  });
  assert.equal(res.status, 200);
  const patched = (await res.json()).article;
  assert.equal(patched.priceCents, generalPrice + 100);
  assert.equal(patched.generalPriceCents, generalPrice);

  const masterA = await getSedeMaster(sedeA.id);
  const inA = masterA.articles.find((item) => item.id === article.id);
  assert.equal(inA.priceCents, generalPrice + 100, 'the edited sede keeps its own price');
  assert.equal(inA.generalPriceCents, generalPrice, 'the diff points at the general price');

  const masterB = await getSedeMaster(sedeB.id);
  const inB = masterB.articles.find((item) => item.id === article.id);
  assert.equal(inB.priceCents, generalPrice, 'the other sede is untouched');
  assert.equal(inB.generalPriceCents, generalPrice);

  const afterGeneral = await (await api('/api/articles')).json();
  assert.equal(afterGeneral.articles.find((item) => item.id === article.id).priceCents, generalPrice);
});

test('editing the general price leaves every sede master untouched', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles.find((item) => item.barcode === 11002);
  assert.ok(article);
  const generalPrice = article.priceCents;

  const before = await getSedeMaster(sede.id);
  assert.equal(before.articles.find((item) => item.id === article.id).priceCents, generalPrice);

  const res = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: generalPrice + 250 },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).article.priceCents, generalPrice + 250);

  const after = await getSedeMaster(sede.id);
  const inSede = after.articles.find((item) => item.id === article.id);
  assert.equal(inSede.priceCents, generalPrice, 'the sede keeps the old price after a general edit');
  assert.equal(inSede.generalPriceCents, generalPrice + 250, 'the diff exposes the general change');

  const restore = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: generalPrice },
  });
  assert.equal(restore.status, 200);
});

test('syncing a sede copies the general values and reports priceChanges', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles.find((item) => item.barcode === 11001);
  assert.ok(article);

  const patched = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 300 },
  });
  assert.equal(patched.status, 200);

  const res = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: 1 },
  });
  assert.equal(res.status, 200);
  const counts = await res.json();
  assert.equal(counts.sedeId, sede.id);
  assert.equal(counts.articles, general.articles.length);
  assert.equal(counts.created, 0);
  assert.equal(counts.removed, 0);
  assert.equal(counts.priceChanges, 1);
  assert.equal(counts.valueChanges, 1, 'the overridden row is the only one differing in some field');
  assert.equal(counts.overrides, 1, 'the count describes the state before the sync');
  assert.ok(counts.pendingSedes >= 1);

  const master = await getSedeMaster(sede.id);
  assert.equal(master.articles.find((item) => item.id === article.id).priceCents, article.priceCents);
});

test('publishing a sede snapshots the sede master, not the general catalogue', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles.find((item) => item.barcode === 11001);
  assert.ok(article);
  const sedePrice = article.priceCents + 700;

  const patched = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: sedePrice },
  });
  assert.equal(patched.status, 200);

  const res = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 201);
  const deployment = await res.json();
  assert.equal(deployment.articleCount, general.articles.length);

  const row = db.get(
    'SELECT catalog_json FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1',
    sede.id,
  );
  const snapshot = JSON.parse(row.catalog_json);
  const published = snapshot.find((item) => item.id === article.id);
  assert.equal(published.priceCents, sedePrice, 'the deployment carries the sede price');
  assert.notEqual(published.priceCents, article.priceCents, 'and not the general one');
});

test('a brand new sede starts with the full general catalogue without an explicit sync', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const master = await getSedeMaster(sede.id);

  assert.equal(master.scope, 'sede');
  assert.deepEqual(
    master.articles.map((item) => item.barcode),
    general.articles.map((item) => item.barcode),
  );
});

test('deleting an article from the general master removes it from every sede master', async () => {
  const sedeA = await createSede();
  const sedeB = await createSede();
  const created = await (await api('/api/articles', {
    method: 'POST',
    body: {
      name: 'TEMPORAL', barcode: 14002, lfCode: 1002, priceCents: 300,
      unitCode: 4, department: 21, validityDays: 10, packageType: 0,
    },
  })).json();

  for (const sede of [sedeA, sedeB]) {
    assert.ok((await getSedeMaster(sede.id)).articles.some((item) => item.id === created.article.id));
  }

  const removed = await api(`/api/articles/${created.article.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);

  for (const sede of [sedeA, sedeB]) {
    assert.equal(
      (await getSedeMaster(sede.id)).articles.some((item) => item.id === created.article.id),
      false,
      'the cascade must reach the sede master',
    );
    const rows = db.get(
      'SELECT COUNT(*) AS n FROM sede_articles WHERE sede_id = ? AND article_id = ?',
      sede.id, created.article.id,
    );
    assert.equal(rows.n, 0);
  }
});

test('a barcode may repeat across sedes but not inside one sede master', async () => {
  const sedeA = await createSede();
  const sedeB = await createSede();
  const general = await (await api('/api/articles')).json();
  const first = general.articles.find((item) => item.barcode === 11001);
  const second = general.articles.find((item) => item.barcode === 11002);
  assert.ok(first && second);

  const moved = await api(`/api/articles/${second.id}?sedeId=${sedeA.id}`, {
    method: 'PATCH',
    body: { barcode: 55555 },
  });
  assert.equal(moved.status, 200);

  const crossSede = await api(`/api/articles/${first.id}?sedeId=${sedeB.id}`, {
    method: 'PATCH',
    body: { barcode: 55555 },
  });
  assert.equal(crossSede.status, 200, 'the same barcode may exist in another sede');

  const clash = await api(`/api/articles/${first.id}?sedeId=${sedeA.id}`, {
    method: 'PATCH',
    body: { barcode: 55555 },
  });
  assert.equal(clash.status, 409, 'a barcode may not repeat inside one master');
});

test('article creation and deletion reject a sede scope', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];

  const created = await api(`/api/articles?sedeId=${sede.id}`, {
    method: 'POST',
    body: {
      name: 'NOPE', barcode: 14003, lfCode: 1003, priceCents: 100,
      unitCode: 4, department: 21, validityDays: 1,
    },
  });
  assert.equal(created.status, 409);
  assert.equal((await created.json()).error, 'articles are created in the general master');

  const removed = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 409);
  assert.equal((await removed.json()).error, 'articles are deleted from the general master');
});

test('creating a general article that collides with a sede override is rejected', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles.find((item) => item.barcode === 11001);
  assert.ok(article);

  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { barcode: 66666 },
  });
  assert.equal(override.status, 200);

  const res = await api('/api/articles', {
    method: 'POST',
    body: {
      name: 'COLISION', barcode: 66666, lfCode: 1004, priceCents: 100,
      unitCode: 4, department: 21, validityDays: 30, packageType: 0,
    },
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, `article conflicts with the master of sede "${sede.name}"`);
  assert.ok(body.details.errors.length > 0, 'the flashing report must travel with the error');

  const after = await (await api('/api/articles')).json();
  assert.equal(after.articles.some((item) => item.barcode === 66666), false, 'nothing may be written');
});

test('bulk import leaves every sede master in sync with the new general rows', async () => {
  const imported = [
    { name: 'BULK UNO', lfCode: 1, pluNumber: 1, barcode: 21001, priceCents: 111, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
    { name: 'BULK DOS', lfCode: 2, pluNumber: 2, barcode: 21002, priceCents: 222, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
    { name: 'BULK TRES', lfCode: 3, pluNumber: 3, barcode: 21003, priceCents: 333, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
  ];

  // Earlier tests leave per-sede overrides behind, so the import needs the live
  // count as consent: it replaces every sede master and would discard them.
  const before = await (await api('/api/sedes')).json();
  const liveOverrides = before.sedes.reduce(
    (total, sede) => total + (Number(sede.overrides) || 0),
    0,
  );
  const res = await api('/api/articles', {
    method: 'PUT',
    body: { articles: imported, expectedOverrides: liveOverrides },
  });
  assert.equal(res.status, 200);

  const general = await (await api('/api/articles')).json();
  assert.deepEqual(general.articles.map((item) => item.barcode), imported.map((item) => item.barcode));

  const { sedes } = await (await api('/api/sedes')).json();
  assert.ok(sedes.length > 0);

  for (const sede of sedes) {
    const master = await getSedeMaster(sede.id);
    assert.deepEqual(
      master.articles.map((item) => [item.barcode, item.priceCents]),
      general.articles.map((item) => [item.barcode, item.priceCents]),
      `sede ${sede.name} must be rebuilt from the imported catalogue`,
    );
  }
});

test('bulk import refuses a stale override count and accepts the live one', async () => {
  // Clear every existing override so the counts below are unambiguous.
  await syncAllSedes();

  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  const sedePrice = article.priceCents + 9;
  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: sedePrice },
  });
  assert.equal(override.status, 200);

  const imported = [
    { name: 'FINAL UNO', lfCode: 1, pluNumber: 1, barcode: 22001, priceCents: 10, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
    { name: 'FINAL DOS', lfCode: 2, pluNumber: 2, barcode: 22002, priceCents: 20, unitCode: 4, department: 21, validityDays: 30, packageType: 0 },
  ];

  // The operator confirmed zero, but the sede now has one row with its own values:
  // the import must refuse instead of trusting the stale confirmation.
  const refused = await api('/api/articles', {
    method: 'PUT',
    body: { articles: imported, expectedOverrides: 0 },
  });
  assert.equal(refused.status, 409);
  const refusal = await refused.json();
  assert.equal(refusal.overrides, 1);
  assert.equal(
    refusal.error,
    'the import would replace 1 per-sede value that differs from the general master; resend with expectedOverrides: 1 (send it as a JSON number)',
  );

  // A refused import must not touch anything.
  const generalAfter = await (await api('/api/articles')).json();
  assert.deepEqual(
    generalAfter.articles.map((item) => item.barcode),
    general.articles.map((item) => item.barcode),
    'the general catalogue stays untouched',
  );
  const masterAfter = await getSedeMaster(sede.id);
  assert.equal(
    masterAfter.articles.find((item) => item.id === article.id).priceCents,
    sedePrice,
    'the per-sede override survives the refused import',
  );

  const accepted = await api('/api/articles', {
    method: 'PUT',
    body: { articles: imported, expectedOverrides: 1 },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).sedeOverridesDiscarded, 1);

  const master = await getSedeMaster(sede.id);
  assert.deepEqual(
    master.articles.map((item) => [item.barcode, item.priceCents]),
    imported.map((item) => [item.barcode, item.priceCents]),
    'the rebuilt master must use the generic values',
  );
});

// ---- general master ahead of the sede masters ----

test('editing the general master flags the sede masters as behind', async () => {
  const sede = await createSede();
  const other = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);
  assert.ok(general.articles.length > 1, 'the count below must be meaningful');

  const before = await getSedeSummary(sede.id);
  assert.equal(before.generalAhead, false);
  assert.equal(before.articlesAhead, 0);

  await tick();
  const res = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 40 },
  });
  assert.equal(res.status, 200);

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.generalAhead, true);
  assert.equal(summary.articlesAhead, 1, 'only the edited article is counted');
  assert.equal(summary.pendingChanges, true);

  const otherSummary = await getSedeSummary(other.id);
  assert.equal(otherSummary.generalAhead, true, 'every sede is behind the general edit');
  assert.equal(otherSummary.articlesAhead, 1);

  await syncAllSedes();
});

test('a per-sede edit does not flag the general master as ahead', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[1];
  assert.ok(article);

  await tick();
  const res = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 15 },
  });
  assert.equal(res.status, 200);

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.generalAhead, false, 'a sede edit is not a general change');
  assert.equal(summary.articlesAhead, 0);
  assert.equal(summary.pendingChanges, true, 'the sede still has an unpublished override');
});

test('deploying while the general master is ahead requires acceptance', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);

  await tick();
  const edited = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { name: `${article.name} AHEAD` },
  });
  assert.equal(edited.status, 200);

  const before = await getSedeSummary(sede.id);
  const deploymentsBefore = db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n;

  const res = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(
    body.error,
    'the general master changed since this sede was last synced; sync it first or publish anyway with acceptGeneralChanges: true',
  );
  assert.equal(body.articlesAhead, 1);

  const after = await getSedeSummary(sede.id);
  assert.equal(after.revision, before.revision, 'a refused deploy must not bump the revision');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n,
    deploymentsBefore,
    'a refused deploy must not create a deployment row',
  );

  await syncAllSedes();
});

test('acceptGeneralChanges deploys the current sede master anyway', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);
  const sedePrice = article.priceCents + 500;

  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: sedePrice },
  });
  assert.equal(override.status, 200);

  await tick();
  const edited = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 900 },
  });
  assert.equal(edited.status, 200);
  assert.equal((await getSedeSummary(sede.id)).generalAhead, true);

  const res = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { acceptGeneralChanges: true },
  });
  assert.equal(res.status, 201);
  const deployment = await res.json();
  assert.equal(deployment.articleCount, general.articles.length);

  const row = db.get(
    'SELECT catalog_json FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1',
    sede.id,
  );
  const published = JSON.parse(row.catalog_json).find((item) => item.id === article.id);
  assert.equal(published.priceCents, sedePrice, 'the snapshot is the sede master, not the general edit');

  await syncAllSedes();
});

test('syncing the sede clears generalAhead and allows a normal deploy', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[1];
  assert.ok(article);

  await tick();
  const edited = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 25 },
  });
  assert.equal(edited.status, 200);
  assert.equal((await getSedeSummary(sede.id)).generalAhead, true);

  // The stale copy differs by value, so the sync echoes the count the operator sees.
  const before = await getSedeSummary(sede.id);
  assert.equal(before.overrides, 1, 'the general edit leaves one differing row');
  const synced = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: before.overrides },
  });
  assert.equal(synced.status, 200);

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.generalAhead, false);
  assert.equal(summary.articlesAhead, 0);

  const res = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 201);

  await syncAllSedes();
});

test('a deployed and synced sede reports no pending changes', async () => {
  const sede = await createSede();

  const res = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 201);

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.pendingChanges, false);
  assert.equal(summary.generalAhead, false);
  assert.equal(summary.articlesAhead, 0);
});

test('a general edit into a value held as a sede override succeeds and the next sync resolves it', async () => {
  const sede = await createSede();
  const create = async (name, barcode, lfCode) => {
    const res = await api('/api/articles', {
      method: 'POST',
      body: {
        name, barcode, lfCode, priceCents: 200, unitCode: 4, department: 21,
        validityDays: 30, packageType: 0,
      },
    });
    assert.equal(res.status, 201);
    return (await res.json()).article;
  };

  const first = await create('OVERRIDE ORIGEN', 23001, 501);
  const second = await create('OVERRIDE DESTINO', 23002, 502);

  // This sede moves its own copy of the first article to barcode 24001 while the
  // general master keeps 23001.
  const override = await api(`/api/articles/${first.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { barcode: 24001 },
  });
  assert.equal(override.status, 200);

  // Another general article may take 24001: the sync that follows overwrites the
  // sede copy, so the override can never stay in the way. Refusing this edit
  // would reject a perfectly valid general change.
  const clash = await api(`/api/articles/${second.id}`, {
    method: 'PATCH',
    body: { barcode: 24001 },
  });
  assert.equal(clash.status, 200);
  assert.equal((await clash.json()).article.barcode, 24001);

  // Both sede rows now differ from the general master by value: the first holds
  // the local barcode and the second still holds the pre-general-edit one.
  const synced = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: 2 },
  });
  assert.equal(synced.status, 200);

  const master = await getSedeMaster(sede.id);
  assert.equal(master.articles.find((item) => item.id === first.id).barcode, 23001);
  assert.equal(master.articles.find((item) => item.id === second.id).barcode, 24001);

  for (const article of [first, second]) {
    const removed = await api(`/api/articles/${article.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  }
});

test('a general edit stays pending after an unrelated sede edit', async () => {
  await syncAllSedes();
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const edited = general.articles[0];
  const other = general.articles[1];
  assert.ok(edited && other);

  await tick();
  const generalEdit = await api(`/api/articles/${edited.id}`, {
    method: 'PATCH',
    body: { priceCents: edited.priceCents + 33 },
  });
  assert.equal(generalEdit.status, 200);

  // The operator edits a completely different article inside the sede.
  await tick();
  const sedeEdit = await api(`/api/articles/${other.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: other.priceCents + 11 },
  });
  assert.equal(sedeEdit.status, 200);

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.generalAhead, true, 'a sede edit must not hide the general change');
  assert.equal(summary.articlesAhead, 1, 'only the article edited in the general master is counted');
  // Overrides are value-based: both rows now differ from the general master, one
  // because of the general edit and one because of the local edit.
  assert.equal(summary.overrides, 2, 'every row that differs by value is reported');

  const res = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(res.status, 409, 'the deploy guard still fires');
  assert.equal((await res.json()).articlesAhead, 1);

  await syncAllSedes();
});

test('syncFromGeneral publishes the general values in one call', async () => {
  await syncAllSedes();
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);
  const sedePrice = article.priceCents + 800;

  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: sedePrice },
  });
  assert.equal(override.status, 200);

  await tick();
  const generalPrice = article.priceCents + 1200;
  const edited = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: generalPrice },
  });
  assert.equal(edited.status, 200);
  assert.equal((await getSedeSummary(sede.id)).generalAhead, true);

  const refused = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { syncFromGeneral: true },
  });
  assert.equal(refused.status, 409, 'a sync that would discard overrides needs explicit consent');
  assert.deepEqual(await refused.json(), {
    error: 'the sede has 1 article that differs from the general master right now; confirm with expectedOverrides: 1 (send it as a JSON number)',
    overrides: 1,
  });
  assert.equal((await getSedeSummary(sede.id)).overrides, 1, 'the refused sync leaves the master untouched');

  const before = await getSedeSummary(sede.id);
  const res = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { syncFromGeneral: true, expectedOverrides: 1 },
  });
  assert.equal(res.status, 201);
  const deployment = await res.json();
  assert.equal(deployment.revision, before.revision + 1, 'the revision advances exactly once');
  assert.equal(deployment.sync.priceChanges, 1);
  assert.equal(deployment.sync.overrides, 1, 'the discarded sede edit is reported');

  const row = db.get(
    'SELECT catalog_json FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1',
    sede.id,
  );
  const published = JSON.parse(row.catalog_json).find((item) => item.id === article.id);
  assert.equal(published.priceCents, generalPrice, 'the snapshot carries the general value, not the sede one');

  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.generalAhead, false);
  assert.equal(summary.overrides, 0);

  await syncAllSedes();
});

test('overlapping deploys get distinct revisions and each response returns its own row', async () => {
  const sede = await createSede();
  const before = await getSedeSummary(sede.id);

  // Both requests read their body before touching the row, so they overlap in
  // the exact window the fix closes: the revision read, the UPDATE and the
  // INSERT must stay in one synchronous block.
  const [first, second] = await Promise.all([
    api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} }),
    api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} }),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const deployments = await Promise.all([first.json(), second.json()]);

  const revisions = deployments.map((deployment) => deployment.revision).sort((a, b) => a - b);
  assert.deepEqual(
    revisions,
    [before.revision + 1, before.revision + 2],
    'each overlapping request advances the revision exactly once',
  );
  assert.notEqual(deployments[0].deploymentId, deployments[1].deploymentId);

  for (const deployment of deployments) {
    const row = db.get(
      'SELECT id, sede_id, revision FROM deployments WHERE id = ?',
      deployment.deploymentId,
    );
    assert.equal(row.sede_id, sede.id);
    assert.equal(row.revision, deployment.revision, 'the response describes the row it created');
  }

  const rows = db.all('SELECT revision FROM deployments WHERE sede_id = ? ORDER BY revision', sede.id);
  assert.deepEqual(
    rows.map((row) => row.revision),
    [before.revision + 1, before.revision + 2],
    'no deployment row reused a revision',
  );
});

test('an empty scaleIds array is stored as null instead of targeting zero scales', async () => {
  const sede = await createSede();

  const res = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { scaleIds: [] },
  });
  assert.equal(res.status, 201);
  const deployment = await res.json();

  const row = db.get('SELECT scale_ids FROM deployments WHERE id = ?', deployment.deploymentId);
  assert.equal(row.scale_ids, null, 'an empty selection is the same as no selection');
});

test('a stale expectedOverrides is refused with the real count and changes nothing', async () => {
  const sede = await createSede();
  await tick();
  const general = await (await api('/api/articles')).json();

  // Two per-sede edits, but the operator will confirm only one of them.
  for (const article of general.articles.slice(0, 2)) {
    const res = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
      method: 'PATCH',
      body: { priceCents: article.priceCents + 100 },
    });
    assert.equal(res.status, 200);
  }

  const before = await getSedeSummary(sede.id);
  assert.equal(before.overrides, 2);
  const deploymentsBefore = db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n;
  const expectedError = 'the sede has 2 articles that differ from the general master right now; confirm with expectedOverrides: 2 (send it as a JSON number)';

  const refused = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { syncFromGeneral: true, expectedOverrides: 1 },
  });
  assert.equal(refused.status, 409, 'a stale count must not authorise the sync');
  assert.deepEqual(await refused.json(), { error: expectedError, overrides: 2 });

  const refusedStandalone = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: 1 },
  });
  assert.equal(refusedStandalone.status, 409, 'the standalone sync applies the same rule');
  assert.deepEqual(await refusedStandalone.json(), { error: expectedError, overrides: 2 });

  const afterRefused = await getSedeSummary(sede.id);
  assert.equal(afterRefused.revision, before.revision, 'a refused sync must not bump the revision');
  assert.equal(afterRefused.overrides, 2, 'a refused sync must not touch the master');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n,
    deploymentsBefore,
    'a refused sync must not create a deployment row',
  );

  const accepted = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { syncFromGeneral: true, expectedOverrides: 2 },
  });
  assert.equal(accepted.status, 201, 'retrying with the real count succeeds');
  const deployment = await accepted.json();
  assert.equal(deployment.revision, before.revision + 1);
  assert.equal(deployment.sync.overrides, 2);
  assert.equal((await getSedeSummary(sede.id)).overrides, 0, 'the accepted sync cleared the overrides');

  await syncAllSedes();
});

test('a boolean expectedOverrides cannot authorise discarding one override', async () => {
  await syncAllSedes();
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];

  // Exactly one row differs, so `Number(true) === 1` used to satisfy the gate.
  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 250 },
  });
  assert.equal(override.status, 200);
  const before = await getSedeSummary(sede.id);
  assert.equal(before.overrides, 1);
  const deploymentsBefore = db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n;

  const refusedSync = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: true },
  });
  assert.equal(refusedSync.status, 409, 'a boolean is not a count');
  assert.deepEqual(await refusedSync.json(), {
    error: 'the sede has 1 article that differs from the general master right now; confirm with expectedOverrides: 1 (send it as a JSON number)',
    overrides: 1,
  });

  const refusedDeploy = await api(`/api/sedes/${sede.id}/deployments`, {
    method: 'POST',
    body: { syncFromGeneral: true, expectedOverrides: true },
  });
  assert.equal(refusedDeploy.status, 409, 'the deploy-with-sync gate applies the same rule');
  assert.deepEqual(await refusedDeploy.json(), {
    error: 'the sede has 1 article that differs from the general master right now; confirm with expectedOverrides: 1 (send it as a JSON number)',
    overrides: 1,
  });

  const after = await getSedeSummary(sede.id);
  assert.equal(after.revision, before.revision, 'a refused deploy must not bump the revision');
  assert.equal(after.overrides, 1, 'a refused sync must leave the override in place');
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n,
    deploymentsBefore,
    'a refused deploy must not create a deployment row',
  );

  await syncAllSedes();
});

test('syncing a sede whose overrides collide with a shifted general barcode succeeds', async () => {
  const sede = await createSede();
  const create = async (name, barcode, lfCode) => {
    const res = await api('/api/articles', {
      method: 'POST',
      body: {
        name, barcode, lfCode, priceCents: 300, unitCode: 4, department: 21,
        validityDays: 30, packageType: 0,
      },
    });
    assert.equal(res.status, 201);
    return (await res.json()).article;
  };

  const first = await create('SHIFT ORIGEN', 25001, 601);
  const second = await create('SHIFT DESTINO', 25002, 702);

  // The sede moves its second copy onto the barcode the general first article is
  // about to take. Because the general first article sorts *before* the second
  // one (lf 601 < 702), a row-by-row sync updates it while the sede copy of the
  // second article still holds that barcode: a transient duplicate and a 500.
  const override = await api(`/api/articles/${second.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { barcode: 25003 },
  });
  assert.equal(override.status, 200);

  const shifted = await api(`/api/articles/${first.id}`, {
    method: 'PATCH',
    body: { barcode: 25003 },
  });
  assert.equal(shifted.status, 200);

  // Two rows differ by value: the local barcode override and the copy whose
  // general article just took the sheltered barcode.
  const synced = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: 2 },
  });
  assert.equal(synced.status, 200);
  const counts = await synced.json();
  assert.equal(counts.overrides, 2);
  assert.ok(counts.valueChanges >= 1);

  const general = await (await api('/api/articles')).json();
  const master = await getSedeMaster(sede.id);
  const expected = general.articles
    .filter((item) => item.id === first.id || item.id === second.id)
    .map((item) => [item.id, item.barcode, item.lfCode])
    .sort((a, b) => a[0] - b[0]);
  const actual = master.articles
    .filter((item) => item.id === first.id || item.id === second.id)
    .map((item) => [item.id, item.barcode, item.lfCode])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(actual, expected, 'the sede master ends up equal to the general master');

  for (const article of [first, second]) {
    const removed = await api(`/api/articles/${article.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
  }
});

test('the sede article list reports differsFromGeneral per row', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const [edited, untouched] = general.articles;
  assert.ok(edited && untouched);

  const patched = await api(`/api/articles/${edited.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { name: `${edited.name} LOCAL` },
  });
  assert.equal(patched.status, 200);

  const master = await getSedeMaster(sede.id);
  assert.equal(master.articles.find((item) => item.id === edited.id).differsFromGeneral, true);
  assert.equal(master.articles.find((item) => item.id === untouched.id).differsFromGeneral, false);

  await syncAllSedes();
});

test('publishing refuses a sede master missing rows', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  assert.ok(general.articles.length >= 2, 'the incomplete count below must be meaningful');

  // Simulate a master missing rows (manual database deletion, or data migrated
  // from before the cascade existed): one general article has no copy in this
  // sede. The general master itself is unchanged, so only the completeness guard
  // can catch it.
  db.run('DELETE FROM sede_articles WHERE sede_id = ? AND article_id = ?', sede.id, general.articles[0].id);

  // The gap must be visible in GET /api/sedes with `generalAhead` still false:
  // that is exactly the case where the sync checkbox used to disappear.
  const summary = await getSedeSummary(sede.id);
  assert.equal(summary.missingArticles, 1, 'the missing row is reported');
  assert.equal(summary.generalAhead, false, 'the general master did not move');
  assert.equal(summary.pendingChanges, true, 'an incomplete master is pending');

  const refused = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(refused.status, 409, 'an incomplete master must not be published');
  assert.deepEqual(await refused.json(), {
    error: `the sede master has ${general.articles.length - 1} of ${general.articles.length} articles; sync it from the general master (Artículos → Sincronizar, or publish with sync) first`,
    articles: general.articles.length - 1,
    generalArticles: general.articles.length,
  });
  assert.equal(
    db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n,
    0,
    'a refused publish must not create a deployment row',
  );

  const synced = await api(`/api/sedes/${sede.id}/articles/sync`, {
    method: 'POST',
    body: { expectedOverrides: 0 },
  });
  assert.equal(synced.status, 200);
  assert.equal((await getSedeSummary(sede.id)).missingArticles, 0, 'the sync closes the gap');

  const published = await api(`/api/sedes/${sede.id}/deployments`, { method: 'POST', body: {} });
  assert.equal(published.status, 201, 'the repaired master publishes normally');
  assert.equal((await published.json()).articleCount, general.articles.length);

  await syncAllSedes();
});

test('the .Txp export scoped to a sede carries the sede suffix and its own price', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);
  const sedePrice = article.priceCents + 321;

  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: sedePrice },
  });
  assert.equal(override.status, 200);

  const res = await api(`/api/articles/export?format=txp&sedeId=${sede.id}`);
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get('content-disposition'),
    /maestro-balanza-\d{8}-sede-master-\d+-\d+\.txp/,
    'the attachment name must carry the sede suffix',
  );

  const rows = parseTxpText(await res.text());
  const exported = rows.find((row) => row.barcode === article.barcode);
  assert.ok(exported, 'the sede export must contain the article');
  assert.equal(exported.priceCents, sedePrice, 'the export must use the sede price');
  assert.notEqual(exported.priceCents, article.priceCents, 'the general price must not win');

  await syncAllSedes();
});

test('GET /api/catalog?sedeId returns the sede hash and article count', async () => {
  const sede = await createSede();
  const general = await (await api('/api/catalog')).json();

  const fresh = await (await api(`/api/catalog?sedeId=${sede.id}`)).json();
  assert.equal(fresh.articleCount, general.articleCount, 'a new sede starts with the full catalogue');
  assert.equal(fresh.hash, general.hash, 'an untouched sede hashes like the general master');
  assert.match(fresh.hash, /^[0-9a-f]{64}$/);

  const article = general.articles[0];
  assert.ok(article);
  const override = await api(`/api/articles/${article.id}?sedeId=${sede.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 111 },
  });
  assert.equal(override.status, 200);

  const scoped = await (await api(`/api/catalog?sedeId=${sede.id}`)).json();
  assert.equal(scoped.articleCount, general.articleCount, 'the count does not change when only values do');
  assert.notEqual(scoped.hash, general.hash, 'the sede hash describes its own values');

  await syncAllSedes();
});

test('the scoped article read rejects an invalid or missing sede', async () => {
  const invalid = await api('/api/articles?sedeId=abc');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid sedeId');

  const missing = await api('/api/articles?sedeId=9999');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'sede not found');
});

test('importing articles into a sede is refused', async () => {
  const sede = await createSede();

  const res = await api(`/api/articles?sedeId=${sede.id}`, {
    method: 'PUT',
    body: { articles: [] },
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'articles are imported into the general master');
});

test('differsFromGeneral turns true after a general edit the sede has not received', async () => {
  const sede = await createSede();
  const general = await (await api('/api/articles')).json();
  const article = general.articles[0];
  assert.ok(article);

  const before = await getSedeMaster(sede.id);
  assert.equal(before.articles.find((item) => item.id === article.id).differsFromGeneral, false);

  await tick();
  const edited = await api(`/api/articles/${article.id}`, {
    method: 'PATCH',
    body: { priceCents: article.priceCents + 77 },
  });
  assert.equal(edited.status, 200);

  const after = await getSedeMaster(sede.id);
  assert.equal(
    after.articles.find((item) => item.id === article.id).differsFromGeneral,
    true,
    'the sede copy still holds the old values, so it differs from the general master',
  );
  assert.equal((await getSedeSummary(sede.id)).generalAhead, true);

  await syncAllSedes();
});

