/**
 * HTTP API for BalanzaWeb.
 *
 * Two authentication planes:
 *   - people: username + password -> session token -> permissions per section
 *   - agents: pairing code -> long-lived agent token -> only the agent endpoints
 *
 * Built on node:http with a tiny hand-rolled router: no runtime dependencies.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { now } from './db.js';
import { generatePairingCode, generateToken, hashToken } from './tokens.js';
import {
  assertPasswordPolicy,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from './auth.js';
import { PERMISSIONS, PERMISSION_KEYS } from './permissions.js';
import { WEIGHT_UNITS, toTxpText, validateRows } from '../../../packages/plu-format/src/index.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function isApiPath(pathname) {
  return (
    pathname === '/api' || pathname.startsWith('/api/') ||
    pathname === '/agent' || pathname.startsWith('/agent/')
  );
}

/** YYYYMMDD in the server's local timezone, used in the export filename. */
function localDateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function createApp({
  db,
  pairingTtlMinutes = 15,
  webDir = null,
  trustProxy = false,
  loginLimit = { max: 10, windowMs: 5 * 60_000 },
  logger = null,
  nowMs = () => Date.now(),
}) {
  const webRoot = webDir ? resolve(webDir) : null;
  const loginAttempts = new Map();

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const attachment = (res, text, filename) => {
    const body = Buffer.from(text, 'ascii');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=us-ascii',
      'content-length': body.length,
      'content-disposition': `attachment; filename="${filename}"`,
    });
    res.end(body);
  };

  const notModified = (res) => {
    res.writeHead(304);
    res.end();
  };

  const fail = (res, status, message, details) => json(res, status, { error: message, details });

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid JSON body'), { status: 400 });
    }
  }

  function bearer(req) {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1].trim() : null;
  }

  /** Client address for rate limiting and logs; never trust a proxy header unless asked. */
  function clientIp(req) {
    if (trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (raw) {
        const first = raw.split(',')[0].trim();
        if (first) return first;
      }
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  /** Drop expired entries so the failure map stays bounded without timers. */
  function pruneLoginAttempts(at) {
    for (const [key, entry] of loginAttempts) {
      if (entry.resetAt <= at) loginAttempts.delete(key);
    }
  }

  function loginRetryAfter(key, at) {
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= at) return null;
    if (entry.count < loginLimit.max) return null;
    return Math.max(1, Math.ceil((entry.resetAt - at) / 1000));
  }

  function recordLoginFailure(key, at) {
    const entry = loginAttempts.get(key);
    if (!entry || entry.resetAt <= at) {
      loginAttempts.set(key, { count: 1, resetAt: at + loginLimit.windowMs });
    } else {
      entry.count += 1;
    }
  }

  async function sendFile(req, res, filePath, cacheControl) {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': cacheControl,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  }

  async function serveIndex(req, res) {
    try {
      await sendFile(req, res, resolve(webRoot, 'index.html'), 'no-cache');
    } catch (err) {
      if (err.code === 'ENOENT') return fail(res, 500, 'web build is missing index.html');
      throw err;
    }
  }

  async function serveStatic(req, res, pathname) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return fail(res, 404, 'not found');
    }

    // Backslashes and null bytes never belong in a static URL and are the classic
    // Windows traversal vectors, so reject them outright.
    if (decoded.includes('\0') || decoded.includes('\\')) return fail(res, 404, 'not found');

    const candidate = resolve(webRoot, decoded.replace(/^\/+/, ''));
    const rootPrefix = webRoot.endsWith(sep) ? webRoot : `${webRoot}${sep}`;
    if (candidate !== webRoot && !candidate.startsWith(rootPrefix)) {
      return fail(res, 404, 'not found');
    }

    if (decoded === '/index.html' || !extname(candidate)) return serveIndex(req, res);

    let info;
    try {
      info = await stat(candidate);
    } catch {
      info = null;
    }
    if (!info || !info.isFile()) return fail(res, 404, 'not found');

    const immutable = decoded.startsWith('/assets/');
    return sendFile(req, res, candidate, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  }


  function hydrateUser(user) {
    const roles = db.all(
      `SELECT r.key, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.key`,
      user.id,
    );
    const permissions = db
      .all(
        `SELECT DISTINCT rp.permission FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = ? ORDER BY rp.permission`,
        user.id,
      )
      .map((row) => row.permission);
    return { id: user.id, username: user.username, name: user.name, roles, permissions };
  }

  function currentUser(req) {
    const token = bearer(req);
    if (!token) return null;
    const digest = hashSessionToken(token);
    const session = db.get('SELECT * FROM sessions WHERE token_hash = ?', digest);
    if (!session) return null;
    if (Date.parse(session.expires_at) < Date.now()) {
      db.run('DELETE FROM sessions WHERE token_hash = ?', digest);
      return null;
    }
    const user = db.get('SELECT * FROM users WHERE id = ? AND active = 1', session.user_id);
    return user ? hydrateUser(user) : null;
  }

  function requireAgent(req, res) {
    const token = bearer(req);
    if (!token) {
      fail(res, 401, 'agent token required');
      return null;
    }
    const agent = db.get('SELECT * FROM agents WHERE token_hash = ?', hashToken(token));
    if (!agent) {
      fail(res, 401, 'unknown agent token');
      return null;
    }
    if (agent.revoked_at) {
      fail(res, 403, 'agent token revoked');
      return null;
    }
    db.run('UPDATE agents SET last_seen_at = ? WHERE id = ?', now(), agent.id);
    return agent;
  }

  function catalogHash(articles) {
    const canonical = articles.map((a) => [
      a.barcode, a.name, a.lfCode, a.pluNumber ?? 0, a.priceCents, a.unitCode,
      a.department, a.validityDays, a.packageType, a.barcodeType,
    ]);
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  function activeArticles() {
    return db
      .all('SELECT * FROM articles WHERE active = 1 ORDER BY lf_code')
      .map((row) => ({
        id: row.id,
        barcode: row.barcode,
        name: row.name,
        lfCode: row.lf_code,
        pluNumber: row.plu_number,
        priceCents: row.price_cents,
        unitCode: row.unit_code,
        department: row.department,
        validityDays: row.validity_days,
        packageType: row.package_type,
        barcodeType: row.barcode_type,
      }));
  }

  function catalogState() {
    const articles = activeArticles();
    return { articles, hash: catalogHash(articles) };
  }

  /** How many sedes are behind the current catalogue (i.e. have unpublished changes). */
  function pendingSedeCount() {
    const { hash } = catalogState();
    const rows = db.all(
      `SELECT s.id,
              (SELECT d.catalog_hash FROM deployments d WHERE d.sede_id = s.id ORDER BY d.revision DESC LIMIT 1) AS last_hash
         FROM sedes s`,
    );
    return rows.filter((row) => row.last_hash !== hash).length;
  }

  /** Coerce an incoming article body into the shape the validator and builder expect. */
  function normalizeArticle(body, base = {}) {
    const pick = (key, fallback) => (body[key] === undefined ? (base[key] ?? fallback) : body[key]);
    return {
      barcode: Number(pick('barcode', NaN)),
      name: String(pick('name', '')).trim(),
      lfCode: Number(pick('lfCode', NaN)),
      pluNumber: Number(pick('pluNumber', 0)) || 0,
      priceCents: Number(pick('priceCents', NaN)),
      unitCode: Number(pick('unitCode', NaN)),
      department: Number(pick('department', NaN)),
      validityDays: Number(pick('validityDays', NaN)),
      packageType: Number(pick('packageType', 0)),
      barcodeType: Number(pick('barcodeType', 7)),
    };
  }

  /**
   * Validate a candidate catalogue before writing it. Duplicate barcodes / LF codes
   * are reported as 409 (the caller can fix the field), everything else as 422.
   */
  function rejectInvalidCandidate(res, candidate) {
    const report = validateRows(candidate.map((article, index) => ({ line: index + 1, ...article })));
    if (report.ok) return false;
    const onlyDuplicates = report.errors.every((error) => error.message.startsWith('duplicate'));
    fail(
      res,
      onlyDuplicates ? 409 : 422,
      onlyDuplicates ? 'barcode or LF code already in use' : 'catalog validation failed',
      report,
    );
    return true;
  }

  function insertArticle(article) {
    db.run(
      `INSERT INTO articles (barcode, name, lf_code, plu_number, price_cents, unit_code, department,
        validity_days, package_type, barcode_type, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      article.barcode, article.name, article.lfCode, article.pluNumber, article.priceCents,
      article.unitCode, article.department, article.validityDays, article.packageType,
      article.barcodeType, now(),
    );
    return db.get('SELECT * FROM articles WHERE barcode = ?', article.barcode);
  }

  function resolveRoles(keys) {
    if (!Array.isArray(keys) || keys.length === 0) throw Object.assign(new Error('at least one role is required'), { status: 422 });
    const roles = keys.map((key) => db.get('SELECT * FROM roles WHERE key = ?', key));
    if (roles.some((role) => !role)) throw Object.assign(new Error('unknown role'), { status: 422 });
    return roles;
  }

  /** Derive a stable, URL-safe role key from a display name. */
  function deriveRoleKey(name) {
    return name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function rolePermissions(role) {
    return db.all('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission', role.id)
      .map((row) => row.permission);
  }

  const routes = [
    // ---- authentication ----
    {
      method: 'POST',
      pattern: /^\/api\/auth\/login$/,
      handler: async (req, res) => {
        const body = await readJson(req);
        const username = String(body.username ?? '').trim().toLowerCase();
        const at = nowMs();
        pruneLoginAttempts(at);
        const limitKey = `${clientIp(req)}|${username}`;
        const retryAfter = loginRetryAfter(limitKey, at);
        if (retryAfter !== null) {
          res.setHeader('retry-after', String(retryAfter));
          return fail(res, 429, `too many failed login attempts; retry in ${retryAfter}s`);
        }

        if (!username || !body.password) return fail(res, 400, 'username and password are required');
        const user = db.get('SELECT * FROM users WHERE username = ?', username);
        if (!user || !user.active || !verifyPassword(body.password, user.password_hash)) {
          recordLoginFailure(limitKey, at);
          return fail(res, 401, 'invalid credentials');
        }
        loginAttempts.delete(limitKey);
        const token = createSessionToken();
        db.run(
          'INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
          hashSessionToken(token),
          user.id,
          sessionExpiry(),
          now(),
        );
        db.run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
        return json(res, 200, { token, user: hydrateUser(user) });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/auth\/logout$/,
      handler: async (req, res) => {
        const token = bearer(req);
        if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', hashSessionToken(token));
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/auth\/me$/,
      auth: true,
      handler: async (req, res, params, query, context) => json(res, 200, { user: context.user }),
    },

    {
      method: 'GET',
      pattern: /^\/api\/units$/,
      permission: 'articles.read',
      handler: async (req, res) =>
        json(res, 200, {
          units: WEIGHT_UNITS,
          packageTypes: [
            { value: 0, label: 'Normal' },
            { value: 2, label: 'Por unidad' },
          ],
        }),
    },
    // ---- articles ----
    {
      method: 'GET',
      pattern: /^\/api\/articles$/,
      permission: 'articles.read',
      handler: async (req, res) => json(res, 200, { articles: activeArticles() }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/articles\/export$/,
      permission: 'articles.read',
      handler: async (req, res) =>
        attachment(res, toTxpText(activeArticles()), `maestro-balanza-${localDateStamp()}.txp`),
    },
    {
      method: 'GET',
      pattern: /^\/api\/articles\/suggest$/,
      permission: 'articles.read',
      handler: async (req, res) => {
        const { articles } = catalogState();
        const maxBarcode = articles.reduce((max, a) => Math.max(max, a.barcode), 12904);
        const maxLf = articles.reduce((max, a) => Math.max(max, a.lfCode), 0);
        return json(res, 200, { barcode: maxBarcode + 1, lfCode: maxLf + 1, pluNumber: 0 });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/articles$/,
      permission: 'articles.write',
      handler: async (req, res) => {
        const body = await readJson(req);
        const { articles } = catalogState();
        const article = normalizeArticle(body);
        if (rejectInvalidCandidate(res, [...articles, article])) return;
        const row = insertArticle(article);
        return json(res, 201, { article: row, pendingSedes: pendingSedeCount() });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/articles\/(\d+)$/,
      permission: 'articles.write',
      handler: async (req, res, [articleId]) => {
        const existing = db.get('SELECT * FROM articles WHERE id = ?', Number(articleId));
        if (!existing) return fail(res, 404, 'article not found');
        const body = await readJson(req);

        const current = activeArticles().find((a) => a.id === existing.id);
        const updated = normalizeArticle(body, current);
        const candidate = activeArticles().map((a) => (a.id === existing.id ? updated : a));
        if (rejectInvalidCandidate(res, candidate)) return;

        db.run(
          `UPDATE articles SET barcode = ?, name = ?, lf_code = ?, plu_number = ?, price_cents = ?,
             unit_code = ?, department = ?, validity_days = ?, package_type = ?, barcode_type = ?, updated_at = ?
           WHERE id = ?`,
          updated.barcode, updated.name, updated.lfCode, updated.pluNumber, updated.priceCents,
          updated.unitCode, updated.department, updated.validityDays, updated.packageType,
          updated.barcodeType, now(), existing.id,
        );
        return json(res, 200, { article: db.get('SELECT * FROM articles WHERE id = ?', existing.id), pendingSedes: pendingSedeCount() });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/articles\/(\d+)$/,
      permission: 'articles.write',
      handler: async (req, res, [articleId]) => {
        const existing = db.get('SELECT * FROM articles WHERE id = ?', Number(articleId));
        if (!existing) return fail(res, 404, 'article not found');
        // Hard delete: previous catalogues remain available in deployments.catalog_json.
        db.run('DELETE FROM articles WHERE id = ?', existing.id);
        return json(res, 200, { deleted: existing.barcode, pendingSedes: pendingSedeCount() });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/articles$/,
      permission: 'articles.write',
      handler: async (req, res) => {
        const body = await readJson(req);
        const articles = Array.isArray(body.articles) ? body.articles : null;
        if (!articles) return fail(res, 400, 'articles array is required');

        const rows = articles.map((article, index) => ({
          line: index + 1,
          name: article.name,
          lfCode: article.lfCode,
          pluNumber: article.pluNumber ?? 0,
          barcode: article.barcode,
          barcodeType: article.barcodeType ?? 7,
          priceCents: article.priceCents,
          unitCode: article.unitCode,
          department: article.department,
          validityDays: article.validityDays,
          packageType: article.packageType ?? 0,
        }));

        const report = validateRows(rows);
        if (!report.ok) return json(res, 422, { error: 'catalog rejected', validation: report });

        db.exec('BEGIN');
        try {
          db.run('DELETE FROM articles');
          const insert = db.raw.prepare(
            `INSERT INTO articles (barcode, name, lf_code, plu_number, price_cents, unit_code, department,
              validity_days, package_type, barcode_type, active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          );
          for (const row of rows) {
            insert.run(row.barcode, row.name, row.lfCode, row.pluNumber, row.priceCents, row.unitCode,
              row.department, row.validityDays, row.packageType, row.barcodeType, now());
          }
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          return fail(res, 422, 'catalog insert failed', err.message);
        }
        return json(res, 200, { articles: articles.length, warnings: report.warnings });
      },
    },

    // ---- sedes ----
    {
      method: 'POST',
      pattern: /^\/api\/sedes$/,
      permission: 'sedes.write',
      handler: async (req, res) => {
        const body = await readJson(req);
        if (!body.name) return fail(res, 400, 'name is required');
        if (db.get('SELECT id FROM sedes WHERE name = ?', body.name)) return fail(res, 409, 'a sede with that name already exists');
        db.run(
          'INSERT INTO sedes (name, revision, poll_interval_seconds, created_at) VALUES (?, 1, ?, ?)',
          body.name,
          body.pollIntervalSeconds ?? 60,
          now(),
        );
        return json(res, 201, db.get('SELECT * FROM sedes WHERE name = ?', body.name));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/catalog$/,
      permission: 'articles.read',
      handler: async (req, res) => {
        const { articles, hash } = catalogState();
        return json(res, 200, { hash, articleCount: articles.length, articles });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/sedes$/,
      permission: 'sedes.read',
      handler: async (req, res) => {
        const { hash } = catalogState();
        const sedes = db.all('SELECT * FROM sedes ORDER BY name').map((sede) => {
          const last = db.get(
            'SELECT catalog_hash FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1',
            sede.id,
          );
          return { ...sede, pendingChanges: !last || last.catalog_hash !== hash };
        });
        return json(res, 200, { sedes });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/sedes\/(\d+)\/scales$/,
      permission: 'scales.write',
      handler: async (req, res, [sedeId]) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', Number(sedeId));
        if (!sede) return fail(res, 404, 'sede not found');
        const body = await readJson(req);
        if (!body.name || !body.host) return fail(res, 400, 'name and host are required');
        try {
          db.run(
            'INSERT INTO scales (sede_id, name, host, port, enabled) VALUES (?, ?, ?, ?, ?)',
            sede.id, body.name, body.host, body.port ?? 5001, body.enabled === false ? 0 : 1,
          );
        } catch (err) {
          return fail(res, 409, 'that scale name already exists in this sede', err.message);
        }
        return json(res, 201, db.get('SELECT * FROM scales WHERE sede_id = ? AND name = ?', sede.id, body.name));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/sedes\/(\d+)\/scales$/,
      permission: 'scales.read',
      handler: async (req, res, [sedeId]) =>
        json(res, 200, { scales: db.all('SELECT * FROM scales WHERE sede_id = ? ORDER BY name', Number(sedeId)) }),
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/sedes\/(\d+)\/scales\/(\d+)$/,
      permission: 'scales.write',
      handler: async (req, res, [sedeId, scaleId]) => {
        const scale = db.get(
          'SELECT * FROM scales WHERE id = ? AND sede_id = ?',
          Number(scaleId), Number(sedeId),
        );
        if (!scale) return fail(res, 404, 'scale not found');

        db.exec('BEGIN');
        try {
          db.run('DELETE FROM deployment_results WHERE scale_id = ?', scale.id);
          db.run('DELETE FROM scales WHERE id = ?', scale.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          return fail(res, 500, 'could not delete the scale', err.message);
        }
        return json(res, 200, { ok: true, scaleId: scale.id });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/sedes\/(\d+)$/,
      permission: 'sedes.write',
      handler: async (req, res, [sedeId]) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', Number(sedeId));
        if (!sede) return fail(res, 404, 'sede not found');

        const deleted = {
          scales: db.get('SELECT COUNT(*) AS n FROM scales WHERE sede_id = ?', sede.id).n,
          agents: db.get('SELECT COUNT(*) AS n FROM agents WHERE sede_id = ?', sede.id).n,
          deployments: db.get('SELECT COUNT(*) AS n FROM deployments WHERE sede_id = ?', sede.id).n,
          results: db.get('SELECT COUNT(*) AS n FROM deployment_results WHERE sede_id = ?', sede.id).n,
        };

        db.exec('BEGIN');
        try {
          // deployment_results has no foreign key, so it is cleaned up by hand.
          db.run('DELETE FROM deployment_results WHERE sede_id = ?', sede.id);
          db.run('DELETE FROM sedes WHERE id = ?', sede.id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          return fail(res, 500, 'could not delete the sede', err.message);
        }
        return json(res, 200, { ok: true, sedeId: sede.id, deleted });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/sedes\/(\d+)\/pairing-code$/,
      permission: 'agents.manage',
      handler: async (req, res, [sedeId]) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', Number(sedeId));
        if (!sede) return fail(res, 404, 'sede not found');
        const code = generatePairingCode();
        const expiresAt = new Date(Date.now() + pairingTtlMinutes * 60_000).toISOString();
        db.run('INSERT INTO pairing_codes (code, sede_id, expires_at, created_at) VALUES (?, ?, ?, ?)', code, sede.id, expiresAt, now());
        return json(res, 201, { code, expiresAt, sede: { id: sede.id, name: sede.name } });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/agents\/(\d+)\/revoke$/,
      permission: 'agents.manage',
      handler: async (req, res, [agentId]) => {
        const agent = db.get('SELECT * FROM agents WHERE id = ?', Number(agentId));
        if (!agent) return fail(res, 404, 'agent not found');
        const revokedAt = agent.revoked_at ?? now();
        if (!agent.revoked_at) {
          db.run('UPDATE agents SET revoked_at = ? WHERE id = ?', revokedAt, agent.id);
        }
        return json(res, 200, {
          id: agent.id,
          machine_id: agent.machine_id,
          sede_id: agent.sede_id,
          revoked_at: revokedAt,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/sedes\/(\d+)\/deployments$/,
      permission: 'deployments.create',
      handler: async (req, res, [sedeId]) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', Number(sedeId));
        if (!sede) return fail(res, 404, 'sede not found');
        const body = await readJson(req);
        const articles = activeArticles();
        if (articles.length === 0) return fail(res, 409, 'the catalog is empty; upload articles first');

        const revision = sede.revision + 1;
        const hash = catalogHash(articles);
        db.run('UPDATE sedes SET revision = ? WHERE id = ?', revision, sede.id);
        db.run(
          `INSERT INTO deployments (sede_id, revision, scale_ids, article_count, catalog_hash, catalog_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          sede.id, revision, body.scaleIds ? JSON.stringify(body.scaleIds) : null,
          articles.length, hash, JSON.stringify(articles), now(),
        );
        const deployment = db.get('SELECT * FROM deployments WHERE sede_id = ? AND revision = ?', sede.id, revision);
        return json(res, 201, {
          deploymentId: deployment.id,
          revision,
          articleCount: articles.length,
          catalogHash: hash,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/sedes\/(\d+)\/status$/,
      permission: 'status.read',
      handler: async (req, res, [sedeId]) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', Number(sedeId));
        if (!sede) return fail(res, 404, 'sede not found');
        return json(res, 200, {
          sede,
          scales: db.all('SELECT * FROM scales WHERE sede_id = ? ORDER BY name', sede.id),
          lastDeployment: db.get('SELECT id, revision, article_count, catalog_hash, created_at FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1', sede.id) ?? null,
          results: db.all('SELECT * FROM deployment_results WHERE sede_id = ? ORDER BY id DESC LIMIT 20', sede.id),
          agents: db.all('SELECT id, machine_id, last_seen_at, revoked_at, created_at FROM agents WHERE sede_id = ?', sede.id),
        });
      },
    },

    // ---- users, roles and permissions ----
    {
      method: 'GET',
      pattern: /^\/api\/users$/,
      permission: 'users.manage',
      handler: async (req, res) => {
        const users = db.all('SELECT id, username, name, active, last_login_at, created_at FROM users ORDER BY username');
        return json(res, 200, {
          users: users.map((user) => ({
            ...user,
            roles: db.all('SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', user.id).map((r) => r.key),
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/users$/,
      permission: 'users.manage',
      handler: async (req, res) => {
        const body = await readJson(req);
        const username = String(body.username ?? '').trim().toLowerCase();
        if (!username || !body.name) return fail(res, 400, 'username and name are required');
        if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
          return fail(res, 422, 'username must be 3-32 characters: letters, digits, dot, dash or underscore');
        }
        assertPasswordPolicy(body.password);
        if (db.get('SELECT id FROM users WHERE username = ?', username)) return fail(res, 409, 'that username is already registered');
        const roles = resolveRoles(body.roles ?? ['viewer']);

        db.run(
          'INSERT INTO users (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)',
          username, body.name, hashPassword(body.password), now(),
        );
        const user = db.get('SELECT * FROM users WHERE username = ?', username);
        for (const role of roles) db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', user.id, role.id);
        return json(res, 201, hydrateUser(user));
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/users\/(\d+)\/roles$/,
      permission: 'users.manage',
      handler: async (req, res, [userId]) => {
        const user = db.get('SELECT * FROM users WHERE id = ?', Number(userId));
        if (!user) return fail(res, 404, 'user not found');
        const body = await readJson(req);
        const roles = resolveRoles(body.roles);

        const wasAdmin = db.get(
          `SELECT 1 AS ok FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = ? AND r.key = 'admin'`,
          user.id,
        );
        const keepsAdmin = roles.some((role) => role.key === 'admin');
        if (wasAdmin && !keepsAdmin) {
          const admins = db.get(
            `SELECT COUNT(DISTINCT u.id) AS n FROM users u
               JOIN user_roles ur ON ur.user_id = u.id
               JOIN roles r ON r.id = ur.role_id
              WHERE r.key = 'admin'`,
          ).n;
          if (admins <= 1) return fail(res, 422, 'the last administrator cannot lose the admin role');
        }

        db.run('DELETE FROM user_roles WHERE user_id = ?', user.id);
        for (const role of roles) db.run('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', user.id, role.id);
        return json(res, 200, hydrateUser(user));
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/users\/(\d+)\/password$/,
      permission: 'users.manage',
      handler: async (req, res, [userId]) => {
        const user = db.get('SELECT * FROM users WHERE id = ?', Number(userId));
        if (!user) return fail(res, 404, 'user not found');
        const body = await readJson(req);
        assertPasswordPolicy(body.password);
        db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(body.password), user.id);
        db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
        return json(res, 200, { ok: true });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/users\/(\d+)$/,
      permission: 'users.manage',
      handler: async (req, res, [userId], query, context) => {
        const id = Number(userId);
        const user = db.get('SELECT * FROM users WHERE id = ?', id);
        if (!user) return fail(res, 404, 'user not found');

        const body = await readJson(req);
        const updates = {};

        if (body.name !== undefined) {
          if (typeof body.name !== 'string') return fail(res, 422, 'name must be a string');
          const name = body.name.trim();
          if (!name) return fail(res, 422, 'name must not be empty');
          updates.name = name;
        }
        if (body.username !== undefined) {
          if (typeof body.username !== 'string') return fail(res, 422, 'username must be a string');
          const username = body.username.trim().toLowerCase();
          if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
            return fail(res, 422, 'username must be 3-32 characters: letters, digits, dot, dash or underscore');
          }
          if (db.get('SELECT id FROM users WHERE username = ? AND id <> ?', username, id)) {
            return fail(res, 409, 'that username is already registered');
          }
          updates.username = username;
        }
        if (body.active !== undefined) {
          if (typeof body.active !== 'boolean') return fail(res, 422, 'active must be a boolean');
          if (!body.active && context.user.id === id) {
            return fail(res, 422, 'you cannot deactivate your own account');
          }
          updates.active = body.active ? 1 : 0;
        }

        const fields = Object.keys(updates);
        if (fields.length) {
          const assignments = fields.map((field) => `${field} = ?`).join(', ');
          db.run(
            `UPDATE users SET ${assignments} WHERE id = ?`,
            ...fields.map((field) => updates[field]),
            id,
          );
        }
        return json(res, 200, hydrateUser(db.get('SELECT * FROM users WHERE id = ?', id)));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/users\/(\d+)$/,
      permission: 'users.manage',
      handler: async (req, res, [userId], query, context) => {
        const id = Number(userId);
        const user = db.get('SELECT * FROM users WHERE id = ?', id);
        if (!user) return fail(res, 404, 'user not found');
        if (context.user.id === id) return fail(res, 422, 'you cannot delete your own account');

        const isAdmin = db.get(
          `SELECT 1 AS ok FROM user_roles ur JOIN roles r ON r.id = ur.role_id
            WHERE ur.user_id = ? AND r.key = 'admin'`,
          id,
        );
        if (isAdmin) {
          const admins = db.get(
            `SELECT COUNT(DISTINCT u.id) AS n FROM users u
               JOIN user_roles ur ON ur.user_id = u.id
               JOIN roles r ON r.id = ur.role_id
              WHERE r.key = 'admin'`,
          ).n;
          if (admins <= 1) return fail(res, 422, 'the last administrator cannot be deleted');
        }

        // sessions and user_roles cascade with the user.
        db.run('DELETE FROM users WHERE id = ?', id);
        return json(res, 200, { ok: true, userId: id });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/roles$/,
      permission: 'users.manage',
      handler: async (req, res) => {
        const roles = db.all('SELECT * FROM roles ORDER BY key').map((role) => ({
          key: role.key,
          name: role.name,
          permissions: rolePermissions(role),
        }));
        return json(res, 200, { roles, permissions: PERMISSIONS });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/roles$/,
      permission: 'users.manage',
      handler: async (req, res) => {
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return fail(res, 422, 'name is required');
        if (name.length > 60) return fail(res, 422, 'name must be 60 characters or fewer');

        const explicitKey = body.key === undefined || body.key === null || String(body.key).trim() === ''
          ? null
          : String(body.key).trim().toLowerCase();
        const key = explicitKey ?? deriveRoleKey(name);
        if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(key)) return fail(res, 422, 'invalid role key');

        const wanted = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
        const unknown = wanted.filter((permission) => !PERMISSION_KEYS.includes(permission));
        if (unknown.length) return fail(res, 422, `unknown permissions: ${unknown.join(', ')}`);
        if (db.get('SELECT id FROM roles WHERE key = ?', key)) return fail(res, 409, 'role already exists');

        db.run('INSERT INTO roles (key, name) VALUES (?, ?)', key, name);
        const role = db.get('SELECT * FROM roles WHERE key = ?', key);
        for (const permission of wanted) {
          db.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', role.id, permission);
        }
        return json(res, 201, { key: role.key, name: role.name, permissions: rolePermissions(role) });
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/roles\/([a-z0-9][a-z0-9_-]*)$/,
      permission: 'users.manage',
      handler: async (req, res, [roleKey]) => {
        const role = db.get('SELECT * FROM roles WHERE key = ?', roleKey);
        if (!role) return fail(res, 404, 'role not found');
        const body = await readJson(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return fail(res, 422, 'name is required');
        if (name.length > 60) return fail(res, 422, 'name must be 60 characters or fewer');

        db.run('UPDATE roles SET name = ? WHERE id = ?', name, role.id);
        return json(res, 200, { key: role.key, name, permissions: rolePermissions(role) });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/roles\/([a-z0-9][a-z0-9_-]*)$/,
      permission: 'users.manage',
      handler: async (req, res, [roleKey]) => {
        const role = db.get('SELECT * FROM roles WHERE key = ?', roleKey);
        if (!role) return fail(res, 404, 'role not found');
        if (role.key === 'admin') return fail(res, 422, 'the admin role cannot be deleted');

        const assigned = db.get('SELECT COUNT(*) AS n FROM user_roles WHERE role_id = ?', role.id).n;
        if (assigned > 0) return fail(res, 409, `role is assigned to ${assigned} user(s)`);

        db.run('DELETE FROM role_permissions WHERE role_id = ?', role.id);
        db.run('DELETE FROM user_roles WHERE role_id = ?', role.id);
        db.run('DELETE FROM roles WHERE id = ?', role.id);
        return json(res, 200, { ok: true, key: role.key });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/roles\/([a-z0-9][a-z0-9_-]*)\/permissions$/,
      permission: 'users.manage',
      handler: async (req, res, [roleKey]) => {
        const role = db.get('SELECT * FROM roles WHERE key = ?', roleKey);
        if (!role) return fail(res, 404, 'role not found');
        const body = await readJson(req);
        const wanted = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
        const unknown = wanted.filter((p) => !PERMISSION_KEYS.includes(p));
        if (unknown.length) return fail(res, 422, `unknown permissions: ${unknown.join(', ')}`);
        if (role.key === 'admin' && !wanted.includes('users.manage')) {
          return fail(res, 422, 'the admin role must keep users.manage');
        }

        db.run('DELETE FROM role_permissions WHERE role_id = ?', role.id);
        for (const permission of wanted) db.run('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)', role.id, permission);
        return json(res, 200, {
          key: role.key,
          permissions: rolePermissions(role),
        });
      },
    },

    // ---- agent protocol ----
    {
      method: 'POST',
      pattern: /^\/agent\/enroll$/,
      handler: async (req, res) => {
        const body = await readJson(req);
        if (!body.code) return fail(res, 400, 'pairing code is required');
        const pairing = db.get('SELECT * FROM pairing_codes WHERE code = ?', String(body.code).toUpperCase());
        if (!pairing) return fail(res, 404, 'unknown pairing code');
        if (pairing.used_at) return fail(res, 409, 'pairing code already used');
        if (Date.parse(pairing.expires_at) < Date.now()) return fail(res, 410, 'pairing code expired');

        const sede = db.get('SELECT * FROM sedes WHERE id = ?', pairing.sede_id);
        if (!sede) return fail(res, 404, 'sede not found');

        const token = generateToken();
        db.run('INSERT INTO agents (sede_id, token_hash, machine_id, created_at) VALUES (?, ?, ?, ?)',
          sede.id, hashToken(token), body.machineId ?? null, now());
        db.run('UPDATE pairing_codes SET used_at = ? WHERE code = ?', now(), pairing.code);
        const agent = db.get('SELECT * FROM agents WHERE token_hash = ?', hashToken(token));

        return json(res, 201, {
          agentId: agent.id,
          token,
          sede: { id: sede.id, name: sede.name, revision: sede.revision, pollIntervalSeconds: sede.poll_interval_seconds },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/agent\/sync$/,
      agent: true,
      handler: async (req, res, params, query, context) => {
        const sede = db.get('SELECT * FROM sedes WHERE id = ?', context.agent.sede_id);
        if (!sede) return fail(res, 404, 'sede not found');

        const clientRevision = Number(query.get('revision') ?? 0);
        const deployment = db.get('SELECT * FROM deployments WHERE sede_id = ? ORDER BY revision DESC LIMIT 1', sede.id);

        if (!deployment) {
          return json(res, 200, { revision: 0, catalog: { hash: null, articles: [] }, scales: [], pollIntervalSeconds: sede.poll_interval_seconds });
        }
        if (Number.isFinite(clientRevision) && clientRevision >= deployment.revision) return notModified(res);

        const scales = db
          .all('SELECT * FROM scales WHERE sede_id = ? AND enabled = 1 ORDER BY name', sede.id)
          .map((scale) => ({ id: scale.id, name: scale.name, host: scale.host, port: scale.port }));

        return json(res, 200, {
          sede: { id: sede.id, name: sede.name, revision: deployment.revision, pollIntervalSeconds: sede.poll_interval_seconds },
          revision: deployment.revision,
          deploymentId: deployment.id,
          catalog: { hash: deployment.catalog_hash, articles: JSON.parse(deployment.catalog_json) },
          targetScaleIds: deployment.scale_ids ? JSON.parse(deployment.scale_ids) : null,
          scales,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/agent\/report$/,
      agent: true,
      handler: async (req, res, params, query, context) => {
        const body = await readJson(req);
        if (!body.scaleId) return fail(res, 400, 'scaleId is required');
        const scale = db.get('SELECT * FROM scales WHERE id = ? AND sede_id = ?', body.scaleId, context.agent.sede_id);
        if (!scale) return fail(res, 404, 'scale not found in this sede');

        db.run(
          `INSERT INTO deployment_results
             (deployment_id, sede_id, scale_id, revision, ok, records, frames, duration_ms, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          body.deploymentId ?? null, context.agent.sede_id, scale.id, body.revision ?? 0,
          body.ok ? 1 : 0, body.records ?? null, body.frames ?? null, body.durationMs ?? null,
          body.error ?? null, now(),
        );
        db.run('UPDATE scales SET last_seen_at = ?, last_result = ? WHERE id = ?',
          now(), body.ok ? 'ok' : `error: ${body.error ?? 'unknown'}`, scale.id);
        return json(res, 201, { recorded: true });
      },
    },
  ];

  return async function handle(req, res) {
    const startedAt = Date.now();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return fail(res, 400, 'invalid request URL');
    }
    const pathname = url.pathname;

    if (logger) {
      res.on('finish', () => {
        if (pathname === '/healthz') return;
        try {
          logger.info(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms ${clientIp(req)}`);
        } catch {
          // logging must never break a response
        }
      });
    }

    try {
      if (pathname === '/healthz' && req.method === 'GET') {
        return json(res, 200, { ok: true, uptimeSeconds: Math.floor(process.uptime()) });
      }

      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(pathname);
        if (!match) continue;

        const context = {};
        try {
          if (route.permission || route.auth) {
            const user = currentUser(req);
            if (!user) return fail(res, 401, 'authentication required');
            if (route.permission && !user.permissions.includes(route.permission)) {
              return fail(res, 403, `missing permission ${route.permission}`);
            }
            context.user = user;
          }
          if (route.agent) {
            const agent = requireAgent(req, res);
            if (!agent) return;
            context.agent = agent;
          }
          await route.handler(req, res, match.slice(1), url.searchParams, context);
          return;
        } catch (err) {
          return fail(res, err.status ?? 500, err.message ?? 'internal error');
        }
      }

      const isRead = req.method === 'GET' || req.method === 'HEAD';
      if (webRoot && isRead && !isApiPath(pathname)) {
        return await serveStatic(req, res, pathname);
      }
      if (!webRoot && req.method === 'GET' && !isApiPath(pathname)) {
        return fail(res, 404, 'no web build configured');
      }
      return fail(res, 404, `no route for ${req.method} ${pathname}`);
    } catch (err) {
      return fail(res, err.status ?? 500, err.message ?? 'internal error');
    }
  };
}


