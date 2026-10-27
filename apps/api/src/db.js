/**
 * Database access.
 *
 * Development and tests use the SQLite engine built into Node 22 (`node:sqlite`),
 * which keeps the slice dependency-free. The schema in `schema.sql` is written for
 * portability; moving to MySQL on the VPS means implementing the same four methods
 * (`run`, `get`, `all`, `exec`) over `mysql2` and swapping this module.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedRoles } from './permissions.js';

const here = dirname(fileURLToPath(import.meta.url));

export function openDatabase(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  const handle = {
    raw: db,
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    close: () => db.close(),
  };

  seedRoles(handle);
  return handle;
}

export const now = () => new Date().toISOString();
