import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { openDatabase } from '../src/db.js';
import { createApp } from '../src/app.js';
import { ensureFirstUser } from '../src/bootstrap.js';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin12345';

let server;
let base;
let db;
let adminToken;

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

const json = (res) => res.json();

async function createUser(username, roles = ['viewer'], password = 'password12345') {
  const res = await api('/api/users', {
    method: 'POST',
    body: { username, name: username, password, roles },
  });
  assert.equal(res.status, 201);
  return json(res);
}

test('delete sede removes its scales, deployments and deployment results', async () => {
  const sede = await json(await api('/api/sedes', { method: 'POST', body: { name: 'Sede Borrar' } }));
  const scale = await json(
    await api(`/api/sedes/${sede.id}/scales`, {
      method: 'POST',
      body: { name: 'Caja 1', host: '10.0.0.10' },
    }),
  );
  const deployment = db.run(
    `INSERT INTO deployments (sede_id, revision, scale_ids, article_count, catalog_hash, catalog_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sede.id, 1, null, 0, 'hash', '[]', new Date().toISOString(),
  );
  db.run(
    `INSERT INTO deployment_results
       (deployment_id, sede_id, scale_id, revision, ok, records, frames, duration_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    deployment.lastInsertRowid, sede.id, scale.id, 1, 1, 0, 0, 10, null, new Date().toISOString(),
  );

  const res = await api(`/api/sedes/${sede.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    sedeId: sede.id,
    deleted: { scales: 1, agents: 0, deployments: 1, results: 1 },
  });

  assert.equal(db.get('SELECT id FROM sedes WHERE id = ?', sede.id), undefined);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scales WHERE sede_id = ?', sede.id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM deployment_results WHERE sede_id = ?', sede.id).n, 0);
});

test('delete scale removes only that scale and rejects a scale from another sede', async () => {
  const sedeA = await json(await api('/api/sedes', { method: 'POST', body: { name: 'Sede Balanza A' } }));
  const sedeB = await json(await api('/api/sedes', { method: 'POST', body: { name: 'Sede Balanza B' } }));
  const scaleA = await json(
    await api(`/api/sedes/${sedeA.id}/scales`, { method: 'POST', body: { name: 'Caja A', host: '10.0.0.11' } }),
  );
  const scaleB = await json(
    await api(`/api/sedes/${sedeB.id}/scales`, { method: 'POST', body: { name: 'Caja B', host: '10.0.0.12' } }),
  );
  db.run(
    `INSERT INTO deployment_results
       (deployment_id, sede_id, scale_id, revision, ok, records, frames, duration_ms, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    null, sedeA.id, scaleA.id, 1, 1, null, null, null, null, new Date().toISOString(),
  );

  const res = await api(`/api/sedes/${sedeA.id}/scales/${scaleA.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, scaleId: scaleA.id });
  assert.equal(db.get('SELECT id FROM scales WHERE id = ?', scaleA.id), undefined);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM deployment_results WHERE scale_id = ?', scaleA.id).n, 0);
  assert.ok(db.get('SELECT id FROM scales WHERE id = ?', scaleB.id));

  const wrongSede = await api(`/api/sedes/${sedeA.id}/scales/${scaleB.id}`, { method: 'DELETE' });
  assert.equal(wrongSede.status, 404);
  assert.ok(db.get('SELECT id FROM scales WHERE id = ?', scaleB.id));
});

test('PATCH user updates name and username', async () => {
  const user = await createUser('patch.me', ['viewer'], 'patchPassword123');
  const res = await api(`/api/users/${user.id}`, {
    method: 'PATCH',
    body: { name: 'Patched Name', username: 'Patch.Renamed' },
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.name, 'Patched Name');
  assert.equal(body.username, 'patch.renamed');

  const row = db.get('SELECT * FROM users WHERE id = ?', user.id);
  assert.equal(row.name, 'Patched Name');
  assert.equal(row.username, 'patch.renamed');
  assert.ok(await login('patch.renamed', 'patchPassword123'));
});

test('PATCH user rejects a duplicate username', async () => {
  await createUser('first.taken');
  const second = await createUser('second.user');

  const res = await api(`/api/users/${second.id}`, { method: 'PATCH', body: { username: 'first.taken' } });
  assert.equal(res.status, 409);
  assert.equal(db.get('SELECT username FROM users WHERE id = ?', second.id).username, 'second.user');
});

test('PATCH user can deactivate an account and block login', async () => {
  const user = await createUser('inactive.me', ['viewer'], 'inactivePassword123');
  const res = await api(`/api/users/${user.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal(res.status, 200);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', user.id).active, 0);

  const denied = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'inactive.me', password: 'inactivePassword123' }),
  });
  assert.equal(denied.status, 401);
});

