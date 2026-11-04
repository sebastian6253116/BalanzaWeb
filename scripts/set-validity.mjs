#!/usr/bin/env node
/**
 * Set every article's validity to the same number of days.
 *
 * The article master is production data, not code: this maintenance script reads
 * the catalogue from the API, rewrites only `validityDays` and sends the whole
 * catalogue back with PUT /api/articles. Every other field is preserved
 * untouched, including prices and the articles that intentionally cost 0.
 *
 * Usage:
 *   $env:BALANZA_PASSWORD = "..."
 *   node scripts/set-validity.mjs --api <url> --user <user> [--days 365] [--dry-run] [--timeout 30000]
 *
 * The password comes from BALANZA_PASSWORD or, for compatibility, from
 * `--password` (visible in the process list and the shell history).
 *
 * Requires a user with the `articles.read` permission (GET) and the
 * `articles.write` permission (PUT).
 */
import { pathToFileURL } from 'node:url';

const DEFAULT_DAYS = 365;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Build the PUT /api/articles body. Only `validityDays` changes; every other
 * field is copied as-is so prices and zero-priced articles survive untouched.
 */
export function buildCatalogPayload(articles, days) {
  return articles.map((article) => ({
    name: article.name,
    lfCode: article.lfCode,
    pluNumber: article.pluNumber ?? 0,
    barcode: article.barcode,
    barcodeType: article.barcodeType ?? 7,
    priceCents: article.priceCents,
    unitCode: article.unitCode,
    department: article.department,
    validityDays: days,
    packageType: article.packageType ?? 0,
  }));
}

/**
 * Stable snapshot of the catalogue identity: barcode plus price. Used to detect
 * concurrent edits between reading and replacing the whole catalogue.
 */
export function catalogueSignature(articles) {
  return JSON.stringify(
    articles
      .map((article) => [article.barcode, article.priceCents])
      .sort((a, b) => a[0] - b[0]),
  );
}

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const has = (name) => args.includes(`--${name}`);

async function request(url, { method = 'GET', token, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

function apiError(result, fallback) {
  if (result.body && typeof result.body === 'object' && result.body.error) return result.body.error;
  return fallback;
}

function parseDays(raw) {
  const days = Number(raw);
  if (!Number.isInteger(days) || days <= 0) throw new Error(`invalid --days: ${raw}`);
  return days;
}

function parseTimeout(raw) {
  const timeoutMs = Number(raw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout: ${raw}`);
  return timeoutMs;
}

async function main() {
  const api = flag('api');
  const user = flag('user');
  const password = flag('password') ?? process.env.BALANZA_PASSWORD;
  const days = parseDays(flag('days', String(DEFAULT_DAYS)));
  const timeoutMs = parseTimeout(flag('timeout', String(DEFAULT_TIMEOUT_MS)));
  const dryRun = has('dry-run');

  if (!api || api === true) throw new Error('missing --api <url>');
  if (!user || user === true) throw new Error('missing --user <user>');
  if (!password || password === true) throw new Error('missing password: pass --password <password> or set BALANZA_PASSWORD');

  const baseUrl = api.replace(/\/$/, '');

  const login = await request(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    timeoutMs,
    body: { username: user, password },
  });
  if (!login.ok) throw new Error(apiError(login, `login failed: HTTP ${login.status}`));
  const token = login.body?.token;
  if (!token) throw new Error('login did not return a token');

  const catalog = await request(`${baseUrl}/api/articles`, { token, timeoutMs });
  if (!catalog.ok) throw new Error(apiError(catalog, `reading articles failed: HTTP ${catalog.status}`));
  const articles = catalog.body?.articles;
  if (!Array.isArray(articles)) throw new Error('the API did not return an articles array');

  const changed = articles.filter((article) => article.validityDays !== days);
  const already = articles.length - changed.length;
  const summary = (label, value) => console.log(`${label.padEnd(19)}${value}`);

  summary('articles read:', articles.length);
  summary(`already at ${days}:`, already);

  if (dryRun) {
    summary('would change:', changed.length);
    for (const article of changed.slice(0, 5)) {
      console.log(`  ${article.name} (barcode ${article.barcode}): ${article.validityDays} -> ${days}`);
    }
    console.log(`dry run: nothing sent (GET /api/articles returned HTTP ${catalog.status})`);
    return;
  }

  // Sending the catalogue back with no difference would rewrite updated_at for
  // nothing and could leave the sedes looking pending.
  if (changed.length === 0) {
    console.log(`nothing to do: every article already has ${days} days`);
    return;
  }

  // PUT replaces the whole catalogue: abort if someone edited it while this
  // script was running instead of overwriting their work.
  const snapshot = catalogueSignature(articles);
  const beforePut = await request(`${baseUrl}/api/articles`, { token, timeoutMs });
  if (!beforePut.ok) throw new Error(apiError(beforePut, `re-reading articles failed: HTTP ${beforePut.status}`));
  const currentArticles = beforePut.body?.articles;
  if (!Array.isArray(currentArticles)) throw new Error('the API did not return an articles array');
  if (catalogueSignature(currentArticles) !== snapshot) {
    throw new Error('the catalogue changed while this script was running; nothing was sent — run it again');
  }

  const payload = buildCatalogPayload(articles, days);
  const update = await request(`${baseUrl}/api/articles`, {
    method: 'PUT',
    token,
    timeoutMs,
    body: { articles: payload },
  });
  if (!update.ok) throw new Error(apiError(update, `updating articles failed: HTTP ${update.status}`));
  if (typeof update.body?.articles === 'number' && update.body.articles !== payload.length) {
    throw new Error(`the API reported ${update.body.articles} articles after the update but ${payload.length} were sent`);
  }

  summary('articles changed:', changed.length);
  summary('HTTP status:', update.status);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
