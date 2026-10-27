#!/usr/bin/env node
/**
 * API bootstrap.
 *
 * Environment:
 *   PORT                     listen port (default 8080)
 *   DB_PATH                  SQLite file (default ./data/balanzaweb.db)
 *   WEB_DIR                  built web directory (default apps/web/dist when it exists)
 *   TRUST_PROXY              set to 1 when behind a reverse proxy (honours X-Forwarded-For)
 *   LOG_REQUESTS             set to 0 to disable one-line request logging
 *   BOOTSTRAP_ADMIN_USERNAME required only on the first run (no users yet)
 *   BOOTSTRAP_ADMIN_PASSWORD required only on the first run
 *   BOOTSTRAP_ADMIN_NAME     optional display name for the first account
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { ensureFirstUser, userCount } from './bootstrap.js';
import { createApp } from './app.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? './data/balanzaweb.db';
const defaultWebDir = resolve(repoRoot, 'apps/web/dist');
const webDir = process.env.WEB_DIR
  ? resolve(process.env.WEB_DIR)
  : existsSync(defaultWebDir) ? defaultWebDir : null;
const trustProxy = process.env.TRUST_PROXY === '1';
const logger = process.env.LOG_REQUESTS === '0' ? null : { info: (line) => console.log(line) };

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);

const created = ensureFirstUser(db, {
  username: process.env.BOOTSTRAP_ADMIN_USERNAME,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  name: process.env.BOOTSTRAP_ADMIN_NAME,
});
if (created) console.log(`bootstrap: first user created (${created.username}, role ${created.role})`);
else console.log(`bootstrap: ${userCount(db)} user(s) already registered`);

const handle = createApp({ db, webDir, trustProxy, logger });
const server = createServer(handle);

server.listen(port, () => {
  console.log(
    `balanza api listening on :${port} (db: ${dbPath}, web: ${webDir ?? 'disabled'})`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}