test('PATCH user cannot deactivate your own account', async () => {
  const me = await json(await api('/api/auth/me'));
  const res = await api(`/api/users/${me.user.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal(res.status, 422);
  assert.match((await json(res)).error, /deactivate your own account/);
  assert.equal(db.get('SELECT active FROM users WHERE id = ?', me.user.id).active, 1);
});

test('DELETE user removes the account and its role rows', async () => {
  const user = await createUser('delete.me');
  const res = await api(`/api/users/${user.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true, userId: user.id });
  assert.equal(db.get('SELECT id FROM users WHERE id = ?', user.id), undefined);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ?', user.id).n, 0);
});

test('DELETE user rejects deleting your own account', async () => {
  const me = await json(await api('/api/auth/me'));
  const res = await api(`/api/users/${me.user.id}`, { method: 'DELETE' });
  assert.equal(res.status, 422);
  assert.match((await json(res)).error, /delete your own account/);
  assert.ok(db.get('SELECT id FROM users WHERE id = ?', me.user.id));
});

test('DELETE user rejects deleting the last administrator', async () => {
  const roles = await json(await api('/api/roles'));
  const operator = roles.roles.find((role) => role.key === 'operator');
  const original = [...operator.permissions];
  const grant = await api('/api/roles/operator/permissions', {
    method: 'PUT',
    body: { permissions: [...new Set([...original, 'users.manage'])] },
  });
  assert.equal(grant.status, 200);

  try {
    await createUser('ops.manager', ['operator'], 'opsManager12345');
    const token = await login('ops.manager', 'opsManager12345');
    const me = await json(await api('/api/auth/me'));

    const res = await api(`/api/users/${me.user.id}`, { token, method: 'DELETE' });
    assert.equal(res.status, 422);
    assert.match((await json(res)).error, /last administrator/);
    assert.ok(db.get('SELECT id FROM users WHERE id = ?', me.user.id));
  } finally {
    await api('/api/roles/operator/permissions', { method: 'PUT', body: { permissions: original } });
  }
});

function roleKeys(userId) {
  return db
    .all(
      `SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key`,
      userId,
    )
    .map((row) => row.key);
}

test('PUT user roles rejects removing admin from the last administrator', async () => {
  const me = await json(await api('/api/auth/me'));
  assert.deepEqual(roleKeys(me.user.id), ['admin']);

  const res = await api(`/api/users/${me.user.id}/roles`, { method: 'PUT', body: { roles: ['operator'] } });
  assert.equal(res.status, 422);
  assert.match((await json(res)).error, /last administrator/);
  assert.deepEqual(roleKeys(me.user.id), ['admin']);
});

test('PUT user roles allows demoting an administrator when another one exists', async () => {
  const me = await json(await api('/api/auth/me'));
  await createUser('second.admin', ['admin'], 'secondAdmin12345');
  const secondToken = await login('second.admin', 'secondAdmin12345');

  const res = await api(`/api/users/${me.user.id}/roles`, {
    method: 'PUT',
    body: { roles: ['operator'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await json(res)).roles.map((role) => role.key), ['operator']);
  assert.deepEqual(roleKeys(me.user.id), ['operator']);

  const restore = await api(`/api/users/${me.user.id}/roles`, {
    token: secondToken,
    method: 'PUT',
    body: { roles: ['admin'] },
  });
  assert.equal(restore.status, 200);
  assert.deepEqual((await json(restore)).roles.map((role) => role.key), ['admin']);
});

test('PUT user roles promotes a normal user to admin', async () => {
  const user = await createUser('promote.me', ['viewer']);
  const res = await api(`/api/users/${user.id}/roles`, {
    method: 'PUT',
    body: { roles: ['viewer', 'admin'] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await json(res)).roles.map((role) => role.key), ['admin', 'viewer']);
  assert.deepEqual(roleKeys(user.id), ['admin', 'viewer']);
});

test('a viewer is forbidden from changing roles', async () => {
  const viewer = await createUser('viewer.roles', ['viewer'], 'viewerRolePassword123');
  const token = await login('viewer.roles', 'viewerRolePassword123');
  const me = await json(await api('/api/auth/me', { token }));

  const res = await api(`/api/users/${me.user.id}/roles`, {
    token,
    method: 'PUT',
    body: { roles: ['admin'] },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(roleKeys(me.user.id), ['viewer']);
});

test('a viewer is forbidden from the new write routes', async () => {
  await createUser('viewer.write', ['viewer'], 'viewerPassword123');
  const token = await login('viewer.write', 'viewerPassword123');
  const me = await json(await api('/api/auth/me'));

  const checks = [
    ['DELETE', '/api/sedes/1'],
    ['DELETE', '/api/sedes/1/scales/1'],
    ['DELETE', `/api/users/${me.user.id}`],
    ['PATCH', `/api/users/${me.user.id}`],
  ];

  for (const [method, path] of checks) {
    const res = await api(path, { token, method, body: method === 'PATCH' ? { name: 'x' } : undefined });
    assert.equal(res.status, 403, `${method} ${path} must be forbidden`);
  }
});
