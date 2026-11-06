#!/usr/bin/env node
/**
 * Set every article's validity to the same number of days.
 *
 * The article master is production data, not code: this maintenance script reads
 * the catalogue from the API and PATCHes only the articles whose `validityDays`
 * differs. Every other field (prices, names, per-sede masters, zero-priced
 * articles) is left untouched because the request never sends it.
 *
 * Usage:
 *   $env:BALANZA_PASSWORD = "..."
 *   node scripts/set-validity.mjs --api <url> --user <user> [--days 365] [--dry-run] [--timeout 30000]
 *
 * The password comes from BALANZA_PASSWORD or, for compatibility, from
 * `--password` (visible in the process list and the shell history).
 *
 * Requires a user with the `articles.read` permission (GET) and the
 * `articles.write` permission (PATCH).
 */
import { pathToFileURL } from 'node:url';

const DEFAULT_DAYS = 365;
const DEFAULT_TIMEOUT_MS = 30000;
const PROGRESS_EVERY = 25;

/**
 * Articles whose validity differs from the target. Pure so the selection can be
 * tested without a server. Returns the original objects, never copies.
 */
export function articlesNeedingUpdate(articles, days) {
  return articles.filter((article) => article.validityDays !== days);
}

/**
 * Stable snapshot of every field the catalogue exposes to this script: name,
 * lfCode, pluNumber, barcode, barcodeType, priceCents, unitCode, department,
 * validityDays and packageType. Used to detect concurrent edits between reading
 * the catalogue and sending the PATCHes; a change in any of them aborts the run
 * instead of racing the operator.
 */
export function catalogueSignature(articles) {
  return JSON.stringify(
    articles
      .map((article) => ({
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
      }))
      .sort((a, b) => a.barcode - b.barcode),
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

  const changed = articlesNeedingUpdate(articles, days);
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

  if (changed.length === 0) {
    console.log(`nothing to do: every article already has ${days} days`);
    return;
  }

  // PATCH targets individual rows, but a concurrent catalogue edit would still
  // race this run. Re-read once and abort before the first write if anything
  // changed since the initial read.
  const snapshot = catalogueSignature(articles);
  const beforeWrite = await request(`${baseUrl}/api/articles`, { token, timeoutMs });
  if (!beforeWrite.ok) throw new Error(apiError(beforeWrite, `re-reading articles failed: HTTP ${beforeWrite.status}`));
  const currentArticles = beforeWrite.body?.articles;
  if (!Array.isArray(currentArticles)) throw new Error('the API did not return an articles array');
  if (catalogueSignature(currentArticles) !== snapshot) {
    throw new Error('the catalogue changed while this script was running; nothing was sent — run it again');
  }

  let lastStatus = null;
  for (let index = 0; index < changed.length; index += 1) {
    const article = changed[index];
    if (article.id === undefined || article.id === null) {
      throw new Error(`article ${article.barcode} has no id; cannot PATCH it`);
    }
    const update = await request(`${baseUrl}/api/articles/${article.id}`, {
      method: 'PATCH',
      token,
      timeoutMs,
      body: { validityDays: days },
    });
    if (!update.ok) {
      throw new Error(
        `${apiError(update, `updating article ${article.barcode} failed: HTTP ${update.status}`)} `
          + `(stopped after ${index} of ${changed.length} articles). `
          + 'The catalogue may be partially updated: do not publish before re-running this script, '
          + 'or the mix of old and new validity days would be pushed to the scales.',
      );
    }
    lastStatus = update.status;

    const done = index + 1;
    if (done % PROGRESS_EVERY === 0 || done === changed.length) {
      console.log(`  updated ${done}/${changed.length}`);
    }
  }

  summary('articles changed:', changed.length);
  summary('HTTP status:', lastStatus);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}
